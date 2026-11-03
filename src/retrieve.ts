/**
 * Search and retrieval logic (v4: relevance modulated by a query-independent prior).
 *
 * Scoring formula:
 *   score = relevance × (1 + PRIOR_ALPHA · prior)
 *
 *   relevance = textRank + trigramSimilarity + semanticSimilarity + tagMatch   (→ [0,1])
 *   prior     = temperature + graphCentrality + importance + recencyBoost
 *               + accessFrequency                                             (→ [0,1])
 *
 * Priors MODULATE relevance rather than adding to it, so a memory with weak
 * relevance cannot accumulate query-independent bonuses to the top of a ranking.
 * The v3 flat 9-way sum gave the query-independent signals 0.55 against relevance's
 * 0.45, and they are mutually correlated, so one popular memory collected nearly
 * all of them at once (the hub-ranking bug and percentile tiering). Every signal expression is exported so
 * scripts/score-benchmark.ts scores through this exact SQL.
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
import { RELEVANCE_WEIGHTS, PRIOR_WEIGHTS, PRIOR_ALPHA, AUTO_RELATE_THRESHOLD as AUTO_RELATE_MIN_RELEVANCE, DEFAULT_RECALL_LIMIT, TRIGRAM_THRESHOLD, SEMANTIC_WHERE_THRESHOLD, RESPONSE_CAP_BYTES, SUMMARY_RELATED_CAP, INFERRED_EDGE_WEIGHT } from './config.js';
import { bump } from './thermal.js';
import { truncateDescription } from './file-sync.js';
import { embedForQuery, toPgVector } from './embed.js';
import type { EdgeProvenance } from './config.js';
import type { RelationType } from './graph.js';

/**
 * What one edge contributes to graph centrality: 1.0 for an ASSERTED edge,
 * INFERRED_EDGE_WEIGHT for one the server guessed. Takes the provenance column
 * so the numerator and denominator can share it under different aliases — they
 * MUST weight identically, or the ratio stops being bounded by 1.
 */
export function edgeWeightExpr(provenance: SQL): SQL {
  return sql`(CASE WHEN ${provenance} = 'asserted' THEN 1.0::double precision
    ELSE ${INFERRED_EDGE_WEIGHT}::double precision END)`;
}

/**
 * Graph centrality numerator: a node's WEIGHTED total degree — the summed
 * edgeWeightExpr of relations where the node is either endpoint. Correlated on
 * `e.id`, so it only makes sense inside a query that exposes `entities e`.
 */
export const CENTRALITY_EXPR: SQL = sql`COALESCE(
  (SELECT SUM(${edgeWeightExpr(sql`r.provenance`)}) FROM public.memory_relations r
   WHERE r.from_id = e.id OR r.to_id = e.id),
  0
)`;

/**
 * Graph centrality denominator: the corpus maximum WEIGHTED total degree.
 *
 * This MUST measure the same quantity as CENTRALITY_EXPR, or the ratio is not
 * bounded by 1 and the signal can exceed its own weight. It previously took the
 * max over ONE-DIRECTIONAL counts — `MAX(COUNT(*) GROUP BY from_id)` unioned
 * with the same over `to_id` — i.e. the max out-degree or in-degree, a strictly
 * different measure. Measured 2026-09-06: on a production corpus (861 entities) max
 * total degree 287 against that denominator's 285, so the top hub normalized to
 * 1.007 and contributed 0.1511 against a 0.15 weight; on the local dev corpus
 * the same defect measured 28/24 = 1.167. Small in magnitude, but it overpaid
 * precisely the most-connected node — the harmful direction.
 *
 * Unioning both endpoint columns and grouping once counts a self-loop
 * (`from_id = to_id`) twice here while CENTRALITY_EXPR's `OR` counts it once, so
 * a self-loop slightly INFLATES the denominator. That keeps the ratio ≤ 1 (the
 * safe direction) and is why this is not a DISTINCT over r.id. There are no
 * self-loops today and nothing in the schema forbids them.
 *
 * The empty-graph guard is `COALESCE(NULLIF(…, 0), 1.0)`, NOT the earlier
 * `GREATEST(1.0, …)`: with inferred edges weighing less than 1, a small graph's
 * true maximum can sit below 1.0, and a 1.0 floor would then shrink every ratio
 * — breaking the property that a corpus of uniform provenance ranks exactly as
 * it did before edge provenance. Every edge weight is > 0, so the max is 0 only when there
 * are no edges at all.
 *
 * Uncorrelated, so Postgres evaluates it once per query as an InitPlan — not per
 * row (verified via EXPLAIN ANALYZE: `InitPlan … loops=1`).
 */
export const CENTRALITY_DENOM_EXPR: SQL = sql`COALESCE(NULLIF((
  SELECT MAX(cnt) FROM (
    SELECT SUM(w) AS cnt FROM (
      SELECT from_id AS id, ${edgeWeightExpr(sql`provenance`)} AS w FROM public.memory_relations
      UNION ALL
      SELECT to_id AS id, ${edgeWeightExpr(sql`provenance`)} AS w FROM public.memory_relations
    ) endpoints
    GROUP BY id
  ) degrees
), 0), 1.0)`;

/**
 * Weight casts in the score expression use `double precision`, NEVER `real`.
 *
 * Postgres's float4 multiply raises `22003 value out of range: underflow` when the
 * product flushes to zero (below ~1.4e-45) instead of returning 0 — and that error
 * **aborts the entire recall query**, not one row.
 *
 * Thermal decay is what reaches those magnitudes. `temperature` is `real` and is
 * multiplied by DECAY_RATE (0.85) per missed day, so a long-untouched memory walks
 * down into float4 denormals: measured 2026-09-06 on the local corpus, two entities
 * sat at `temperature = 4e-45`, and `4e-45 * 0.2727` flushes to zero. Any recall
 * whose WHERE clause admitted either row failed outright.
 *
 * Switching the weight casts from `::real` to `::double precision` took
 * `tests/integration/recall-v2.test.ts` from 8 failures to 2 **when run alone against
 * the long-lived local DEV database**. It changes nothing in CI: `make test-integration`
 * builds a fresh database, which has no decayed denormals, so the fault is unreachable
 * there and that suite was already green. (That file's failure count is also run-order
 * dependent — see the memory `recall integration failures are run-order dependent` — so
 * treat 8/2 as one measurement, not a property.) The bug is real and production-only,
 * which is exactly why `tests/integration/scoring-bounds.test.ts` now INSERTS a denormal
 * row: without that fixture CI can never catch a regression here.
 * float8's denormal floor is ~5e-324, out of reach of any decay chain.
 *
 * It matters more under the multiplicative model than the additive one:
 * `relevance × (1 + α·prior)` multiplies two sub-1.0 factors, so products sit
 * closer to the floor by construction.
 *
 * The complementary fix belongs in decay — temperature should floor to 0 rather
 * than drift into denormals — and is tracked in an earlier issue, not here.
 */

/** Name + observations — the text both lexical signals read. */
export const TEXT_COL: SQL = sql`(COALESCE(e.name, '') || ' ' || COALESCE(e.observations::text, ''))`;

/** Node degree normalized by the corpus max degree. Bounded [0,1] by construction. */
export const CENTRALITY_NORM_EXPR: SQL = sql`(${CENTRALITY_EXPR} / ${CENTRALITY_DENOM_EXPR})`;

/**
 * ts_rank is documented as unbounded. It saturates at 0.9999997 for this corpus's
 * unweighted tsvectors, but a multiplicative model needs a hard ceiling rather
 * than an empirical one.
 */
export function tsRankExpr(tsvec: SQL, tsq: SQL): SQL {
  return sql`LEAST(1.0, COALESCE(ts_rank(${tsvec}, ${tsq}), 0))`;
}

/**
 * word_similarity is natively [0,1]; wrapped for symmetry and NULL safety.
 *
 * The `::text` cast is required, not cosmetic: inside COALESCE, Postgres cannot
 * infer a bind parameter's type from context and fails with
 * `function word_similarity(unknown, text) does not exist`. A bare comparison
 * (`word_similarity($1, col) > 0.2`) infers fine, which is why the WHERE clause
 * worked without it and the benchmark's SELECT did not.
 */
export function trigramExpr(rawQueryText: string): SQL {
  return sql`COALESCE(word_similarity(${rawQueryText}::text, ${TEXT_COL}), 0)`;
}

/**
 * Cosine similarity against the query vector, clamped at 0.
 *
 * `1 - (a <=> b)` spans [-1,1]: an anti-correlated vector yields -1, which made an
 * embedded row score BELOW an unembedded one (whose NULL COALESCEs to 0). Negative
 * similarity carries no ranking information worth keeping — "semantically opposite"
 * is not more relevant than "unknown".
 */
export function semanticExpr(vectorParam: string | null): SQL {
  return sql`GREATEST(0, COALESCE(1 - (e.embedding <=> ${vectorParam}::vector), 0))`;
}

/**
 * Share of the requested tags this entity carries.
 *
 * COUNT(DISTINCT t) because entity tags are not deduped on write: an entity tagged
 * ['a','a','a'] matched against ['a'] returned 3.0, a 0.30 contribution against a
 * 0.10 weight.
 *
 * The LEAST ceiling is deliberately redundant: with DISTINCT, the number of matching
 * entity tags cannot exceed the number requested, so the ratio is already ≤ 1. It is
 * kept as defence in depth against a future edit dropping DISTINCT — which means no
 * test can kill it while DISTINCT stands, and a mutation removing LEAST alone is
 * EXPECTED to survive. That is documented rather than papered over.
 */
export function tagMatchExpr(tags: string[] | undefined): SQL {
  if (!tags || tags.length === 0) return sql`0`;
  const pgArrayLiteral = `{${tags.map((t) => t.replace(/[{}",'\\/]/g, '')).join(',')}}`;
  return sql`LEAST(1.0, COALESCE(
    (SELECT COUNT(DISTINCT t)::float FROM unnest(e.tags) t WHERE t = ANY(${pgArrayLiteral}::text[]))
    / ${tags.length}::float,
    0
  ))`;
}

/**
 * Thermal prior. Reads the stored cume_dist rank rather than raw temperature.
 *
 * Raw temperature is not a usable prior at either pole: measured 2026-09-08,
 * 874 of 905 rows contributed ~0.04 and 8 contributed exactly 1.0, making the
 * signal effectively "was this read today" and feeding the reheating loop
 * (recall bumps what it returns, which raises the prior, which surfaces it again).
 * cume_dist spreads the LIVING population over (0,1], so rows with heat left
 * are distinguishable from each other.
 *
 * Since the cold-pole fix the rank is NOT a corpus-wide percentile: decay ranks only rows
 * with temperature > 0 and assigns every floored row a rank of exactly 0, so
 * the distribution has a point mass at the bottom whose size is however much of
 * the corpus is dead. That is deliberate — a fully decayed memory should
 * contribute nothing here, and before the cold-pole fix a large floored mass carried a prior
 * of up to 0.70. Weight-tuning that assumes a uniform [0,1] spread over the
 * whole table will be wrong by the size of that mass.
 *
 * Rows created between nightly decay runs have a NULL rank and fall back to
 * clamped raw temperature — never to 0, which would rank a brand-new memory
 * below every ranked one. Note the asymmetry with the floor above: an
 * UNRANKED row is not a dead row, so it must not be given the dead row's 0.
 *
 * ACCEPTED STALENESS (a known trade-off, closed as intended 2026-09-30). bump() updates
 * temperature but NOT temperature_rank, so a floored row that is read today
 * keeps a prior of exactly 0 until the next nightly decay — the bump is
 * invisible to this signal for up to a day. That is the chosen cost of a
 * percentile recomputed nightly: the effect is bounded (it moves only the prior,
 * which scales relevance by at most PRIOR_ALPHA) and self-heals every night.
 * Estimating a rank in bump() from the cached cutoffs was considered and not
 * taken — unmeasurable on the golden corpus, which has no floored rows, so it
 * would ship an unverified ranking change. Revisit only with a floored fixture
 * and scripts/score-benchmark.ts. The tempting fix is to have bump() NULL the rank so
 * this falls back to raw temperature; do NOT do that without measuring it.
 * A just-bumped row has raw temperature 0.2-1.0, well above most stored
 * percentiles, so NULLing on every read puts precisely the recently-accessed
 * rows back onto the raw-temperature scale — the scale percentile tiering measured as
 * unusable (874 of 905 rows contributing ~0.04 against 8 at exactly 1.0) and
 * the one that feeds the reheating loop the hub-ranking bug and percentile tiering exist to damp. It is a
 * ranking change, and ranking changes here are decided with
 * scripts/score-benchmark.ts, not on paper.
 */
export const TEMPERATURE_EXPR: SQL = sql`LEAST(1.0, GREATEST(0, COALESCE(e.temperature_rank, e.temperature, 0)))`;

/** Stored importance. DB-bounded [0.1,0.9]; clamped for the same reason. */
export const IMPORTANCE_EXPR: SQL = sql`LEAST(1.0, GREATEST(0, COALESCE(e.importance, 0.5)))`;

/**
 * Inverse days since last access.
 *
 * GREATEST(0, …) on the interval does double duty: it stops a future
 * last_accessed_at yielding a negative score, and it removes a division by zero
 * that occurs at exactly one day in the future — which aborts the ENTIRE recall
 * query rather than degrading a single row.
 */
export const RECENCY_EXPR: SQL = sql`(1.0 / (1.0 + GREATEST(0, COALESCE(
  EXTRACT(EPOCH FROM (NOW() - COALESCE(e.last_accessed_at, e.created_at))) / 86400.0,
  'Infinity'::double precision
))))`;

/** Access count normalized by the corpus max. GREATEST guards an empty corpus. */
export const ACCESS_FREQ_EXPR: SQL = sql`LEAST(1.0, COALESCE(e.access_count, 0)::float
  / GREATEST(1.0, (SELECT MAX(access_count)::float FROM public.entities)))`;

/** Everything the relevance blend needs from a specific query. */
export interface RelevanceInputs {
  /** `to_tsquery` terms, already ANDed with ` & `. */
  tsqueryTerms: string;
  /** The sanitized query text, for trigram similarity. */
  rawQueryText: string;
  /** pgvector literal for the query embedding, or null to skip the semantic term. */
  vectorParam: string | null;
  tags?: string[];
}

/**
 * The query-DEPENDENT half of the score, normalized to [0,1].
 *
 * Exported so `scripts/score-benchmark.ts` scores rows through the EXACT SQL
 * production uses. A benchmark that reimplements the formula measures the
 * reimplementation, and the two drift the moment a weight moves.
 */
export function buildRelevanceSql(inputs: RelevanceInputs): SQL {
  const { tsqueryTerms, rawQueryText, vectorParam, tags } = inputs;
  const tsvec = sql`to_tsvector('english', ${TEXT_COL})`;
  const tsq = sql`to_tsquery('english', ${tsqueryTerms})`;
  return sql`(
    ${tsRankExpr(tsvec, tsq)} * ${RELEVANCE_WEIGHTS.textRank}::double precision
    + ${trigramExpr(rawQueryText)} * ${RELEVANCE_WEIGHTS.trigramSimilarity}::double precision
    + (${semanticExpr(vectorParam)}) * ${RELEVANCE_WEIGHTS.semanticSimilarity}::double precision
    + (${tagMatchExpr(tags)}) * ${RELEVANCE_WEIGHTS.tagMatch}::double precision
  )`;
}

/**
 * The query-INDEPENDENT half of the score, normalized to [0,1].
 *
 * Uncorrelated with the query, so it is a module constant rather than a builder.
 * It multiplies relevance (see `recall`), which is what stops a popular memory
 * from outranking a better match: with relevance = 0 no prior value can produce a
 * non-zero score.
 */
export const PRIOR_SQL: SQL = sql`(
  ${TEMPERATURE_EXPR} * ${PRIOR_WEIGHTS.temperature}::double precision
  + ${CENTRALITY_NORM_EXPR} * ${PRIOR_WEIGHTS.graphCentrality}::double precision
  + ${IMPORTANCE_EXPR} * ${PRIOR_WEIGHTS.importance}::double precision
  + ${RECENCY_EXPR} * ${PRIOR_WEIGHTS.recencyBoost}::double precision
  + ${ACCESS_FREQ_EXPR} * ${PRIOR_WEIGHTS.accessFrequency}::double precision
)`;

/** The edge that sinks its target. Read by SUPERSEDED_EXPR and attachRelated alike. */
const SUPERSEDES: RelationType = 'supersedes';
const SUPERSEDES_PROVENANCE: EdgeProvenance = 'asserted';

/**
 * True when an ASSERTED `supersedes` edge points at this row: some
 * other memory claims to replace it. Correlated on `e.id`.
 *
 * Asserted only, deliberately: auto-relate infers `supersedes` from name
 * similarity alone (`detectRelationType`), and a guess must not be able to
 * bury a live memory. A self-loop is ignored so a memory cannot bury itself —
 * `relate` rejects one, but the schema does not, so a legacy or direct-SQL
 * row can still be a self-loop.
 */
export const SUPERSEDED_EXPR: SQL = sql`EXISTS (
  SELECT 1 FROM public.memory_relations s
  WHERE s.to_id = e.id AND s.from_id <> e.id
    AND s.relation_type = ${SUPERSEDES} AND s.provenance = ${SUPERSEDES_PROVENANCE}
)`;

/**
 * Result ordering: live rows first, then score. Two groups rather than a
 * score penalty, so a superseded row can NEVER outrank a live one however hot
 * or exact a match it is — a multiplier only makes that inversion less likely.
 * `score` is left untouched, so it still means relevance × (1 + α·prior).
 * Shared with scripts/score-benchmark.ts so the ranking guard measures the
 * ordering production uses.
 */
export const RECALL_ORDER_SQL: SQL = sql`(${SUPERSEDED_EXPR}) ASC, score DESC`;

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
   * vector for the SAME text via embedForWrite — a second
   * embedForQuery call here would be pure redundant inference. It would also
   * defeat the whole point of `EMBED_ON_WRITE_ENABLED` dev-only-embed: a
   * write-disabled machine that never writes vectors would otherwise still
   * load the ONNX runtime on every `remember`, not just on an explicit
   * `recall` — the one call site query-time embedding was ungated for.
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

/** A memory that supersedes this one through an asserted edge. */
export type SupersededBy = Pick<RelatedEntity, 'id' | 'name'>;

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
  /** Query-dependent half of the score, [0,1]. Exposed so callers that mean
   *  "is this actually about my query?" (auto-relate) can ask that directly
   *  instead of reading a popularity-weighted total. */
  relevance: number;
  score: number;
  related?: RelatedEntity[];
  /** Present ONLY when the row is superseded — the reason it sank. */
  superseded_by?: SupersededBy[];
}

export interface RecallSummary {
  id: string;
  name: string;
  type: string;
  description: string;
  tags: string[];
  /** Carried into summary mode too: auto-relate compares relevance, and a
   *  missing field would make `undefined < threshold` false — silently creating
   *  the spurious edges the threshold exists to prevent. */
  relevance: number;
  score: number;
  related?: RelatedEntity[];
  /** True neighbour count, present ONLY when `related` was capped. */
  related_total?: number;
  /** Not capped: it explains the row's position, and is almost always 1 long. */
  superseded_by?: SupersededBy[];
}

/**
 * Whether `remember` should auto-create an edge to this match.
 *
 * Single-sourced deliberately: `src/mcp-server.ts` and `scripts/backfill-edges.ts`
 * previously each carried their own inline comparison, so they could drift, and a
 * test could only reimplement the rule rather than exercise it.
 *
 * Gates on RELEVANCE, never on `score`. An edge is a claim about content
 * similarity; granting one because a memory is popular is self-reinforcing —
 * more edges raise centrality, centrality raises the query-independent prior,
 * and a higher prior wins more auto-relate slots.
 *
 * Written as `>=` rather than `!(< )` so a missing/NaN relevance fails CLOSED: an
 * undefined value returns false and no edge is created, instead of slipping
 * through the comparison the way `undefined < threshold` would.
 */
export function shouldAutoRelate(match: { relevance?: number }): boolean {
  const r = match.relevance;
  return typeof r === 'number' && Number.isFinite(r) && r >= AUTO_RELATE_MIN_RELEVANCE;
}

/** Project a full result down to the lean triage shape (excerpt derived at read time). */
export function toSummary(r: RecallResult): RecallSummary {
  const summary: RecallSummary = {
    id: r.id,
    name: r.name,
    type: r.type,
    description: truncateDescription(r.observations ?? '', 200),
    tags: r.tags,
    relevance: r.relevance,
    score: r.score,
  };
  // Cap the edge list: without this, summary strips the observations body but
  // still copies every neighbour, so a hub row costs nearly as much as full
  // mode — the opposite of what a triage projection is for. `related_total`
  // appears only when truncated, so a caller can tell 5 neighbours from 5 of
  // 200 and reach for `traverse` when the difference matters.
  if (r.related?.length) {
    summary.related = r.related.slice(0, SUMMARY_RELATED_CAP);
    if (r.related.length > SUMMARY_RELATED_CAP) summary.related_total = r.related.length;
  }
  if (r.superseded_by) summary.superseded_by = r.superseded_by;
  return summary;
}

export interface CapResult {
  kept: (RecallResult | RecallSummary)[];
  total_matches: number;
  truncated: boolean;
  degraded_to_summary: boolean;
}

/** Append `value` to the list at `key`, creating the list on first use. */
function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
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
 *
 * The same pass fills row.superseded_by. Its test mirrors
 * SUPERSEDED_EXPR through the same two constants (and the same self-loop
 * exclusion), so a row's position and its explanation cannot disagree.
 */
async function attachRelated(rows: RecallResult[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const idArray = uuidArray(ids);
  const allRelated = await db.execute(sql`
    SELECT r.from_id, r.to_id, r.relation_type, r.provenance, ef.name AS from_name, et.name AS to_name
    FROM public.memory_relations r
    JOIN public.entities ef ON ef.id = r.from_id
    JOIN public.entities et ON et.id = r.to_id
    WHERE r.from_id = ANY(${idArray}) OR r.to_id = ANY(${idArray})
  `);
  const idSet = new Set(ids);
  const byRowId = new Map<string, RelatedEntity[]>();
  const supersededBy = new Map<string, SupersededBy[]>();
  for (const raw of allRelated.rows as Array<{ from_id: string; to_id: string; relation_type: string; provenance: EdgeProvenance; from_name: string; to_name: string }>) {
    if (idSet.has(raw.from_id)) {
      appendTo(byRowId, raw.from_id, { id: raw.to_id, name: raw.to_name, relation_type: raw.relation_type });
    }
    if (idSet.has(raw.to_id) && raw.to_id !== raw.from_id) {
      appendTo(byRowId, raw.to_id, { id: raw.from_id, name: raw.from_name, relation_type: raw.relation_type });
      // Deduped by superseder, matching EXISTS, which ignores the count.
      // Defence in depth: the unique index (drizzle/0017) makes a duplicate
      // edge unrepresentable, so no test can plant one to kill this check.
      if (raw.relation_type === SUPERSEDES && raw.provenance === SUPERSEDES_PROVENANCE
          && !supersededBy.get(raw.to_id)?.some((s) => s.id === raw.from_id)) {
        appendTo(supersededBy, raw.to_id, { id: raw.from_id, name: raw.from_name });
      }
    }
  }
  for (const row of rows) {
    const related = byRowId.get(row.id);
    if (related && related.length > 0) row.related = related;
    const supersedingRows = supersededBy.get(row.id);
    if (supersedingRows) row.superseded_by = supersedingRows;
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

  // Every signal expression lives at module level (see the exported constants and
  // builders above) so that scripts/score-benchmark.ts scores rows through the
  // exact same SQL production uses, rather than a copy that can drift.
  const semantic = semanticExpr(vectorParam);
  const tsvec = sql`to_tsvector('english', ${TEXT_COL})`;
  const tsq = sql`to_tsquery('english', ${tsqueryTerms})`;

  // ── Hybrid WHERE: FTS match OR trigram similarity OR high cosine similarity ──
  // The semantic OR-arm is what lets a paraphrase with zero shared tokens
  // surface at all (not just re-rank among rows already matched lexically).
  //
  // Clamping semantic at 0 does not change this arm: SEMANTIC_WHERE_THRESHOLD is
  // 0.5, so every value the clamp rewrites (negative) was already excluded.
  const matchConditions: SQL[] = [
    sql`(
      ${tsvec} @@ ${tsq}
      OR word_similarity(${rawQueryText}, ${TEXT_COL}) > ${TRIGRAM_THRESHOLD}
      OR (${semantic}) > ${SEMANTIC_WHERE_THRESHOLD}
    )`,
  ];

  if (type) matchConditions.push(sql`e.type = ${type}`);
  if (tier) matchConditions.push(sql`e.tier = ${tier}`);

  const whereClause = sql.join(matchConditions, sql` AND `);

  // Shared with scripts/score-benchmark.ts so the harness cannot drift from
  // production scoring.
  const relevance = buildRelevanceSql({ tsqueryTerms, rawQueryText, vectorParam, tags });

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
      (${relevance}) AS relevance,
      -- score = relevance × (1 + α·prior). Priors MODULATE relevance rather than
      -- adding to it, so a weak match cannot accumulate its way to the top.
      (${relevance}) * (1.0 + ${PRIOR_ALPHA}::double precision * (${PRIOR_SQL})) AS score
    FROM public.entities e
    WHERE ${whereClause}
    ORDER BY ${RECALL_ORDER_SQL}
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
 * Full rows for specific ids, in the caller's order, with `related` attached
 * — and nothing else: no response cap, no bump. Unknown ids are dropped.
 *
 * The shared fetch behind `recallByIds` (which adds the cap and the bump) and
 * the `memory://entity` resource, which must be a pure read and must
 * return the whole body, so it takes neither.
 */
export async function fetchByIds(ids: string[]): Promise<RecallResult[]> {
  if (ids.length === 0) return [];
  const idArray = uuidArray(ids);
  const result = await db.execute(sql`
    SELECT e.id, e.name, e.type, e.observations, e.tags, e.source,
           e.importance, e.temperature, e.tier, e.origin_host,
           -- No query, so no relevance and no score: both are honestly 0 rather
           -- than absent. Omitting relevance made RecallResult.relevance (a
           -- REQUIRED field) undefined at runtime on this path, which toSummary
           -- then copied -- and shouldAutoRelate only fails closed on it by luck.
           0::float AS relevance,
           0::float AS score
    FROM public.entities e
    WHERE e.id = ANY(${idArray})
  `);
  const fetched = result.rows as unknown as RecallResult[];

  // Preserve caller's input order; drop unknown ids.
  const byId = new Map(fetched.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is RecallResult => r !== undefined);

  await attachRelated(ordered);
  return ordered;
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

  const capped = applyResponseCap(await fetchByIds(ids), output_mode);
  for (const row of capped.kept) {
    try { await bump(row.id); } catch { /* non-fatal */ }
  }
  const { kept, ...rest } = capped;
  return { results: kept, ...rest };
}
