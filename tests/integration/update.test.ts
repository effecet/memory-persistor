/**
 * Integration tests for the update operation.
 * Tests partial field updates, temperature bumps, and field preservation.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { entities } from '../../src/schema.js';
import { eq } from 'drizzle-orm';
import { bump } from '../../src/thermal.js';
import {
  testDb,
  insertTestMemory,
  cleanupMemories,
  getMemory,
  closeTestDb,
} from './helpers.js';

describe('update', () => {
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

  it('updates specified fields only', async () => {
    const entity = await insertTestMemory({
      name: 'update-fields-original',
      type: 'fact',
      observations: 'original observations',
      tags: ['original'],
      importance: 0.6,
    });
    createdIds.push(entity.id);

    await testDb
      .update(entities)
      .set({ name: 'update-fields-modified' })
      .where(eq(entities.id, entity.id));

    const stored = await getMemory(entity.id);

    expect(stored).not.toBeNull();
    expect(stored.name).toBe('update-fields-modified');
    // Untouched fields remain the same
    expect(stored.observations).toBe('original observations');
    expect(stored.tags).toEqual(['original']);
    expect(stored.importance).toBeCloseTo(0.6);
  });

  it('bumps temperature after update', async () => {
    const entity = await insertTestMemory({
      name: 'update-bump-temp',
      type: 'fact',
      temperature: 0.5,
      tier: 'WARM',
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const stored = await getMemory(entity.id);

    expect(stored).not.toBeNull();
    // BUMP_AMOUNT is 0.2, so 0.5 + 0.2 = 0.7
    expect(stored.temperature).toBeCloseTo(0.7, 1);
  });

  it('returns updated entity with correct fields', async () => {
    const entity = await insertTestMemory({
      name: 'update-return-check',
      type: 'decision',
      observations: 'before update',
    });
    createdIds.push(entity.id);

    const [updated] = await testDb
      .update(entities)
      .set({ observations: 'after update' })
      .where(eq(entities.id, entity.id))
      .returning();

    expect(updated).toBeDefined();
    expect(updated.observations).toBe('after update');
    expect(updated.name).toBe('update-return-check');
    expect(updated.type).toBe('decision');
  });

  it('preserves non-updated fields', async () => {
    const entity = await insertTestMemory({
      name: 'update-preserve-fields',
      type: 'pattern',
      observations: 'should stay the same',
      tags: ['alpha'],
      importance: 0.9,
    });
    createdIds.push(entity.id);

    await testDb
      .update(entities)
      .set({ tags: ['alpha', 'beta'] })
      .where(eq(entities.id, entity.id));

    const stored = await getMemory(entity.id);

    expect(stored).not.toBeNull();
    expect(stored.tags).toEqual(['alpha', 'beta']);
    // Non-updated fields are unchanged
    expect(stored.name).toBe('update-preserve-fields');
    expect(stored.observations).toBe('should stay the same');
    expect(stored.importance).toBeCloseTo(0.9);
  });
});
