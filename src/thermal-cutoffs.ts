/**
 * Cutoff resolution for percentile-assigned thermal tiers.
 *
 * Split out of src/thermal.ts because this is the one place the fallback
 * contract is stated in TypeScript, and it is worth testing without a database
 * or a clock. The same contract is re-stated in SQL inside bump() — see the
 * comment there for why, and tests/integration/isolated/bump-cutoffs.test.ts pins the two
 * against each other.
 */
import { TIER_HOT, TIER_WARM, CUTOFF_MAX_AGE_HOURS } from './config.js';

export type CutoffRow = {
  hotCutoff: number;
  warmCutoff: number;
  /**
   * Corpus size the cutoffs were derived from. 0 is the SEED marker — see
   * drizzle/0012_thermal_cutoffs.sql, which seeds the row with it, and pass 3
   * of the decay function (the last migration defining it — 0015 as of the cold-pole fix),
   * which rewrites it whenever a tier band comes back empty.
   * It is authoritative here, not decorative: without consulting it the seeded
   * 0.7/0.3 row reads as `measured`, and `health` then reports the earlier
   * reversion as healthy (ruling R16).
   */
  corpusSize: number;
  computedAt: Date;
};

export type ThermalCutoffs = {
  hot: number;
  warm: number;
  /** 'seed' means the caller is running on TIER_HOT/TIER_WARM, i.e. earlier behaviour. */
  source: 'measured' | 'seed';
};

const SEED: ThermalCutoffs = { hot: TIER_HOT, warm: TIER_WARM, source: 'seed' };

/**
 * Fail SAFE, not closed: an absent, seed-marked, stale, degenerate or
 * non-finite cutoffs row degrades to the earlier absolute thresholds rather
 * than mis-tiering the whole corpus.
 *
 * "Degenerate" is TWO conditions, not one. `hot <= warm` is the obvious half.
 * The other is `warm <= 0`: a mass tie at temperature 0 used to be
 * tiered WARM, making MIN(temperature) over that band exactly 0 — a row that
 * is non-empty, non-stale AND satisfies hot > warm, so every other check here
 * passes it as `measured` while `temperature >= 0` makes COLD unreachable.
 * drizzle/0015 stops decay writing that row at all by excluding the floor from
 * the ranking population; this check is the reader's half of the same
 * contract, and it also covers a row written by an older migration or by hand.
 *
 * It is an EXACTLY-ZERO test, not a magnitude threshold: a warm_cutoff of
 * 1e-30 still reads as measured. That is intentional — such a cutoff still
 * leaves COLD reachable (a floored row at exactly 0 falls below it), which is
 * the property being protected, and picking an epsilon here would be a second
 * unpinned constant beside decay's own floor.
 *
 * corpus_size = 0 is checked FIRST because it is the only marker that
 * distinguishes "never measured" from "measured and happened to equal the
 * seeds": 0.7/0.3 are legal measured values, so the numbers alone cannot say.
 * A genuinely measured row over an empty corpus would read as seed — the safe
 * direction, and it has no distribution to tier against anyway.
 */
export function resolveCutoffs(row: CutoffRow | null, now: Date = new Date()): ThermalCutoffs {
  if (!row) return SEED;
  const { hotCutoff, warmCutoff, corpusSize, computedAt } = row;
  if (!Number.isFinite(corpusSize) || corpusSize <= 0) return SEED;
  if (!Number.isFinite(hotCutoff) || !Number.isFinite(warmCutoff)) return SEED;
  // A band boundary of 0 carries no information, and it is NOT caught by the
  // degenerate check below — hot > warm holds fine at warm = 0. Both
  // comparison sites use >=, so `temperature >= 0` is true for every row and
  // COLD becomes unreachable while this still reads as `measured`.
  if (warmCutoff <= 0) return SEED;
  if (hotCutoff <= warmCutoff) return SEED;
  const ageHours = (now.getTime() - computedAt.getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > CUTOFF_MAX_AGE_HOURS) return SEED;
  return { hot: hotCutoff, warm: warmCutoff, source: 'measured' };
}
