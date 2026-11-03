/**
 * Memory intelligence: confidence scoring, dedup detection,
 * version history, merge, and conflict detection.
 *
 * Pure functions are exported for unit testing.
 * DB functions use the shared connection pool.
 */
import { db } from './db.js';
import { CategorizedError } from './errors.js';
import { entities, memoryRelations, memoryVersions } from './schema.js';
import { eq, sql, desc } from 'drizzle-orm';
import { resolveEmbeddingForTextChange } from './embed.js';
import { isVolatile, withVolatileTag } from './claim-contract.js';

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
 *
 * This is `INSERT ... SELECT ... WHERE id = $1`, so a nonexistent id inserts
 * ZERO rows and does NOT throw. Callers that need to know whether history was
 * actually recorded must read the returned count — "it didn't throw" is not
 * the same as "a version exists". Verified against PG16 on 2026-08-31.
 *
 * @returns the number of version rows written (0 or 1).
 */
export async function snapshotVersion(id: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO public.memory_versions (memory_id, name, observations, tags, importance)
    SELECT id, name, observations, tags, importance
    FROM public.entities
    WHERE id = ${id}
  `);
  return result.rowCount ?? 0;
}

/**
 * Snapshot a memory, treating a failure as non-fatal but NEVER silent.
 *
 * A history write must not block a user's edit — that policy predates this
 * function and is deliberate. What this adds is visibility: the previous
 * inline `catch {}` in the `update` handler destroyed an edit's history with
 * no log line, no counter, and no way to detect it afterwards.
 *
 * `memory_versions` is the only audit trail this system has, and an audit
 * trail that fails open *and* silently is worse than none — it invites the
 * inference that zero version rows means a memory was never edited. That
 * inference produced a wrong conclusion on 2026-08-28.
 *
 * Logs to **stderr**, never stdout: stdout is the MCP JSON-RPC transport, and
 * writing to it corrupts the stream (see the dotenv-banner incident, 2026-08-18).
 *
 * @returns true only if a version row was actually written. A failure returns
 * false, and so does a snapshot of an id that no longer exists — which writes
 * nothing without throwing. Both mean the same thing to a caller: this edit's
 * prior state is not in `memory_versions`.
 */
export async function snapshotVersionSafe(id: string): Promise<boolean> {
  try {
    const written = await snapshotVersion(id);
    if (written === 0) {
      console.error(
        `[intelligence] snapshotVersion wrote no row for entity ${id} — the entity ` +
          `was not found, so this edit's prior state is NOT in memory_versions.`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[intelligence] snapshotVersion failed for entity ${id} — the update ` +
        `proceeds, but this edit's prior state was NOT recorded in memory_versions: ${err}`,
    );
    return false;
  }
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

  // Fetch both memories (explicit columns — excludes embedding, unused here)
  const mergeCols = {
    name: entities.name,
    observations: entities.observations,
    tags: entities.tags,
    importance: entities.importance,
  };
  const [source] = await db.select(mergeCols).from(entities).where(eq(entities.id, sourceId)).limit(1);
  const [target] = await db.select(mergeCols).from(entities).where(eq(entities.id, targetId)).limit(1);

  if (!source || !target) {
    throw new CategorizedError('validation', `Memory not found: ${!source ? sourceId : targetId}`);
  }

  // Merge observations (append)
  const mergedObservations = [
    target.observations || '',
    `\n---\n[Merged from: ${source.name}]\n${source.observations || ''}`,
  ].join('');

  // Union tags, then the claim contract: the date check reads the whole
  // body, so joining two bodies can gain or lose the flag — recompute it. No
  // reject: a merge must not fail on the combination of two accepted bodies.
  const unionTags = [...new Set([...(target.tags || []), ...(source.tags || [])])];
  const mergedTags = withVolatileTag(unionTags, isVolatile(mergedObservations));
  const tagsChanged =
    mergedTags.length !== (target.tags || []).length ||
    mergedTags.some((t) => !(target.tags || []).includes(t));

  // Keep higher importance
  const mergedImportance = Math.max(target.importance ?? 0.5, source.importance ?? 0.5);

  const mergedFields: string[] = [];
  if (source.observations) mergedFields.push('observations');
  if (tagsChanged) mergedFields.push('tags');
  if ((source.importance ?? 0.5) > (target.importance ?? 0.5)) mergedFields.push('importance');

  // The merge always appends source text onto target's observations, so the
  // target's embedding is now stale — same invalidate/recompute/preserve
  // policy as mcp-server.ts's `update` handler.
  const updateSet: Record<string, unknown> = {
    observations: mergedObservations,
    tags: mergedTags,
    importance: mergedImportance,
  };
  const mergedEmbedding = await resolveEmbeddingForTextChange(target.name, mergedObservations);
  if (mergedEmbedding !== undefined) {
    updateSet.embedding = mergedEmbedding;
    mergedFields.push('embedding');
  }

  // The three writes are ONE transaction (the error contract gate). Without it, a connection
  // drop after the target update left the merged text applied with the source
  // still present — and the contract now tells the caller a transient failure
  // is retryable, so the retry appended the source text a second time.
  const edgesTransferred = await db.transaction(async (tx) => {
    // Update target
    await tx
      .update(entities)
      .set(updateSet)
      .where(eq(entities.id, targetId));

    // Transfer edges from source to target (avoiding self-loops and duplicates)
    const transferResult = await tx.execute(sql`
      WITH source_edges AS (
        SELECT id, from_id, to_id, relation_type, weight, provenance
        FROM public.memory_relations
        WHERE from_id = ${sourceId} OR to_id = ${sourceId}
      ),
      rewritten AS (
        SELECT
          CASE WHEN from_id = ${sourceId} THEN ${targetId}::uuid ELSE from_id END AS new_from,
          CASE WHEN to_id = ${sourceId} THEN ${targetId}::uuid ELSE to_id END AS new_to,
          relation_type,
          weight,
          provenance
        FROM source_edges
      ),
      -- The duplicate filter below keeps the TARGET's row when both sides hold
      -- the same (from, to, type). If the source asserted it and the target
      -- only inferred it, keep the stronger claim — otherwise merge would
      -- silently downgrade an assertion to a guess. A data-modifying CTE runs
      -- whether or not it is referenced, and it touches only rows that already
      -- exist, so it is disjoint from the INSERT below.
      upgraded AS (
        UPDATE public.memory_relations existing
        SET provenance = 'asserted'
        FROM rewritten rw
        WHERE rw.provenance = 'asserted'
          AND existing.provenance = 'inferred'
          AND existing.from_id = rw.new_from
          AND existing.to_id = rw.new_to
          AND existing.relation_type = rw.relation_type
      ),
      filtered AS (
        SELECT new_from, new_to, relation_type, weight, provenance
        FROM rewritten
        WHERE new_from != new_to
          AND NOT EXISTS (
            SELECT 1 FROM public.memory_relations existing
            WHERE existing.from_id = rewritten.new_from
              AND existing.to_id = rewritten.new_to
              AND existing.relation_type = rewritten.relation_type
          )
      )
      INSERT INTO public.memory_relations (from_id, to_id, relation_type, weight, provenance)
      SELECT new_from, new_to, relation_type, weight, provenance FROM filtered
      -- The NOT EXISTS above already filters, but it reads the snapshot: an
      -- identical edge committed concurrently would otherwise fail the merge
      -- on the unique index (drizzle/0017). No target, so valid without it.
      -- Known gap: if that concurrent edge is inferred and ours asserted, the
      -- inferred row wins, since "upgraded" read the same snapshot. Fixing it
      -- needs DO UPDATE with a conflict target, which errors on a database
      -- without the index. Without ON CONFLICT the same race fails the merge
      -- on an indexed database and writes a duplicate on an unindexed one.
      ON CONFLICT DO NOTHING
    `);

    const transferred = transferResult.rowCount ?? 0;

    // Delete source (cascades its remaining edges)
    await tx.delete(entities).where(eq(entities.id, sourceId));
    return transferred;
  });

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
