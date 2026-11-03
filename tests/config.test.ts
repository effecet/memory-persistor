import { describe, it, expect } from 'vitest';
import {
  RELEVANCE_WEIGHTS,
  PRIOR_WEIGHTS,
  DECAY_RATE,
  BUMP_AMOUNT,
  TIER_HOT,
  TIER_WARM,
  MEMORY_TYPES,
  EMBED_MODEL,
  EMBED_DIMS,
  EMBED_QUANTIZATION,
  EMBED_GRACE_MINUTES,
  DEDUP_COSINE_THRESHOLD,
  SEMANTIC_WHERE_THRESHOLD,
} from '../src/config.js';

describe('scoring weights', () => {
  // The 2026-09-06 rebalance replaced the flat 9-way SCORING_WEIGHTS
  // with two normalized groups, because score = relevance x (1 + alpha*prior)
  // requires each factor in [0,1]. The sum-to-1.0 invariant is now per-group.
  it('each group sums to 1.0', () => {
    const sum = (o: Record<string, number>): number =>
      Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(RELEVANCE_WEIGHTS as Record<string, number>)).toBeCloseTo(1.0, 10);
    expect(sum(PRIOR_WEIGHTS as Record<string, number>)).toBeCloseTo(1.0, 10);
  });

  it('all weights are positive', () => {
    const all = { ...RELEVANCE_WEIGHTS, ...PRIOR_WEIGHTS } as Record<string, number>;
    for (const [key, value] of Object.entries(all)) {
      expect(value, `weight ${key}`).toBeGreaterThan(0);
    }
  });
});

describe('embedding config', () => {
  it('RELEVANCE_WEIGHTS includes semanticSimilarity (9th signal)', () => {
    // semanticSimilarity is query-DEPENDENT, so it belongs to the relevance group.
    expect(RELEVANCE_WEIGHTS).toHaveProperty('semanticSimilarity');
    expect(RELEVANCE_WEIGHTS.semanticSimilarity).toBeGreaterThan(0);
  });

  it('SEMANTIC_WHERE_THRESHOLD sits well below DEDUP_COSINE_THRESHOLD', () => {
    expect(SEMANTIC_WHERE_THRESHOLD).toBeGreaterThan(0);
    expect(SEMANTIC_WHERE_THRESHOLD).toBeLessThan(DEDUP_COSINE_THRESHOLD);
  });

  it('EMBED_MODEL is the pinned bge-small', () => {
    expect(EMBED_MODEL).toBe('Xenova/bge-small-en-v1.5');
  });

  it('EMBED_DIMS is 384', () => {
    expect(EMBED_DIMS).toBe(384);
  });

  it('EMBED_QUANTIZATION is fp32 (Phase 0 parity gate: q8 not cross-platform deterministic)', () => {
    expect(EMBED_QUANTIZATION).toBe('fp32');
  });

  it('DEDUP_COSINE_THRESHOLD is a sane cosine similarity', () => {
    expect(DEDUP_COSINE_THRESHOLD).toBeGreaterThan(0.8);
    expect(DEDUP_COSINE_THRESHOLD).toBeLessThan(1);
  });

  it('EMBED_GRACE_MINUTES is a positive integer', () => {
    expect(EMBED_GRACE_MINUTES).toBeGreaterThan(0);
    expect(Number.isInteger(EMBED_GRACE_MINUTES)).toBe(true);
  });
});

describe('thermal constants', () => {
  it('decay rate is between 0 and 1', () => {
    expect(DECAY_RATE).toBeGreaterThan(0);
    expect(DECAY_RATE).toBeLessThan(1);
  });

  it('bump amount is positive and reasonable', () => {
    expect(BUMP_AMOUNT).toBeGreaterThan(0);
    expect(BUMP_AMOUNT).toBeLessThanOrEqual(0.5);
  });

  it('tier boundaries are ordered correctly', () => {
    expect(TIER_HOT).toBeGreaterThan(TIER_WARM);
    expect(TIER_WARM).toBeGreaterThan(0);
    expect(TIER_HOT).toBeLessThan(1);
  });
});

describe('memory types', () => {
  it('contains expected types', () => {
    expect(MEMORY_TYPES).toContain('user');
    expect(MEMORY_TYPES).toContain('project');
    expect(MEMORY_TYPES).toContain('decision');
    expect(MEMORY_TYPES).toContain('fact');
    expect(MEMORY_TYPES).toContain('pattern');
    expect(MEMORY_TYPES).toContain('feedback');
    expect(MEMORY_TYPES).toContain('reference');
  });

  it('has exactly 7 types', () => {
    expect(MEMORY_TYPES).toHaveLength(7);
  });
});
