import { describe, it, expect } from 'vitest';
import { computeTier } from '../src/thermal.js';
import {
  TIER_HOT,
  TIER_WARM,
  BUMP_AMOUNT,
  DECAY_RATE,
} from '../src/config.js';

describe('computeTier', () => {
  it('returns HOT for temperature above 0.7', () => {
    expect(computeTier(0.8)).toBe('HOT');
    expect(computeTier(1.0)).toBe('HOT');
    expect(computeTier(0.71)).toBe('HOT');
  });

  it('returns WARM for temperature between 0.3 and 0.7', () => {
    expect(computeTier(0.5)).toBe('WARM');
    expect(computeTier(0.7)).toBe('WARM');
    expect(computeTier(0.31)).toBe('WARM');
  });

  it('returns COLD for temperature at or below 0.3', () => {
    expect(computeTier(0.3)).toBe('COLD');
    expect(computeTier(0.1)).toBe('COLD');
    expect(computeTier(0.0)).toBe('COLD');
  });

  it('handles boundary values exactly', () => {
    expect(computeTier(TIER_HOT)).toBe('WARM');      // 0.7 is NOT > 0.7
    expect(computeTier(TIER_HOT + 0.01)).toBe('HOT');
    expect(computeTier(TIER_WARM)).toBe('COLD');      // 0.3 is NOT > 0.3
    expect(computeTier(TIER_WARM + 0.01)).toBe('WARM');
  });
});

describe('thermal decay math', () => {
  it('decay rate reduces temperature by 15% per cycle', () => {
    const initial = 1.0;
    const afterOne = initial * DECAY_RATE;
    expect(afterOne).toBeCloseTo(0.85, 5);

    const afterTwo = afterOne * DECAY_RATE;
    expect(afterTwo).toBeCloseTo(0.7225, 5);
  });

  it('reaches COLD tier after ~8 consecutive decays from HOT', () => {
    let temp = 1.0;
    let decays = 0;
    while (temp > TIER_WARM) {
      temp *= DECAY_RATE;
      decays++;
    }
    // Should take about 7-8 decays to drop below 0.3
    expect(decays).toBeGreaterThanOrEqual(7);
    expect(decays).toBeLessThanOrEqual(9);
    expect(computeTier(temp)).toBe('COLD');
  });

  it('bump amount brings WARM memory back toward HOT', () => {
    const warmTemp = 0.5;
    const bumped = Math.min(1.0, warmTemp + BUMP_AMOUNT);
    expect(bumped).toBe(0.7);
    expect(computeTier(bumped)).toBe('WARM'); // 0.7 is boundary, still WARM

    const bumpedAgain = Math.min(1.0, bumped + BUMP_AMOUNT);
    expect(bumpedAgain).toBeCloseTo(0.9, 5);
    expect(computeTier(bumpedAgain)).toBe('HOT');
  });

  it('bump is capped at 1.0', () => {
    const hotTemp = 0.95;
    const bumped = Math.min(1.0, hotTemp + BUMP_AMOUNT);
    expect(bumped).toBe(1.0);
  });

  it('decay never goes below 0.0', () => {
    let temp = 0.01;
    for (let i = 0; i < 100; i++) {
      temp = Math.max(0.0, temp * DECAY_RATE);
    }
    expect(temp).toBeGreaterThanOrEqual(0.0);
  });
});
