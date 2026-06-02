/**
 * Integration tests for relation (edge) creation.
 * Tests correct field storage, bidirectional fetch, and custom weights.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  getRelations,
  closeTestDb,
} from './helpers.js';

describe('relate', () => {
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

  it('creates edge with correct from/to/type/weight', async () => {
    const memoryA = await insertTestMemory({
      name: 'relate-edge-a',
      type: 'fact',
      observations: 'Source node',
    });
    createdIds.push(memoryA.id);

    const memoryB = await insertTestMemory({
      name: 'relate-edge-b',
      type: 'fact',
      observations: 'Target node',
    });
    createdIds.push(memoryB.id);

    const relation = await insertTestRelation(
      memoryA.id,
      memoryB.id,
      'depends_on',
      1.0,
    );

    expect(relation).toBeDefined();
    expect(relation.fromId).toBe(memoryA.id);
    expect(relation.toId).toBe(memoryB.id);
    expect(relation.relationType).toBe('depends_on');
    expect(relation.weight).toBeCloseTo(1.0);
    expect(relation.id).toBeDefined();
    expect(relation.createdAt).toBeInstanceOf(Date);
  });

  it('bidirectional relation fetch', async () => {
    const memoryA = await insertTestMemory({
      name: 'relate-bidir-a',
      type: 'decision',
      observations: 'Node A for bidirectional test',
    });
    createdIds.push(memoryA.id);

    const memoryB = await insertTestMemory({
      name: 'relate-bidir-b',
      type: 'decision',
      observations: 'Node B for bidirectional test',
    });
    createdIds.push(memoryB.id);

    await insertTestRelation(memoryA.id, memoryB.id, 'related_to', 1.0);

    // getRelations queries WHERE from_id = id OR to_id = id
    const relationsFromA = await getRelations(memoryA.id);
    const relationsFromB = await getRelations(memoryB.id);

    expect(relationsFromA.length).toBeGreaterThanOrEqual(1);
    expect(relationsFromB.length).toBeGreaterThanOrEqual(1);

    // Both should find the same edge
    const edgeFromA = relationsFromA.find(
      (r: any) => r.from_id === memoryA.id && r.to_id === memoryB.id,
    );
    const edgeFromB = relationsFromB.find(
      (r: any) => r.from_id === memoryA.id && r.to_id === memoryB.id,
    );

    expect(edgeFromA).toBeDefined();
    expect(edgeFromB).toBeDefined();
    expect(edgeFromA.id).toBe(edgeFromB.id);
  });

  it('supports custom weight', async () => {
    const memoryA = await insertTestMemory({
      name: 'relate-weight-a',
      type: 'pattern',
      observations: 'Custom weight source',
    });
    createdIds.push(memoryA.id);

    const memoryB = await insertTestMemory({
      name: 'relate-weight-b',
      type: 'pattern',
      observations: 'Custom weight target',
    });
    createdIds.push(memoryB.id);

    const relation = await insertTestRelation(
      memoryA.id,
      memoryB.id,
      'related_to',
      0.5,
    );

    expect(relation.weight).toBeCloseTo(0.5);

    // Also verify via getRelations raw query
    const relations = await getRelations(memoryA.id);
    const edge = relations.find((r: any) => r.id === relation.id);
    expect(edge).toBeDefined();
    expect(parseFloat(edge.weight)).toBeCloseTo(0.5);
  });
});
