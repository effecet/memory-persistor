/**
 * Configuration for memory-persistor.
 * Scoring weights, decay rate, and path constants.
 */

// ── Retrieval scoring weights (v3: 9 signals) ────────────────────────────
// score = textRank + trigramSimilarity + semanticSimilarity + tagMatch
//       + temperature + importance + graphCentrality + recencyBoost
//       + accessFrequency
// All weights must sum to 1.0. semanticSimilarity is funded by taking share
// from the two lexical signals it overlaps with (textRank 0.20→0.13, trigram
// 0.15→0.10) rather than diluting every signal.
export const SCORING_WEIGHTS = {
  textRank: 0.13,
  trigramSimilarity: 0.10,
  semanticSimilarity: 0.12,
  tagMatch: 0.10,
  temperature: 0.15,
  importance: 0.10,
  graphCentrality: 0.15,
  recencyBoost: 0.10,
  accessFrequency: 0.05,
} as const;

// Minimum trigram similarity to include in results (hybrid WHERE clause)
export const TRIGRAM_THRESHOLD = 0.2;

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

// ── Auto-relate ──────────────────────────────────────────────────────────
export const AUTO_RELATE_THRESHOLD = 0.3;
export const AUTO_RELATE_LIMIT = 3;

// ── Cold consolidation ───────────────────────────────────────────────────
export const STALE_THRESHOLD_DAYS = 30;

// ── Memory types ───────────────────────────────────────────────────────────
export const MEMORY_TYPES = ['user', 'project', 'decision', 'fact', 'pattern', 'feedback', 'reference'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];
