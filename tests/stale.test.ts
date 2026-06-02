import { describe, it, expect } from 'vitest';
import { STALE_THRESHOLD_DAYS } from '../src/config.js';
import { computeTier } from '../src/thermal.js';
import { DECAY_RATE, TIER_WARM } from '../src/config.js';

describe('stale config', () => {
  it('stale threshold defaults to 30 days', () => {
    expect(STALE_THRESHOLD_DAYS).toBe(30);
  });

  it('stale threshold is positive', () => {
    expect(STALE_THRESHOLD_DAYS).toBeGreaterThan(0);
  });
});

describe('cold decay to stale eligibility', () => {
  it('memory reaches COLD tier well before stale threshold', () => {
    // A HOT memory decays to COLD in ~8 days
    // Stale threshold is 30 days — plenty of buffer
    let temp = 1.0;
    let days = 0;
    while (temp > TIER_WARM) {
      temp *= DECAY_RATE;
      days++;
    }
    expect(computeTier(temp)).toBe('COLD');
    expect(days).toBeLessThan(STALE_THRESHOLD_DAYS);
  });
});
