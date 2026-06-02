/**
 * Integration tests for the forget (delete) operation.
 * Tests cascade behavior, cleanup, and graceful handling of missing entities.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { entities } from '../../src/schema.js';
import { eq } from 'drizzle-orm';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemory,
  cleanupMemories,
  getMemory,
  getRelations,
  closeTestDb,
} from './helpers.js';

describe('forget', () => {
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

  it('deletes entity from database', async () => {
    const entity = await insertTestMemory({
      name: 'forget-delete-entity',
      type: 'fact',
      observations: 'This memory should be deleted',
    });
    // Do not push to createdIds — we delete it ourselves

    await testDb.delete(entities).where(eq(entities.id, entity.id));

    const stored = await getMemory(entity.id);
    expect(stored).toBeNull();
  });

  it('cascades deletion to memory_relations', async () => {
    const memoryA = await insertTestMemory({
      name: 'forget-cascade-a',
      type: 'fact',
      observations: 'Memory A for cascade test',
    });

    const memoryB = await insertTestMemory({
      name: 'forget-cascade-b',
      type: 'fact',
      observations: 'Memory B for cascade test',
    });
    createdIds.push(memoryB.id);

    await insertTestRelation(memoryA.id, memoryB.id, 'related_to', 1.0);

    // Verify relation exists before deletion
    const beforeRelations = await getRelations(memoryB.id);
    expect(beforeRelations.length).toBe(1);

    // Delete memoryA — relation should cascade
    await testDb.delete(entities).where(eq(entities.id, memoryA.id));

    const afterRelations = await getRelations(memoryB.id);
    expect(afterRelations.length).toBe(0);

    // memoryA should be gone
    const stored = await getMemory(memoryA.id);
    expect(stored).toBeNull();
  });

  it('handles deleting non-existent entity gracefully', async () => {
    const fakeId = randomUUID();

    // Should not throw
    await expect(
      testDb.delete(entities).where(eq(entities.id, fakeId)),
    ).resolves.not.toThrow();
  });
});
