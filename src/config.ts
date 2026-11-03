/**
 * Configuration for memory-persistor.
 * Scoring weights, decay rate, and path constants.
 *
 * ⚠️ This module reads `process.env` at module scope (EMBED_ON_WRITE_ENABLED,
 * CLAUDE_DIR, MEMORY_PERSISTOR_DIR), so `src/db.ts` MUST NOT import it: ESM
 * evaluates imports before a module's body, which would run these reads before
 * db.ts's own `dotenv.config()`. Measured 2026-09-06 — it silently flipped
 * EMBED_ON_WRITE_ENABLED to false while the env var said "true". Constants that
 * db.ts needs belong in the leaf module `src/search-path.ts`; do not "tidy"
 * them in here. `tests/env-load-order.test.ts` fails loudly if that happens.
 */

// ── Retrieval scoring v4: priors modulate relevance ──────────────────────
//
// The flat 9-signal `SCORING_WEIGHTS` object was REMOVED here on 2026-09-06, not
// deprecated. Nothing in src/ read it after the switchover, and a weights object
// that no longer drives scoring is a trap: a future contributor could retune a
// value, see the tests still pass, and change nothing about retrieval.
//
//   score = relevance × (1 + PRIOR_ALPHA · prior)
//
// `relevance` and `prior` are each a normalized [0,1] blend of their own group,
// so a memory with weak relevance cannot accumulate query-independent bonuses to
// the top of the ranking. With relevance = 0 no prior combination yields a
// non-zero score.
//
// The flat additive model this replaces gave the query-independent signals 0.55
// of the score against relevance's 0.45 — AND those signals are mutually
// correlated, because a frequently-recalled hub is hot, high-access, recent and
// well-connected, and `recall` reheats every row it returns. So one memory
// collected nearly all of 0.55 at once while relevance was capped at 0.45.
// Measured 2026-09-06 on a production corpus: in the reported failure the
// correct answer won on relevance 0.183 to 0.123 and still lost the query by
// 0.334. Removing centrality entirely left the wrong hit ahead 0.469 to 0.284,
// which is why every fix that only reweighted a single signal would have missed.
//
// See the design notes.
//
// Within-group ratios are IDENTICAL to the deleted flat SCORING_WEIGHTS, so this change is
// purely structural and the benchmark can attribute its whole effect to the
// model rather than to re-tuning. Written as divisions by the old group totals
// because rounded decimals do not sum to 1.0 — and an off-by-1e-4 sum silently
// unbounds the product.
const RELEVANCE_TOTAL = 0.45;
const PRIOR_TOTAL = 0.55;

/** Query-DEPENDENT signals. Normalized to sum to 1.0. */
export const RELEVANCE_WEIGHTS = {
  textRank: 0.13 / RELEVANCE_TOTAL,
  trigramSimilarity: 0.10 / RELEVANCE_TOTAL,
  semanticSimilarity: 0.12 / RELEVANCE_TOTAL,
  tagMatch: 0.10 / RELEVANCE_TOTAL,
} as const;

/** Query-INDEPENDENT signals. Normalized to sum to 1.0. */
export const PRIOR_WEIGHTS = {
  temperature: 0.15 / PRIOR_TOTAL,
  graphCentrality: 0.15 / PRIOR_TOTAL,
  importance: 0.10 / PRIOR_TOTAL,
  recencyBoost: 0.10 / PRIOR_TOTAL,
  accessFrequency: 0.05 / PRIOR_TOTAL,
} as const;

/**
 * How far the query-independent prior may modulate relevance.
 *
 * `score = relevance × (1 + PRIOR_ALPHA · prior)`, so 0 disables priors entirely
 * — the safety valve, reachable by config with no code change — and 1.0 lets a
 * maximal prior double a score. At 0.2 a maximally hot, central, important,
 * recently-accessed memory gets a 20% lift: enough to break a genuine near-tie,
 * not enough to overturn a better match.
 *
 * Chosen from measurement, not taste. `scripts/score-benchmark.ts` against
 * `tests/fixtures/golden-queries.json` on a production corpus, 2026-09-06 — the
 * rank of the hub that an earlier issue wrongly returned, as α rises:
 *
 *   α     hub rank   golden queries passing
 *   0.00      6              2 / 2
 *   0.10      5              2 / 2
 *   0.20      5              2 / 2
 *   0.30      4              2 / 2
 *   0.40      4              2 / 2
 *   0.45      3              1 / 2   ← hub overtakes a target
 *   0.50      3              1 / 2
 *
 * The crossover sits between 0.40 and 0.45, so 0.2 is deliberately half of it
 * rather than a value perched on the boundary of a two-query sample.
 *
 * ⚠️ A first hand-computed estimate suggested 0.5 was safe. That calculation
 * EXCLUDED semanticSimilarity, because it was done in read-only SQL where the
 * query embedding was not available. With real embeddings 0.5 fails. Re-derive α
 * from the harness after any change to the weights, the signals, or the corpus —
 * do not reason it out on paper.
 */
export const PRIOR_ALPHA = 0.2;

// ── Semantic embeddings (pgvector) ───────────────────────────────────────
// Local bge-small via @huggingface/transformers (ONNX, in-process). Vectors
// are ADDITIVE — stored in entities.embedding vector(384) beside observations.
// Model + quantization are PINNED and identical on every machine that writes:
// changing either INVALIDATES every stored vector (cosine across mixed models
// is garbage) and requires a full re-embed of every row. dtype is fp32, NOT
// q8 — a cross-platform parity check proved q8 is not deterministic across
// OS/ONNX-runtime builds even on identical CPU arch (2 of 4 samples diverged);
// fp32 has no quant step and matched 4/4.
export const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBED_DIMS = 384;
export const EMBED_QUANTIZATION = 'fp32' as const;
// A newly-written memory may sit unembedded for this window before a coverage
// monitor counts it as a failure (normal post-write / write-disabled lag).
export const EMBED_GRACE_MINUTES = 10;
// Cosine similarity above which two memories are surfaced as dedup candidates
// (human-approved merge only — never auto-merge).
export const DEDUP_COSINE_THRESHOLD = 0.92;
// Cosine similarity above which recall's WHERE clause admits a row even with
// zero lexical match — deliberately far below DEDUP_COSINE_THRESHOLD: this
// widens *recall* (worth surfacing), dedup requires near-duplicate certainty.
export const SEMANTIC_WHERE_THRESHOLD = 0.5;
// Gate for embed-on-write (dev-only-embed). Dev machines set
// MEMORY_EMBED_ENABLED=true in their env file; other machines omit it —
// remember/update/merge store embedding=NULL (always safe), backfilled by a
// primary via scripts/backfill-embeddings.ts. Named "_ON_WRITE" deliberately:
// this only scopes the write path. A query-time embedding call (semantic
// recall on a write-disabled machine still needs to embed the QUERY to search
// vectors a primary wrote) must NOT reuse this flag — that's a distinct
// capability check, not a write policy.
export const EMBED_ON_WRITE_ENABLED = process.env.MEMORY_EMBED_ENABLED === 'true';

// ── Thermal decay ──────────────────────────────────────────────────────────
export const DECAY_RATE = 0.85;       // multiplier per missed day (HOT→COLD in ~10 days)
export const BUMP_AMOUNT = 0.2;       // added on access (capped at 1.0)
export const DECAY_THRESHOLD_HOURS = 24; // only decay memories not accessed in this window

// ── Cascade bumps ─────────────────────────────────────────────────────────
export const CASCADE_FACTOR = 0.5;   // neighbors get BUMP_AMOUNT * CASCADE_FACTOR * edge_weight

// ── Pattern-aware decay ───────────────────────────────────────────────────
export const PATTERN_THRESHOLD_BITS = 3;  // minimum bits set in access_bitmap to detect pattern
export const PATTERN_MULTIPLIER_BASE = 1.1; // decay multiplier when pattern detected (> 1.0 = slower)
export const PATTERN_MULTIPLIER_PER_BIT = 0.02; // extra slowdown per bit beyond threshold

// ── Auto-importance drift ─────────────────────────────────────────────────
export const IMPORTANCE_DRIFT_UP = 0.05;        // per decay cycle if access_count >= 5
export const IMPORTANCE_DRIFT_DOWN = 0.05;      // per decay cycle if no access for 60+ days
export const IMPORTANCE_DRIFT_ACCESS_MIN = 5;   // minimum access count to trigger upward drift
export const IMPORTANCE_DRIFT_NEGLECT_DAYS = 60; // days without access to trigger downward drift
export const IMPORTANCE_CAP = 0.9;
export const IMPORTANCE_FLOOR = 0.1;

// ── Tier boundaries ────────────────────────────────────────────────────────
export const TIER_HOT = 0.7;
export const TIER_WARM = 0.3;
// Below TIER_WARM = COLD

/**
 * Tier is assigned from a row's cume_dist over the live temperature
 * distribution, not from an absolute threshold. HOT is the top decile, WARM the
 * two deciles below it.
 *
 * Chosen as a starting point, not measured: on a 905-entity corpus this yields
 * ~90 HOT and ~181 WARM, which fills MEMORY.md's 167-slot index from the HOT and
 * WARM bands and keeps the cut off the degenerate tail (2026-09-08: 874 of 905
 * rows sat below temperature 0.3, 119 of the 356 protected rows below 0.001).
 * Re-derive from the live distribution if the corpus shape changes materially.
 */
export const HOT_QUANTILE = 0.90;
export const WARM_QUANTILE = 0.70;

/**
 * How stale a thermal_cutoffs row may be before bump() stops trusting it and
 * falls back to the TIER_HOT / TIER_WARM seeds. Decay runs daily at 06:00 UTC,
 * so 48h tolerates one missed run without flapping.
 */
export const CUTOFF_MAX_AGE_HOURS = 48;

/**
 * Below this, decay writes exactly 0. Multiplicative decay otherwise asymptotes
 * toward zero without reaching it: 7 rows were in float4 denormal range on
 * 2026-09-08 (min 7.28675e-43), and float4 multiply raises 22003 underflow when
 * a product flushes to zero, which ABORTS THE WHOLE recall query.
 */
export const TEMPERATURE_FLOOR_EPSILON = 1e-6;

// ── Paths ──────────────────────────────────────────────────────────────────
export const CLAUDE_DIR = process.env.CLAUDE_DIR || `${process.env.HOME}/.claude`;
export const MEMORY_PERSISTOR_DIR = process.env.MEMORY_PERSISTOR_DIR || process.cwd();

// ── Retrieval defaults ─────────────────────────────────────────────────────
export const DEFAULT_RECALL_LIMIT = 10;
export const STATUS_TOP_N = 5;

/**
 * Hard cap on the JSON byte-length of a recall / recall_by_ids response.
 * Enforced post-serialize in retrieve.ts (applyResponseCap). Fires before the
 * harness's per-tool-call token budget (~25k tokens / ~100 KB) so large recalls
 * never spill to a file or require a subagent grep workaround. Tune from the
 * cap-fire telemetry in the events table.
 */
export const RESPONSE_CAP_BYTES = 30_000;

/**
 * The indent the `health` handler serializes with, and therefore the units any
 * `health` byte budget must be measured in.
 *
 * NOT repo-wide: `recall`, `recall_by_ids` and `remember` deliberately emit
 * COMPACT JSON, and `retrieve.ts`'s fitRows correctly measures compact to match
 * them. Do not apply this to fitRows.
 *
 * Load-bearing, not cosmetic: `JSON.stringify(x, null, 2)` inflates these
 * payloads ~26%. the health-cap change's first cut sized `health`'s budgets against COMPACT
 * bytes while the handler emitted indented JSON — measured 25_292 B compact
 * against 31_881 B emitted, i.e. 1_881 B over the very cap the change existed
 * to respect, with every test green. Any byte budget MUST be measured with the
 * same serializer the boundary uses; sharing this constant is what makes the
 * two impossible to separate.
 */
export const RESPONSE_JSON_INDENT = 2;

/**
 * Row caps for `health`'s corpus-sized lists. They bound the QUERY — what
 * Postgres materializes and ships — while `enforceHealthCap` bounds the
 * serialized payload; `entities.name` is unbounded `text`, so a row cap cannot
 * bound bytes on its own.
 *
 * Measured live 2026-09-18 (955 entities): ~107 B per orphan, ~421 B per dedup
 * pair. The old dedup cap of 100 serialized to ~42 KB against a 30 KB cap —
 * the finding the health-cap change was opened on.
 */
export const HEALTH_ORPHAN_LIMIT = 100;
export const HEALTH_DEDUP_LIMIT = 40;
/** How many hubs `health` names. May be trimmed further — see hubsTruncated. */
export const HEALTH_HUB_LIMIT = 10;

/**
 * Max neighbours a summary-mode row carries in `related[]`.
 *
 * Summary exists to triage under the caller's token budget, but it used to copy
 * the whole edge list — and edge counts are heavily skewed: a corpus averaging
 * ~4 edges per entity can still have hubs carrying 200+. Hubs also score well,
 * so those rows surface most, which made the "lean" projection cost nearly as
 * much as full mode on exactly the rows it was supposed to shrink. A cap of 5
 * sits above the average, so the vast majority of rows are untouched while the
 * worst are cut by ~97%. When it truncates, the row carries `related_total` so
 * the true count is not lost and the caller can reach for `traverse`.
 * `full` mode is deliberately uncapped — RESPONSE_CAP_BYTES above governs it.
 */
export const SUMMARY_RELATED_CAP = 5;

// ── Auto-relate ──────────────────────────────────────────────────────────
/**
 * Minimum RELEVANCE for `remember` to auto-create an edge to a match.
 *
 * Compared against `RecallResult.relevance`, not `score` — changed 2026-09-06
 * with the scoring rebalance. An edge is a claim about content similarity, so
 * granting one partly because a memory is popular feeds the exact loop the
 * rebalance damps: more edges raise centrality, which raises the prior, which
 * grants more edges. Comparing relevance also makes the number interpretable
 * again, since `score` now spans [0, 1 + PRIOR_ALPHA].
 *
 * The value stays 0.3 because that is approximately rate-preserving, measured
 * read-only on a production corpus (2026-09-06): using 20 random memories as
 * remember-like queries, their top-4 candidate matches scored relevance
 * 0.228–0.404 (median 0.341), and a 0.3 cut admits 55 of 60. Note auto-relate
 * passes `skipSemantic: true`, so `semanticSimilarity` contributes 0 and
 * achievable relevance caps at 1 - (0.12 + 0.10)/0.45 = 0.5111 — 0.3 is therefore ~41% of
 * what is reachable, not 30%.
 *
 * Re-measure with `scripts/score-benchmark.ts` before changing it. Getting this
 * wrong is silent in both directions: too low over-connects the graph and
 * worsens the centrality it feeds, too high stops edges forming at all.
 */
export const AUTO_RELATE_THRESHOLD = 0.3;
export const AUTO_RELATE_LIMIT = 3;

// ── Edge provenance ──────────────────────────────────────────────────
//
// Mirrors the CHECK in drizzle/0016_relation_provenance.sql. 'asserted' = an
// explicit claim (the `relate` tool, `remember`'s `relatedTo`); 'inferred' = the
// server's own guess (auto-relate). `merge` preserves whichever it moves.
export type EdgeProvenance = 'asserted' | 'inferred';

/**
 * What an INFERRED edge counts for in graph centrality, relative to an asserted
 * edge's 1.0. Applied to numerator and denominator alike, so on a corpus where
 * every edge has the same provenance the ratio — and so the ranking — is
 * exactly what it was before edge provenance.
 *
 * 0.5 is a STARTING value, not a measured one: the golden corpus has no
 * asserted edges, so `scripts/score-benchmark.ts` cannot yet distinguish any
 * value from another. Re-measure once asserted edges accumulate. Must stay in
 * (0, 1]: 0 would erase auto-relate from centrality entirely, which is a
 * different decision than down-weighting it.
 */
export const INFERRED_EDGE_WEIGHT = 0.5;

// ── Cold consolidation ───────────────────────────────────────────────────
export const STALE_THRESHOLD_DAYS = 30;

// ── Memory types ───────────────────────────────────────────────────────────
export const MEMORY_TYPES = ['user', 'project', 'decision', 'fact', 'pattern', 'feedback', 'reference'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];

// ── Pending queue ──────────────────────────────────────────────────────────

// The three vocabularies below are exported as TYPES as well as values, and
// the types must live here rather than in pending.ts: schema.ts needs them to
// narrow its columns, and schema.ts cannot import from pending.ts — pending.ts
// already imports schema.ts, so that direction is a cycle.

/** Allowed `pending.category` values. */
export const PENDING_CATEGORIES = ['skill', 'rule', 'automation', 'knowledge'] as const;
export type PendingCategory = typeof PENDING_CATEGORIES[number];

/** Allowed `pending.priority` values, lowest urgency first. */
export const PENDING_PRIORITIES = ['low', 'medium', 'high'] as const;
export type PendingPriority = typeof PENDING_PRIORITIES[number];

/** Allowed `pending.status` values. */
export const PENDING_STATUSES = ['open', 'done', 'archived'] as const;
export type PendingStatus = typeof PENDING_STATUSES[number];

/** Max open items rendered in the session-start brief (titles only). */
export const PENDING_BRIEF_LIMIT = 10;

// ── Toolsets ──────────────────────────────────────────────────────────
//
// Every tool belongs to exactly one set (pinned by tests/toolsets.test.ts).
// `MEMORY_PERSISTOR_TOOLSETS` (comma-separated set names) narrows what a
// server registers; unset, empty or `all` registers every tool — the default,
// so no existing caller loses a tool. The read-only projections (`status`,
// `graph`, the queue) are ALSO resources, which every server exposes
// whatever its toolsets. Toolsets narrow what a model has to choose among;
// they are NOT access control — every tool's data stays reachable another way.
export const TOOLSETS = {
  core: ['remember', 'recall', 'recall_by_ids', 'update', 'forget', 'relate', 'traverse', 'history', 'merge'],
  maintenance: ['status', 'graph', 'conflicts', 'analytics', 'health'],
  queue: ['pending_add', 'pending_list', 'pending_resolve', 'pending_update'],
} as const;
type ToolsetName = keyof typeof TOOLSETS;

/**
 * Parse a MEMORY_PERSISTOR_TOOLSETS value. Returns the tool names to register
 * and any set names it did not recognise (the caller warns on those — a typo
 * must be visible, never silently narrow the server to nothing).
 *
 * An input naming ONLY unknown sets falls back to every tool: failing open
 * keeps the brain usable, and the warning says why it is wider than asked.
 */
export function parseToolsets(raw: string | undefined): { tools: Set<string>; unknown: string[] } {
  const all = new Set<string>(Object.values(TOOLSETS).flat());
  const names = (raw ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((n) => n !== 'all' && !(n in TOOLSETS));
  if (names.length === 0 || names.includes('all')) return { tools: all, unknown };
  const known = names.filter((n): n is ToolsetName => n in TOOLSETS);
  if (known.length === 0) return { tools: all, unknown };
  return { tools: new Set<string>(known.flatMap((n) => TOOLSETS[n])), unknown };
}
