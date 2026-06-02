/**
 * Integration tests for the thermal decay subsystem.
 * Tests bump() against a real Postgres database to verify temperature,
 * access count, and tier recomputation.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { bump, computeTier } from '../../src/thermal.js';
import { DECAY_RATE, BUMP_AMOUNT } from '../../src/config.js';
import {
  insertTestMemory,
  cleanupMemories,
  getMemory,
  closeTestDb,
} from './helpers.js';

describe('thermal-decay integration', () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    if (createdIds.length > 0) {
      await cleanupMemories([...createdIds]);
      createdIds.length = 0;
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('bump increases temperature and access count', async () => {
    const entity = await insertTestMemory({
      name: 'thermal-test-bump-basic',
      temperature: 0.5,
      tier: 'WARM',
      accessCount: 0,
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await getMemory(entity.id);
    expect(after).not.toBeNull();

    // temperature should increase by BUMP_AMOUNT (0.2): 0.5 + 0.2 = 0.7
    expect(after!.temperature).toBeCloseTo(0.5 + BUMP_AMOUNT, 2);

    // access count should be incremented
    expect(after!.accessCount).toBe(1);

    // tier should be recomputed based on new temperature
    const expectedTier = computeTier(0.5 + BUMP_AMOUNT);
    expect(after!.tier).toBe(expectedTier);
  });

  it('bump is capped at 1.0', async () => {
    const entity = await insertTestMemory({
      name: 'thermal-test-bump-cap',
      temperature: 0.9,
      tier: 'HOT',
      accessCount: 0,
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await getMemory(entity.id);
    expect(after).not.toBeNull();

    // 0.9 + 0.2 = 1.1, capped to 1.0
    expect(after!.temperature).toBeCloseTo(1.0, 2);
    expect(after!.tier).toBe('HOT');
  });

  it('tier is recomputed correctly after bump', async () => {
    // Start at 0.55 (WARM), bump should bring it to 0.75 (HOT)
    const entity = await insertTestMemory({
      name: 'thermal-test-tier-recompute',
      temperature: 0.55,
      tier: 'WARM',
      accessCount: 0,
    });
    createdIds.push(entity.id);

    // Verify starting tier
    expect(computeTier(0.55)).toBe('WARM');

    await bump(entity.id);

    const after = await getMemory(entity.id);
    expect(after).not.toBeNull();

    // 0.55 + 0.2 = 0.75 which is > 0.7 → HOT
    expect(after!.temperature).toBeCloseTo(0.75, 2);
    expect(after!.tier).toBe('HOT');
  });
});
