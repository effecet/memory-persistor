import { describe, it, expect } from 'vitest';
import {
  SCORING_WEIGHTS,
  DECAY_RATE,
  BUMP_AMOUNT,
  TIER_HOT,
  TIER_WARM,
  MEMORY_TYPES,
} from '../src/config.js';

describe('scoring weights', () => {
  it('sum to 1.0', () => {
    const w = SCORING_WEIGHTS as Record<string, number>;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('all weights are positive', () => {
    const w = SCORING_WEIGHTS as Record<string, number>;
    for (const [key, value] of Object.entries(w)) {
      expect(value, `weight ${key}`).toBeGreaterThan(0);
    }
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
