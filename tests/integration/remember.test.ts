/**
 * Integration tests for the remember tool's core database operations.
 * Tests run against the real Docker Postgres instance via Drizzle ORM.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { entities, memoryRelations } from '../../src/schema.js';
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

describe('remember', () => {
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

  it('creates entity with correct fields', async () => {
    const entity = await insertTestMemory({
      name: 'integration-remember-fields',
      type: 'fact',
      observations: 'Testing that all fields are stored correctly',
      tags: ['test', 'integration'],
      importance: 0.8,
    });
    createdIds.push(entity.id);

    const stored = await getMemory(entity.id);

    expect(stored).not.toBeNull();
    expect(stored.name).toBe('integration-remember-fields');
    expect(stored.type).toBe('fact');
    expect(stored.observations).toBe('Testing that all fields are stored correctly');
    expect(stored.tags).toEqual(['test', 'integration']);
    expect(stored.importance).toBeCloseTo(0.8);
    expect(stored.temperature).toBeCloseTo(1.0);
    expect(stored.tier).toBe('HOT');
    expect(stored.accessCount).toBe(0);
  });

  it('returns entity with id, name, and HOT tier', async () => {
    const entity = await insertTestMemory({
      name: 'integration-remember-shape',
      type: 'decision',
    });
    createdIds.push(entity.id);

    expect(entity.id).toBeDefined();
    expect(typeof entity.id).toBe('string');
    expect(entity.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(entity.name).toBe('integration-remember-shape');
    expect(entity.tier).toBe('HOT');
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.lastAccessedAt).toBeInstanceOf(Date);
  });

  it('stores source as provided value', async () => {
    const customSource = '/home/user/my-project';
    const entity = await insertTestMemory({
      name: 'integration-remember-source-custom',
      source: customSource,
    });
    createdIds.push(entity.id);

    const stored = await getMemory(entity.id);

    expect(stored).not.toBeNull();
    expect(stored.source).toBe(customSource);
  });

  it('stores default source when not provided', async () => {
    const entity = await insertTestMemory({
      name: 'integration-remember-source-default',
    });
    createdIds.push(entity.id);

    const stored = await getMemory(entity.id);

    expect(stored).not.toBeNull();
    // insertTestMemory defaults source to '/tmp/test-project'
    expect(stored.source).toBe('/tmp/test-project');
  });

  it('creates relation when relatedTo is provided', async () => {
    const memoryA = await insertTestMemory({
      name: 'integration-remember-relation-a',
      type: 'fact',
      observations: 'First memory for relation test',
    });
    createdIds.push(memoryA.id);

    const memoryB = await insertTestMemory({
      name: 'integration-remember-relation-b',
      type: 'fact',
      observations: 'Second memory for relation test',
    });
    createdIds.push(memoryB.id);

    const relation = await insertTestRelation(
      memoryA.id,
      memoryB.id,
      'related_to',
      1.0,
    );

    expect(relation).toBeDefined();
    expect(relation.fromId).toBe(memoryA.id);
    expect(relation.toId).toBe(memoryB.id);
    expect(relation.relationType).toBe('related_to');
    expect(relation.weight).toBeCloseTo(1.0);

    // Verify via getRelations that the edge is queryable from either side
    const relationsA = await getRelations(memoryA.id);
    expect(relationsA.length).toBeGreaterThanOrEqual(1);

    const edge = relationsA.find(
      (r: any) => r.from_id === memoryA.id && r.to_id === memoryB.id,
    );
    expect(edge).toBeDefined();
    expect(edge.relation_type).toBe('related_to');
  });
});
