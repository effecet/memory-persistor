import { describe, it, expect } from 'vitest';
import { AUTO_RELATE_THRESHOLD, AUTO_RELATE_LIMIT } from '../src/config.js';

describe('auto-relate config', () => {
  it('threshold is between 0 and 1', () => {
    expect(AUTO_RELATE_THRESHOLD).toBeGreaterThanOrEqual(0);
    expect(AUTO_RELATE_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('limit is a positive integer', () => {
    expect(AUTO_RELATE_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(AUTO_RELATE_LIMIT)).toBe(true);
  });

  it('threshold defaults to 0.3', () => {
    expect(AUTO_RELATE_THRESHOLD).toBe(0.3);
  });

  it('limit defaults to 3', () => {
    expect(AUTO_RELATE_LIMIT).toBe(3);
  });
});
