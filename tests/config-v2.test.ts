/**
 * Scoring config contract.
 *
 * V2 expanded from 4 to 8 signals; Phase 2 added the 9th (semanticSimilarity).
 * The 2026-09-06 rebalance kept all nine signals but split them into
 * two NORMALIZED groups, because `score = relevance × (1 + α·prior)` needs each
 * factor in [0,1] — the flat 9-way sum is gone, and with it the single
 * `SCORING_WEIGHTS` object.
 *
 * These assertions were rewritten rather than deleted: every property the old
 * flat contract guaranteed still has a counterpart here, expressed against
 * whichever group now owns the signal.
 */
import { describe, it, expect } from 'vitest';
import { RELEVANCE_WEIGHTS, PRIOR_WEIGHTS } from '../src/config.js';

const relevance = RELEVANCE_WEIGHTS as Record<string, number>;
const prior = PRIOR_WEIGHTS as Record<string, number>;
const all = { ...relevance, ...prior };

describe('scoring weights', () => {
  it('still covers all 9 scoring signals across the two groups', () => {
    // Query-dependent.
    expect(relevance.textRank).toBeDefined();
    expect(relevance.trigramSimilarity).toBeDefined();
    expect(relevance.semanticSimilarity).toBeDefined();
    expect(relevance.tagMatch).toBeDefined();
    // Query-independent.
    expect(prior.temperature).toBeDefined();
    expect(prior.importance).toBeDefined();
    expect(prior.graphCentrality).toBeDefined();
    expect(prior.recencyBoost).toBeDefined();
    expect(prior.accessFrequency).toBeDefined();
    expect(Object.keys(all)).toHaveLength(9);
  });

  it('each group sums to 1.0 independently', () => {
    // Replaces "all 9 weights sum to 1.0". Both factors of the product must be
    // normalized, so the invariant is now per-group.
    const sum = (o: Record<string, number>): number =>
      Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(relevance)).toBeCloseTo(1.0, 10);
    expect(sum(prior)).toBeCloseTo(1.0, 10);
  });

  it('all weights are positive', () => {
    for (const [key, value] of Object.entries(all)) {
      expect(value, `weight ${key}`).toBeGreaterThan(0);
    }
  });

  it('no single signal dominates its own group', () => {
    // The old bound was an absolute 0.3 against a 1.0 total. Post-normalization a
    // weight is a share of its group, so the equivalent bound is 0.3 of that
    // group — which is the same statement about relative influence.
    for (const [key, value] of Object.entries(all)) {
      expect(value, `weight ${key} should not dominate its group`).toBeLessThanOrEqual(0.3);
    }
  });

  it('the query-independent group can no longer outweigh relevance additively', async () => {
    // The defect this rebalance fixed: under the flat model the five
    // query-independent weights summed to 0.55 against relevance's 0.45, and they
    // are mutually correlated, so one memory collected nearly all of them at once.
    // Priors now multiply relevance instead of adding to it, so there is no
    // additive budget to compare — asserted here so a future revert to a single
    // flat SCORING_WEIGHTS object trips this test.
    const mod = (await import('../src/config.js')) as Record<string, unknown>;
    expect('SCORING_WEIGHTS' in mod).toBe(false);
  });
});
