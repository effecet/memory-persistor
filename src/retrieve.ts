/**
 * Search and retrieval logic (v3: 9-signal hybrid scoring).
 *
 * Scoring formula:
 *   score = textRank + trigramSimilarity + semanticSimilarity + tagMatch
 *         + temperature + importance + graphCentrality + recencyBoost
 *         + accessFrequency
 *
 * Uses PostgreSQL full-text search (to_tsvector/to_tsquery) combined with
 * pg_trgm trigram similarity for fuzzy matching, plus pgvector cosine
 * similarity against a query embedding for semantic matching. Hybrid WHERE
 * clause: FTS match OR trigram similarity > threshold OR cosine similarity
 * > SEMANTIC_WHERE_THRESHOLD (so a paraphrase with zero shared tokens can
 * still surface, not just re-rank among already-matched rows).
 *
 * All user input is parameterized.
 *
 * Shared helpers:
 *   attachRelated(rows) — batch-fetch related entities for a set of result
 *     rows and attach them in-place (one query, no N+1). Used by both
 *     recall() and recallByIds().
 */
import { db } from './db.js';
import { sql, type SQL } from 'drizzle-orm';
import { SCORING_WEIGHTS, DEFAULT_RECALL_LIMIT, TRIGRAM_THRESHOLD, SEMANTIC_WHERE_THRESHOLD, RESPONSE_CAP_BYTES } from './config.js';
import { bump } from './thermal.js';
import { truncateDescription } from './file-sync.js';
import { embedForQuery, toPgVector } from './embed.js';

export interface RecallOptions {
  query: string;
  type?: string;
  tags?: string[];
  tier?: string;
  limit?: number;
  output_mode?: 'full' | 'summary';
  /**
   * Internal only — not exposed via the public `recall` MCP tool schema. Skips
   * embedForQuery() entirely (semantic term is always 0, no WHERE widening).
   * Used by remember's auto-relate call: it already computed a write-path
   * vector for the SAME text via embedForWrite — a second embedForQuery call
   * here would be pure redundant inference. It would also defeat the whole
   * point of `EMBED_ON_WRITE_ENABLED` dev-only-embed: a write-disabled machine
   * would otherwise still load the ONNX runtime on every `remember`, not just
   * on an explicit `recall` — the one call site query-time embedding was
   * ungated for.
   */
  skipSemantic?: boolean;
}

export interface RecallResponse {
  results: (RecallResult | RecallSummary)[];
  total_matches: number;
  truncated: boolean;
  degraded_to_summary: boolean;
}

export interface RelatedEntity {
  id: string;
  name: string;
  relation_type: string;
}

export interface RecallResult {
  id: string;
  name: string;
  type: string;
  observations: string;
  tags: string[];
  source: string;
  importance: number;
  temperature: number;
  tier: string;
  origin_host: string | null;
  score: number;
  related?: RelatedEntity[];
}

export interface RecallSummary {
  id: string;
  name: string;
  type: string;
  description: string;
  tags: string[];
  score: number;
  related?: RelatedEntity[];
}

/** Project a full result down to the lean triage shape (excerpt derived at read time). */
export function toSummary(r: RecallResult): RecallSummary {
  const summary: RecallSummary = {
    id: r.id,
    name: r.name,
    type: r.type,
    description: truncateDescription(r.observations ?? '', 200),
    tags: r.tags,
    score: r.score,
  };
  if (r.related) summary.related = r.related;
  return summary;
}

export interface CapResult {
  kept: (RecallResult | RecallSummary)[];
  total_matches: number;
  truncated: boolean;
  degraded_to_summary: boolean;
}

/** Build a parameterized Postgres uuid[] fragment (Drizzle doesn't auto-serialize JS arrays). */
function uuidArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
}

/** Keep the largest prefix of `rows` whose projected JSON stays under RESPONSE_CAP_BYTES. */
function fitRows(
  rows: RecallResult[],
  project: (r: RecallResult) => RecallResult | RecallSummary,
): (RecallResult | RecallSummary)[] {
  const kept: (RecallResult | RecallSummary)[] = [];
  let bytes = 0;
  for (const row of rows) {
    const projected = project(row);
    const size = Buffer.byteLength(JSON.stringify(projected), 'utf8');
    if (bytes + size > RESPONSE_CAP_BYTES) break;
    kept.push(projected);
    bytes += size;
  }
  return kept;
}

/**
 * Post-serialize byte-count trim. Keeps the largest prefix of `rows` whose
 * projected JSON stays under RESPONSE_CAP_BYTES. In 'full' mode, if not even
 * one row fits, re-projects everything as summary and flags degraded_to_summary.
 * total_matches reflects the candidate count passed in (post-LIMIT, pre-cap).
 */
export function applyResponseCap(
  rows: RecallResult[],
  output_mode: 'full' | 'summary',
): CapResult {
  const total_matches = rows.length;
  const project = output_mode === 'summary'
    ? (r: RecallResult): RecallResult | RecallSummary => toSummary(r)
    : (r: RecallResult): RecallResult | RecallSummary => r;

  let kept = fitRows(rows, project);

  let degraded_to_summary = false;
  if (output_mode === 'full' && kept.length === 0 && rows.length > 0) {
    degraded_to_summary = true;
    kept = fitRows(rows, toSummary);
  }

  return { kept, total_matches, truncated: kept.length < total_matches, degraded_to_summary };
}

/**
 * Batch-fetch related entities for a set of result rows and attach them as
 * row.related (only when non-empty). One query for all rows (no N+1). A stored
 * edge contributes a neighbor to EACH endpoint present in `rows`, matching the
 * original per-row semantics for the case where both endpoints are in the set.
 */
async function attachRelated(rows: RecallResult[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const idArray = uuidArray(ids);
  const allRelated = await db.execute(sql`
    SELECT r.from_id, r.to_id, r.relation_type, ef.name AS from_name, et.name AS to_name
    FROM public.memory_relations r
    JOIN public.entities ef ON ef.id = r.from_id
    JOIN public.entities et ON et.id = r.to_id
    WHERE r.from_id = ANY(${idArray}) OR r.to_id = ANY(${idArray})
  `);
  const idSet = new Set(ids);
  const byRowId = new Map<string, RelatedEntity[]>();
  for (const raw of allRelated.rows as Array<{ from_id: string; to_id: string; relation_type: string; from_name: string; to_name: string }>) {
    if (idSet.has(raw.from_id)) {
      if (!byRowId.has(raw.from_id)) byRowId.set(raw.from_id, []);
      byRowId.get(raw.from_id)!.push({ id: raw.to_id, name: raw.to_name, relation_type: raw.relation_type });
    }
    if (idSet.has(raw.to_id) && raw.to_id !== raw.from_id) {
      if (!byRowId.has(raw.to_id)) byRowId.set(raw.to_id, []);
      byRowId.get(raw.to_id)!.push({ id: raw.from_id, name: raw.from_name, relation_type: raw.relation_type });
    }
  }
  for (const row of rows) {
    const related = byRowId.get(row.id);
    if (related && related.length > 0) row.related = related;
  }
}

/**
 * Search memories using 9-signal hybrid scoring.
 * Matches via FTS OR trigram similarity (fuzzy) OR cosine similarity (semantic).
 * Bumps temperature on all returned results.
 */
export async function recall(options: RecallOptions): Promise<RecallResponse> {
  const {
    query,
    type,
    tags,
    tier,
    limit = DEFAULT_RECALL_LIMIT,
    output_mode = 'full',
    skipSemantic = false,
  } = options;

  const {
    textRank: W1,
    trigramSimilarity: W2,
    semanticSimilarity: W9,
    tagMatch: W3,
    temperature: W4,
    importance: W5,
    graphCentrality: W6,
    recencyBoost: W7,
    accessFrequency: W8,
  } = SCORING_WEIGHTS;

  // Sanitize query for tsquery — replace special chars with spaces
  const sanitizedQuery = query.replace(/[^\w\s]/g, ' ').trim();
  const tsqueryTerms = sanitizedQuery.split(/\s+/).filter(Boolean).join(' & ');

  if (!tsqueryTerms) return { results: [], total_matches: 0, truncated: false, degraded_to_summary: false };

  // The raw text used for trigram similarity comparison
  const rawQueryText = sanitizedQuery;

  // Query embedding for the semantic signal. skipSemantic bypasses the
  // embedForQuery() call entirely (see RecallOptions doc). Otherwise: a null
  // vector (embed failure) and a null e.embedding (unembedded row) both funnel
  // through the same COALESCE, so this recall's semantic term contributes 0
  // and the WHERE clause doesn't widen — degrades to lexical-only behavior.
  const queryVector = skipSemantic ? null : await embedForQuery(query);
  const vectorParam = queryVector ? toPgVector(queryVector) : null;
  const semanticExpr = sql`COALESCE(1 - (e.embedding <=> ${vectorParam}::vector), 0)`;

  // Text search building blocks
  const textCol = sql`(COALESCE(e.name, '') || ' ' || COALESCE(e.observations::text, ''))`;
  const tsvec = sql`to_tsvector('english', ${textCol})`;
  const tsq = sql`to_tsquery('english', ${tsqueryTerms})`;

  // ── Hybrid WHERE: FTS match OR trigram similarity OR high cosine similarity ──
  // The semantic OR-arm is what lets a paraphrase with zero shared tokens
  // surface at all (not just re-rank among rows already matched lexically).
  const matchConditions: SQL[] = [
    sql`(
      ${tsvec} @@ ${tsq}
      OR word_similarity(${rawQueryText}, ${textCol}) > ${TRIGRAM_THRESHOLD}
      OR (${semanticExpr}) > ${SEMANTIC_WHERE_THRESHOLD}
    )`,
  ];

  if (type) matchConditions.push(sql`e.type = ${type}`);
  if (tier) matchConditions.push(sql`e.tier = ${tier}`);

  const whereClause = sql.join(matchConditions, sql` AND `);

  // ── Tag matching: fix V1 bug by converting JS array to PG array literal ──
  // Drizzle's sql`` template doesn't auto-serialize JS arrays as PG arrays,
  // so we build a proper PG array literal string: '{tag1,tag2,...}'
  let tagMatchExpr: SQL;
  if (tags && tags.length > 0) {
    const pgArrayLiteral = `{${tags.map((t) => t.replace(/[{}",'\\\\/]/g, '')).join(',')}}`;
    tagMatchExpr = sql`COALESCE(
      (SELECT COUNT(*)::float FROM unnest(e.tags) t WHERE t = ANY(${pgArrayLiteral}::text[]))
      / ${tags.length}::float,
      0
    )`;
  } else {
    tagMatchExpr = sql`0`;
  }

  // ── Graph centrality: count of edges (normalized by max in result set) ──
  const centralityExpr = sql`COALESCE(
    (SELECT COUNT(*)::float FROM public.memory_relations r
     WHERE r.from_id = e.id OR r.to_id = e.id),
    0
  )`;

  // ── Recency boost: inverse days since last access ──
  const recencyExpr = sql`(1.0 / (1.0 + EXTRACT(EPOCH FROM (NOW() - COALESCE(e.last_accessed_at, e.created_at))) / 86400.0))`;

  // ── Access frequency: normalized access count ──
  // Use GREATEST to avoid division by zero when max is 0
  const accessFreqExpr = sql`(COALESCE(e.access_count, 0)::float / GREATEST(1.0, (SELECT MAX(access_count)::float FROM public.entities)))`;

  const result = await db.execute(sql`
    SELECT
      e.id,
      e.name,
      e.type,
      e.observations,
      e.tags,
      e.source,
      e.importance,
      e.temperature,
      e.tier,
      e.origin_host,
      (
        COALESCE(ts_rank(${tsvec}, ${tsq}), 0) * ${W1}::real
        + word_similarity(${rawQueryText}, ${textCol}) * ${W2}::real
        + (${semanticExpr}) * ${W9}::real
        + (${tagMatchExpr}) * ${W3}::real
        + COALESCE(e.temperature, 0) * ${W4}::real
        + COALESCE(e.importance, 0.5) * ${W5}::real
        + (${centralityExpr} / GREATEST(1.0, (SELECT MAX(cnt) FROM (SELECT COUNT(*)::float AS cnt FROM public.memory_relations GROUP BY from_id UNION ALL SELECT COUNT(*)::float FROM public.memory_relations GROUP BY to_id) sub))) * ${W6}::real
        + ${recencyExpr} * ${W7}::real
        + ${accessFreqExpr} * ${W8}::real
      ) AS score
    FROM public.entities e
    WHERE ${whereClause}
    ORDER BY score DESC
    LIMIT ${limit}
  `);

  const results = result.rows as unknown as RecallResult[];

  await attachRelated(results);

  // Enforce the response cap (projects to summary or trims as needed).
  const capped = applyResponseCap(results, output_mode);

  // Bump temperature on RETURNED rows only (was: every FTS+trigram match).
  // Sequential to avoid cascade-bump deadlocks between neighbor rows.
  for (const row of capped.kept) {
    try { await bump(row.id); } catch { /* non-fatal */ }
  }

  const { kept, ...rest } = capped;
  return { results: kept, ...rest };
}

export interface RecallByIdsOptions {
  ids: string[];
  output_mode?: 'full' | 'summary';
}

/**
 * Fetch full memory bodies for specific ids — no FTS, no scoring (score: 0).
 * Preserves input order, omits unknown ids, honors output_mode + the response
 * cap, and bumps temperature on returned rows. Companion to summary-mode recall.
 */
export async function recallByIds(options: RecallByIdsOptions): Promise<RecallResponse> {
  const { ids, output_mode = 'full' } = options;
  if (!ids || ids.length === 0) {
    return { results: [], total_matches: 0, truncated: false, degraded_to_summary: false };
  }

  const idArray = uuidArray(ids);
  const result = await db.execute(sql`
    SELECT e.id, e.name, e.type, e.observations, e.tags, e.source,
           e.importance, e.temperature, e.tier, e.origin_host,
           0::float AS score
    FROM public.entities e
    WHERE e.id = ANY(${idArray})
  `);
  const fetched = result.rows as unknown as RecallResult[];

  // Preserve caller's input order; drop unknown ids.
  const byId = new Map(fetched.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is RecallResult => r !== undefined);

  await attachRelated(ordered);

  const capped = applyResponseCap(ordered, output_mode);
  for (const row of capped.kept) {
    try { await bump(row.id); } catch { /* non-fatal */ }
  }
  const { kept, ...rest } = capped;
  return { results: kept, ...rest };
}
