/**
 * Unit tests for intelligence module — confidence scoring (pure function).
 */
import { describe, it, expect } from 'vitest';
import { computeConfidence, type ConfidenceInput } from '../src/intelligence.js';

describe('computeConfidence', () => {
  it('returns 0.3 (recency only) when all other signals are zero', () => {
    const input: ConfidenceInput = {
      accessCount: 0,
      maxAccessCount: 0,
      edgeCount: 0,
      maxEdgeCount: 0,
      versionCount: 0,
      maxVersionCount: 0,
      daysSinceAccess: 0,
    };
    // recency = 1/(1+0) = 1.0, score = 0.3 * 1.0 = 0.3
    expect(computeConfidence(input)).toBeCloseTo(0.3, 2);
  });

  it('returns 1.0 when all signals are maxed and access is today', () => {
    const input: ConfidenceInput = {
      accessCount: 10,
      maxAccessCount: 10,
      edgeCount: 5,
      maxEdgeCount: 5,
      versionCount: 3,
      maxVersionCount: 3,
      daysSinceAccess: 0,
    };
    // 0.3*1 + 0.2*1 + 0.2*1 + 0.3*1 = 1.0
    expect(computeConfidence(input)).toBeCloseTo(1.0, 2);
  });

  it('recency decreases as daysSinceAccess grows', () => {
    const base: ConfidenceInput = {
      accessCount: 5,
      maxAccessCount: 10,
      edgeCount: 2,
      maxEdgeCount: 5,
      versionCount: 1,
      maxVersionCount: 3,
      daysSinceAccess: 0,
    };

    const recent = computeConfidence(base);
    const stale = computeConfidence({ ...base, daysSinceAccess: 30 });
    const ancient = computeConfidence({ ...base, daysSinceAccess: 365 });

    expect(recent).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(ancient);
  });

  it('is always in [0, 1] range', () => {
    // Edge case: extreme values
    const extremes: ConfidenceInput[] = [
      { accessCount: 0, maxAccessCount: 0, edgeCount: 0, maxEdgeCount: 0, versionCount: 0, maxVersionCount: 0, daysSinceAccess: 10000 },
      { accessCount: 100, maxAccessCount: 100, edgeCount: 50, maxEdgeCount: 50, versionCount: 20, maxVersionCount: 20, daysSinceAccess: 0 },
      { accessCount: 1, maxAccessCount: 1000, edgeCount: 0, maxEdgeCount: 100, versionCount: 0, maxVersionCount: 50, daysSinceAccess: 1 },
    ];

    for (const input of extremes) {
      const score = computeConfidence(input);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('handles zero maxes gracefully (no division by zero)', () => {
    const input: ConfidenceInput = {
      accessCount: 5,
      maxAccessCount: 0,
      edgeCount: 3,
      maxEdgeCount: 0,
      versionCount: 2,
      maxVersionCount: 0,
      daysSinceAccess: 1,
    };
    // All norms are 0 (max is 0), only recency contributes
    // recency = 1/(1+1) = 0.5, score = 0.3 * 0.5 = 0.15
    const score = computeConfidence(input);
    expect(score).toBeCloseTo(0.15, 2);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
