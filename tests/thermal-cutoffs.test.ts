import { describe, it, expect } from 'vitest';
import { resolveCutoffs } from '../src/thermal-cutoffs.js';
import { TIER_HOT, TIER_WARM } from '../src/config.js';

const NOW = new Date('2026-09-09T12:00:00Z');
const fresh = {
  hotCutoff: 0.42,
  warmCutoff: 0.11,
  corpusSize: 905,
  computedAt: new Date('2026-09-09T06:00:00Z'),
};

describe('resolveCutoffs', () => {
  it('uses a fresh measured row', () => {
    expect(resolveCutoffs(fresh, NOW)).toEqual({ hot: 0.42, warm: 0.11, source: 'measured' });
  });

  it('falls back to seeds when the row is missing', () => {
    expect(resolveCutoffs(null, NOW)).toEqual({ hot: TIER_HOT, warm: TIER_WARM, source: 'seed' });
  });

  it('falls back to seeds when the row is older than CUTOFF_MAX_AGE_HOURS', () => {
    const stale = { ...fresh, computedAt: new Date('2026-09-06T06:00:00Z') };
    expect(resolveCutoffs(stale, NOW).source).toBe('seed');
  });

  it('falls back to seeds when hot <= warm (degenerate distribution)', () => {
    // warmCutoff must stay ABOVE 0 here. The fixture used to be 0.0/0.0, which
    // the cold-pole fix `warm <= 0` arm now rejects FIRST — leaving this branch with no
    // coverage at all while the test still passed. Hardening one check blinded
    // the one beside it.
    const degenerate = { ...fresh, hotCutoff: 0.1, warmCutoff: 0.2 };
    expect(resolveCutoffs(degenerate, NOW).source).toBe('seed');
  });

  it('falls back to seeds when warm_cutoff is at or below 0 (the cold-pole fix cold pole)', () => {
    // A band boundary of exactly 0 carries no information: bump() compares
    // with >=, so `temperature >= 0` is true for EVERY row and COLD becomes
    // unreachable. hot > warm holds here, so the degenerate check above does
    // NOT catch it — that is the hole the cold-pole fix reported, and it read as `measured`
    // while health called the corpus healthy.
    expect(resolveCutoffs({ ...fresh, warmCutoff: 0 }, NOW).source).toBe('seed');
    // Negative is unreachable through decay (pass 1 clamps with
    // GREATEST(0.0, ...)), but the predicate is `<= 0` rather than `=== 0` so a
    // hand-written or corrupted row cannot slip past on a sign.
    expect(resolveCutoffs({ ...fresh, warmCutoff: -0.1 }, NOW).source).toBe('seed');
  });

  it('falls back to seeds on a non-finite cutoff', () => {
    const nan = { ...fresh, hotCutoff: Number.NaN };
    expect(resolveCutoffs(nan, NOW).source).toBe('seed');
  });

  it('reads corpus_size = 0 as seed, not measured (ruling R16)', () => {
    // 0012 seeds the row with hot/warm = TIER_HOT/TIER_WARM and corpus_size 0,
    // and 0013's pass 3 rewrites exactly that shape whenever a tier band comes
    // back empty. Before this, the row read as `measured` and health reported a
    // silent reversion to earlier absolute thresholds as healthy.
    const seedRow = { ...fresh, hotCutoff: TIER_HOT, warmCutoff: TIER_WARM, corpusSize: 0 };
    expect(resolveCutoffs(seedRow, NOW)).toEqual({
      hot: TIER_HOT,
      warm: TIER_WARM,
      source: 'seed',
    });
  });

  it('reads corpus_size = 0 as seed even when the cutoffs look measured', () => {
    // The marker is authoritative on its own: values that could never be the
    // seeds still read as seed, so the check cannot be satisfied by the numbers
    // coincidentally matching.
    expect(resolveCutoffs({ ...fresh, corpusSize: 0 }, NOW).source).toBe('seed');
  });

  it('falls back to seeds on a negative or non-finite corpus_size', () => {
    expect(resolveCutoffs({ ...fresh, corpusSize: -1 }, NOW).source).toBe('seed');
    expect(resolveCutoffs({ ...fresh, corpusSize: Number.NaN }, NOW).source).toBe('seed');
  });

  it('still reads a measured row with a non-zero corpus_size as measured', () => {
    // The complement of the two above: the marker must not swallow real rows.
    expect(resolveCutoffs({ ...fresh, corpusSize: 1 }, NOW).source).toBe('measured');
  });
});
