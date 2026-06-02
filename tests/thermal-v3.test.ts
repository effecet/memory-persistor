/**
 * Phase 3 TDD tests: Adaptive Thermal Model (unit tests).
 *
 * Tests computePatternMultiplier and importanceDrift logic.
 * Expected to FAIL until Phase 3 implementation is complete.
 */
import { describe, it, expect } from 'vitest';

import { computePatternMultiplier, computeImportanceDrift } from '../src/thermal.js';
import { DECAY_RATE } from '../src/config.js';

describe('pattern-aware decay multiplier', () => {
  it('returns 1.0 (no slowdown) when bitmap has < 3 bits set', () => {
    // bitmap 0b0000011 = 2 days → no pattern detected
    expect(computePatternMultiplier(0b0000011)).toBeCloseTo(1.0, 2);
    // bitmap 0b0000001 = 1 day
    expect(computePatternMultiplier(0b0000001)).toBeCloseTo(1.0, 2);
    // bitmap 0b0000000 = no days
    expect(computePatternMultiplier(0b0000000)).toBeCloseTo(1.0, 2);
  });

  it('returns value > 1.0 (slower decay) when bitmap has >= 3 bits set', () => {
    // bitmap 0b0000111 = 3 days → regular pattern
    const mult = computePatternMultiplier(0b0000111);
    expect(mult).toBeGreaterThan(1.0);
    // Should be close to the pattern multiplier constant
    expect(mult).toBeCloseTo(1.1, 1);
  });

  it('returns higher multiplier for more active days', () => {
    const mult3 = computePatternMultiplier(0b0000111); // 3 bits
    const mult5 = computePatternMultiplier(0b0011111); // 5 bits
    const mult7 = computePatternMultiplier(0b1111111); // 7 bits (all days)
    // More active days → higher multiplier (slower decay)
    expect(mult5).toBeGreaterThanOrEqual(mult3);
    expect(mult7).toBeGreaterThanOrEqual(mult5);
  });
});

describe('auto-importance drift', () => {
  it('increases importance when access count >= 5', () => {
    const drift = computeImportanceDrift({
      accessCount: 5,
      importance: 0.5,
      daysSinceAccess: 0,
    });
    expect(drift).toBeGreaterThan(0.5);
  });

  it('caps importance at 0.9', () => {
    const drift = computeImportanceDrift({
      accessCount: 100,
      importance: 0.88,
      daysSinceAccess: 0,
    });
    expect(drift).toBeLessThanOrEqual(0.9);
  });

  it('decreases importance when no access for 60+ days', () => {
    const drift = computeImportanceDrift({
      accessCount: 0,
      importance: 0.5,
      daysSinceAccess: 60,
    });
    expect(drift).toBeLessThan(0.5);
  });

  it('floors importance at 0.1', () => {
    const drift = computeImportanceDrift({
      accessCount: 0,
      importance: 0.12,
      daysSinceAccess: 365,
    });
    expect(drift).toBeGreaterThanOrEqual(0.1);
  });

  it('no drift when access count < 5 and days < 60', () => {
    const drift = computeImportanceDrift({
      accessCount: 2,
      importance: 0.5,
      daysSinceAccess: 30,
    });
    expect(drift).toBeCloseTo(0.5, 5);
  });
});
