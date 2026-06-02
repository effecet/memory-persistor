/**
 * Configuration for memory-persistor.
 * Scoring weights, decay rate, and path constants.
 */

// ── Retrieval scoring weights (v2: 8 signals) ────────────────────────────
// score = textRank + trigramSimilarity + tagMatch + temperature
//       + importance + graphCentrality + recencyBoost + accessFrequency
// All weights must sum to 1.0.
export const SCORING_WEIGHTS = {
  textRank: 0.20,
  trigramSimilarity: 0.15,
  tagMatch: 0.10,
  temperature: 0.15,
  importance: 0.10,
  graphCentrality: 0.15,
  recencyBoost: 0.10,
  accessFrequency: 0.05,
} as const;

// Minimum trigram similarity to include in results (hybrid WHERE clause)
export const TRIGRAM_THRESHOLD = 0.2;

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
