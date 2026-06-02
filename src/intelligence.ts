/**
 * Memory intelligence: confidence scoring, dedup detection,
 * version history, merge, and conflict detection.
 *
 * Pure functions are exported for unit testing.
 * DB functions use the shared connection pool.
 */
import { db } from './db.js';
import { entities, memoryRelations, memoryVersions } from './schema.js';
import { eq, sql, desc } from 'drizzle-orm';

// ── Confidence scoring (pure function) ──────────────────────────────────────

export interface ConfidenceInput {
  accessCount: number;
  maxAccessCount: number;
  edgeCount: number;
  maxEdgeCount: number;
  versionCount: number;
  maxVersionCount: number;
  daysSinceAccess: number;
}

const CONFIDENCE_WEIGHTS = {
  accessCount: 0.3,
  edgeCount: 0.2,
  versionCount: 0.2,
  recency: 0.3,
} as const;

/**
 * Compute confidence score from normalized signals.
 * Returns a value in [0, 1].
 *
 * Formula:
 *   0.3 * norm(access_count) + 0.2 * norm(edge_count)
 *   + 0.2 * norm(version_count) + 0.3 * recency_factor
 */
export function computeConfidence(input: ConfidenceInput): number {
  const normAccess = input.maxAccessCount > 0
    ? input.accessCount / input.maxAccessCount
    : 0;
  const normEdges = input.maxEdgeCount > 0
    ? input.edgeCount / input.maxEdgeCount
    : 0;
  const normVersions = input.maxVersionCount > 0
    ? input.versionCount / input.maxVersionCount
    : 0;
  const recency = 1.0 / (1.0 + input.daysSinceAccess);

  const score =
    CONFIDENCE_WEIGHTS.accessCount * normAccess +
    CONFIDENCE_WEIGHTS.edgeCount * normEdges +
    CONFIDENCE_WEIGHTS.versionCount * normVersions +
    CONFIDENCE_WEIGHTS.recency * recency;

  return Math.max(0, Math.min(1, score));
}

// ── Dedup detection ─────────────────────────────────────────────────────────

export interface DedupCandidate {
  id: string;
  name: string;
  similarity: number;
}

/**
 * Find near-duplicate memories for a given name + observations.
 * Uses pg_trgm word_similarity on the concatenated text.
 * Returns candidates with similarity > 0.85, same type.
 */
export async function findDedupCandidates(
  entityId: string | null,
  name: string,
  observations: string,
  type: string,
): Promise<DedupCandidate[]> {
  const searchText = `${name} ${observations}`.slice(0, 500);

  const result = await db.execute(sql`
    SELECT
      e.id,
      e.name,
      word_similarity(
        ${searchText},
        COALESCE(e.name, '') || ' ' || COALESCE(e.observations, '')
      ) AS similarity
    FROM public.entities e
    WHERE e.type = ${type}
      AND (${entityId}::uuid IS NULL OR e.id != ${entityId}::uuid)
      AND word_similarity(
        ${searchText},
        COALESCE(e.name, '') || ' ' || COALESCE(e.observations, '')
      ) > 0.85
    ORDER BY similarity DESC
    LIMIT 5
  `);

  return result.rows as unknown as DedupCandidate[];
}

// ── Version history ─────────────────────────────────────────────────────────

/**
 * Snapshot the current state of a memory before an update.
 * Saves name, observations, tags, importance to memory_versions.
 */
export async function snapshotVersion(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.memory_versions (memory_id, name, observations, tags, importance)
    SELECT id, name, observations, tags, importance
    FROM public.entities
    WHERE id = ${id}
  `);
}

export interface VersionRecord {
  id: string;
  memoryId: string;
  name: string;
  observations: string;
  tags: string[];
  importance: number;
  changedAt: string;
}

/**
 * Get the version chain for a memory, ordered by changedAt descending.
 */
export async function getHistory(id: string): Promise<VersionRecord[]> {
  const result = await db.execute(sql`
    SELECT
      v.id,
      v.memory_id AS "memoryId",
      v.name,
      v.observations,
      v.tags,
      v.importance,
      v.changed_at AS "changedAt"
    FROM public.memory_versions v
    WHERE v.memory_id = ${id}
    ORDER BY v.changed_at DESC
  `);

  return result.rows as unknown as VersionRecord[];
}

// ── Merge ───────────────────────────────────────────────────────────────────

export interface MergeResult {
  targetId: string;
  mergedFields: string[];
  edgesTransferred: number;
  sourceDeleted: boolean;
}

/**
 * Merge source memory into target:
 * - Append source observations to target
 * - Union tags
 * - Keep higher importance
 * - Transfer all edges from source to target
 * - Delete source
 */
export async function mergeMemories(
  sourceId: string,
  targetId: string,
): Promise<MergeResult> {
  // Snapshot both before merge
  await snapshotVersion(sourceId);
  await snapshotVersion(targetId);

  // Fetch both memories
  const [source] = await db.select().from(entities).where(eq(entities.id, sourceId)).limit(1);
  const [target] = await db.select().from(entities).where(eq(entities.id, targetId)).limit(1);

  if (!source || !target) {
    throw new Error(`Memory not found: ${!source ? sourceId : targetId}`);
  }

  // Merge observations (append)
  const mergedObservations = [
    target.observations || '',
    `\n---\n[Merged from: ${source.name}]\n${source.observations || ''}`,
  ].join('');

  // Union tags
  const mergedTags = [...new Set([...(target.tags || []), ...(source.tags || [])])];

  // Keep higher importance
  const mergedImportance = Math.max(target.importance ?? 0.5, source.importance ?? 0.5);

  const mergedFields: string[] = [];
  if (source.observations) mergedFields.push('observations');
  if (source.tags && source.tags.length > 0) mergedFields.push('tags');
  if ((source.importance ?? 0.5) > (target.importance ?? 0.5)) mergedFields.push('importance');

  // Update target
  await db
    .update(entities)
    .set({
      observations: mergedObservations,
      tags: mergedTags,
      importance: mergedImportance,
    })
    .where(eq(entities.id, targetId));

  // Transfer edges from source to target (avoiding self-loops and duplicates)
  const transferResult = await db.execute(sql`
    WITH source_edges AS (
      SELECT id, from_id, to_id, relation_type, weight
      FROM public.memory_relations
      WHERE from_id = ${sourceId} OR to_id = ${sourceId}
    ),
    rewritten AS (
      SELECT
        CASE WHEN from_id = ${sourceId} THEN ${targetId}::uuid ELSE from_id END AS new_from,
        CASE WHEN to_id = ${sourceId} THEN ${targetId}::uuid ELSE to_id END AS new_to,
        relation_type,
        weight
      FROM source_edges
    ),
    filtered AS (
      SELECT new_from, new_to, relation_type, weight
      FROM rewritten
      WHERE new_from != new_to
        AND NOT EXISTS (
          SELECT 1 FROM public.memory_relations existing
          WHERE existing.from_id = rewritten.new_from
            AND existing.to_id = rewritten.new_to
            AND existing.relation_type = rewritten.relation_type
        )
    )
    INSERT INTO public.memory_relations (from_id, to_id, relation_type, weight)
    SELECT new_from, new_to, relation_type, weight FROM filtered
  `);

  const edgesTransferred = transferResult.rowCount ?? 0;

  // Delete source (cascades its remaining edges)
  await db.delete(entities).where(eq(entities.id, sourceId));

  return {
    targetId,
    mergedFields,
    edgesTransferred,
    sourceDeleted: true,
  };
}

// ── Conflicts ───────────────────────────────────────────────────────────────

export interface ConflictPair {
  edgeId: string;
  from: { id: string; name: string; observations: string };
  to: { id: string; name: string; observations: string };
}

/**
 * List all pairs of memories connected by a 'contradicts' edge.
 */
export async function getConflicts(): Promise<ConflictPair[]> {
  const result = await db.execute(sql`
    SELECT
      r.id AS "edgeId",
      r.from_id AS "fromId",
      f.name AS "fromName",
      COALESCE(f.observations, '') AS "fromObs",
      r.to_id AS "toId",
      t.name AS "toName",
      COALESCE(t.observations, '') AS "toObs"
    FROM public.memory_relations r
    JOIN public.entities f ON f.id = r.from_id
    JOIN public.entities t ON t.id = r.to_id
    WHERE r.relation_type = 'contradicts'
    ORDER BY r.created_at DESC
  `);

  return (result.rows as any[]).map((row) => ({
    edgeId: row.edgeId,
    from: { id: row.fromId, name: row.fromName, observations: row.fromObs },
    to: { id: row.toId, name: row.toName, observations: row.toObs },
  }));
}
