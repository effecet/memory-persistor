/**
 * Phase 3 TDD tests: Adaptive Thermal Model (integration tests).
 *
 * Tests cascade bumps, access bitmap, pattern-aware decay, and
 * auto-importance drift against a real Postgres database.
 *
 * Expected to FAIL until Phase 3 implementation is complete.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { bump, decayAll } from '../../src/thermal.js';
import { BUMP_AMOUNT, DECAY_RATE } from '../../src/config.js';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  getMemory,
  closeTestDb,
} from './helpers.js';
import { entities } from '../../src/schema.js';
import { eq, sql } from 'drizzle-orm';

const PREFIX = 'v3-thermal-';
const createdIds: string[] = [];

afterAll(async () => {
  await cleanupMemories(createdIds);
  await closeTestDb();
});

// ── Cascade bumps ────────────────────────────────────────────────────────

describe('cascade bumps', () => {
  afterEach(async () => {
    await cleanupMemories([...createdIds]);
    createdIds.length = 0;
  });

  it('bumping a memory also bumps direct neighbors', async () => {
    const center = await insertTestMemory({
      name: `${PREFIX}cascade center`,
      temperature: 0.5,
      tier: 'WARM',
    });
    createdIds.push(center.id);

    const neighbor = await insertTestMemory({
      name: `${PREFIX}cascade neighbor`,
      temperature: 0.4,
      tier: 'WARM',
    });
    createdIds.push(neighbor.id);

    // Unrelated memory (no edge) — should NOT be affected
    const bystander = await insertTestMemory({
      name: `${PREFIX}cascade bystander`,
      temperature: 0.4,
      tier: 'WARM',
    });
    createdIds.push(bystander.id);

    // Connect center <-> neighbor
    await insertTestRelation(center.id, neighbor.id, 'related_to');

    await bump(center.id);

    // Center should get full bump
    const centerAfter = await getMemory(center.id);
    expect(centerAfter!.temperature).toBeCloseTo(0.5 + BUMP_AMOUNT, 1);

    // Neighbor should get cascade bump (half strength × edge weight)
    const neighborAfter = await getMemory(neighbor.id);
    expect(neighborAfter!.temperature!).toBeGreaterThan(0.4);
    expect(neighborAfter!.temperature!).toBeLessThan(0.4 + BUMP_AMOUNT); // less than full bump

    // Bystander should be unchanged
    const bystanderAfter = await getMemory(bystander.id);
    expect(bystanderAfter!.temperature).toBeCloseTo(0.4, 2);
  });

  it('cascade bump respects edge weight', async () => {
    const center = await insertTestMemory({
      name: `${PREFIX}cascade-weight center`,
      temperature: 0.5,
      tier: 'WARM',
    });
    createdIds.push(center.id);

    const strongNeighbor = await insertTestMemory({
      name: `${PREFIX}cascade-weight strong`,
      temperature: 0.4,
      tier: 'WARM',
    });
    createdIds.push(strongNeighbor.id);

    const weakNeighbor = await insertTestMemory({
      name: `${PREFIX}cascade-weight weak`,
      temperature: 0.4,
      tier: 'WARM',
    });
    createdIds.push(weakNeighbor.id);

    await insertTestRelation(center.id, strongNeighbor.id, 'related_to', 1.0);
    await insertTestRelation(center.id, weakNeighbor.id, 'related_to', 0.3);

    await bump(center.id);

    const strongAfter = await getMemory(strongNeighbor.id);
    const weakAfter = await getMemory(weakNeighbor.id);

    // Both should increase, but strong neighbor more than weak
    expect(strongAfter!.temperature!).toBeGreaterThan(weakAfter!.temperature!);
  });

  it('cascade bump is capped at 1.0 for neighbors', async () => {
    const center = await insertTestMemory({
      name: `${PREFIX}cascade-cap center`,
      temperature: 0.5,
      tier: 'WARM',
    });
    createdIds.push(center.id);

    const hotNeighbor = await insertTestMemory({
      name: `${PREFIX}cascade-cap neighbor`,
      temperature: 0.99,
      tier: 'HOT',
    });
    createdIds.push(hotNeighbor.id);

    await insertTestRelation(center.id, hotNeighbor.id, 'related_to');

    await bump(center.id);

    const neighborAfter = await getMemory(hotNeighbor.id);
    expect(neighborAfter!.temperature!).toBeLessThanOrEqual(1.0);
  });
});

// ── Access bitmap ────────────────────────────────────────────────────────

describe('access bitmap', () => {
  afterEach(async () => {
    await cleanupMemories([...createdIds]);
    createdIds.length = 0;
  });

  it('bump sets the current day-of-week bit in access_bitmap', async () => {
    const mem = await insertTestMemory({
      name: `${PREFIX}bitmap-set`,
      temperature: 0.5,
      tier: 'WARM',
    });
    createdIds.push(mem.id);

    await bump(mem.id);

    const after = await getMemory(mem.id);
    // access_bitmap should have at least one bit set
    expect(after!.accessBitmap).not.toBeNull();
    expect(after!.accessBitmap!).toBeGreaterThan(0);
  });

  it('bitmap accumulates bits across different accesses', async () => {
    const mem = await insertTestMemory({
      name: `${PREFIX}bitmap-accumulate`,
      temperature: 0.5,
      tier: 'WARM',
    });
    createdIds.push(mem.id);

    // Set a known initial bitmap (Mon+Wed = bits 1,3 = 0b0001010 = 10)
    await testDb
      .update(entities)
      .set({ accessBitmap: 0b0001010 })
      .where(eq(entities.id, mem.id));

    await bump(mem.id);

    const after = await getMemory(mem.id);
    // Should have the original bits PLUS the current day-of-week bit
    // At minimum: original 2 bits should still be present
    expect(after!.accessBitmap! & 0b0001010).toBe(0b0001010);
  });
});

// ── Pattern-aware decay ──────────────────────────────────────────────────

describe('pattern-aware decay', () => {
  afterEach(async () => {
    await cleanupMemories([...createdIds]);
    createdIds.length = 0;
  });

  it('regular access pattern (3+ days) slows decay', async () => {
    // Memory with regular pattern (Mon/Wed/Fri = 3 bits)
    const regular = await insertTestMemory({
      name: `${PREFIX}pattern-regular`,
      temperature: 0.6,
      tier: 'WARM',
    });
    createdIds.push(regular.id);

    // Memory with sporadic access (1 day only)
    const sporadic = await insertTestMemory({
      name: `${PREFIX}pattern-sporadic`,
      temperature: 0.6,
      tier: 'WARM',
    });
    createdIds.push(sporadic.id);

    // Set bitmaps and push last_accessed_at back so decay triggers
    await testDb.execute(sql`
      UPDATE public.entities
      SET access_bitmap = ${0b0010101},
          last_accessed_at = NOW() - INTERVAL '25 hours'
      WHERE id = ${regular.id}
    `);
    await testDb.execute(sql`
      UPDATE public.entities
      SET access_bitmap = ${0b0000001},
          last_accessed_at = NOW() - INTERVAL '25 hours'
      WHERE id = ${sporadic.id}
    `);

    await decayAll();

    const regularAfter = await getMemory(regular.id);
    const sporadicAfter = await getMemory(sporadic.id);

    // Regular pattern decays slower → higher temperature after decay
    expect(regularAfter!.temperature!).toBeGreaterThan(sporadicAfter!.temperature!);
  });
});

// ── Auto-importance drift ────────────────────────────────────────────────

describe('auto-importance drift', () => {
  afterEach(async () => {
    await cleanupMemories([...createdIds]);
    createdIds.length = 0;
  });

  it('importance increases for frequently accessed memories (access_count >= 5)', async () => {
    const mem = await insertTestMemory({
      name: `${PREFIX}importance-up`,
      importance: 0.5,
      temperature: 0.6,
      tier: 'WARM',
    });
    createdIds.push(mem.id);

    // Set access_count >= 5 and push last_accessed back so decay runs on it
    await testDb.execute(sql`
      UPDATE public.entities
      SET access_count = 10,
          last_accessed_at = NOW() - INTERVAL '25 hours'
      WHERE id = ${mem.id}
    `);

    await decayAll();

    const after = await getMemory(mem.id);
    expect(after!.importance!).toBeGreaterThan(0.5);
  });

  it('importance decreases for neglected memories (60+ days)', async () => {
    const mem = await insertTestMemory({
      name: `${PREFIX}importance-down`,
      importance: 0.5,
      temperature: 0.6,
      tier: 'WARM',
    });
    createdIds.push(mem.id);

    // Push last_accessed_at back 61+ days
    await testDb.execute(sql`
      UPDATE public.entities
      SET last_accessed_at = NOW() - INTERVAL '61 days'
      WHERE id = ${mem.id}
    `);

    await decayAll();

    const after = await getMemory(mem.id);
    expect(after!.importance!).toBeLessThan(0.5);
  });

  it('importance is capped at 0.9 and floored at 0.1', async () => {
    // Test cap
    const highMem = await insertTestMemory({
      name: `${PREFIX}importance-cap`,
      importance: 0.88,
      temperature: 0.6,
      tier: 'WARM',
    });
    createdIds.push(highMem.id);

    await testDb.execute(sql`
      UPDATE public.entities
      SET access_count = 100,
          last_accessed_at = NOW() - INTERVAL '25 hours'
      WHERE id = ${highMem.id}
    `);

    // Test floor
    const lowMem = await insertTestMemory({
      name: `${PREFIX}importance-floor`,
      importance: 0.12,
      temperature: 0.6,
      tier: 'WARM',
    });
    createdIds.push(lowMem.id);

    await testDb.execute(sql`
      UPDATE public.entities
      SET last_accessed_at = NOW() - INTERVAL '90 days'
      WHERE id = ${lowMem.id}
    `);

    await decayAll();

    const highAfter = await getMemory(highMem.id);
    expect(highAfter!.importance!).toBeLessThanOrEqual(0.9);

    const lowAfter = await getMemory(lowMem.id);
    expect(lowAfter!.importance!).toBeGreaterThanOrEqual(0.1);
  });
});
