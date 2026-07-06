/**
 * Tests for the hybrid retrieval scoring-weight config.
 *
 * Nine scoring signals (the two lexical signals plus a semantic vector signal
 * and six others); all weights must sum to 1.0.
 */
import { describe, it, expect } from 'vitest';
import { SCORING_WEIGHTS } from '../src/config.js';

describe('scoring weights', () => {
  it('has all 9 scoring signals', () => {
    const w = SCORING_WEIGHTS as Record<string, number>;
    expect(w.textRank).toBeDefined();
    expect(w.trigramSimilarity).toBeDefined();
    expect(w.semanticSimilarity).toBeDefined();
    expect(w.tagMatch).toBeDefined();
    expect(w.temperature).toBeDefined();
    expect(w.importance).toBeDefined();
    expect(w.graphCentrality).toBeDefined();
    expect(w.recencyBoost).toBeDefined();
    expect(w.accessFrequency).toBeDefined();
  });

  it('all 9 weights sum to 1.0', () => {
    const w = SCORING_WEIGHTS as Record<string, number>;
    const sum =
      (w.textRank ?? 0) +
      (w.trigramSimilarity ?? 0) +
      (w.semanticSimilarity ?? 0) +
      (w.tagMatch ?? 0) +
      (w.temperature ?? 0) +
      (w.importance ?? 0) +
      (w.graphCentrality ?? 0) +
      (w.recencyBoost ?? 0) +
      (w.accessFrequency ?? 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('all weights are positive', () => {
    const w = SCORING_WEIGHTS as Record<string, number>;
    for (const [key, value] of Object.entries(w)) {
      expect(value, `weight ${key}`).toBeGreaterThan(0);
    }
  });

  it('no single weight exceeds 0.3', () => {
    const w = SCORING_WEIGHTS as Record<string, number>;
    for (const [key, value] of Object.entries(w)) {
      expect(value, `weight ${key} should not dominate`).toBeLessThanOrEqual(0.3);
    }
  });
});
