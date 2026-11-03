/**
 * Integration tests for relation (edge) creation.
 * Tests correct field storage, bidirectional fetch, and custom weights.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { connectHarness, parseOk, parseErrorResult, type Harness } from './mcp-harness.js';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  getRelations,
  closeTestDb,
} from './helpers.js';

const createdIds: string[] = [];

afterEach(async () => {
  if (createdIds.length > 0) {
    await cleanupMemories([...createdIds]);
    createdIds.length = 0;
  }
});

// One pool for the file: closing it in a describe's afterAll would strand the next block.
afterAll(async () => {
  await closeTestDb();
});

describe('relate', () => {
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

/** The write-path guards, driven through a real MCP client so the handler is what is tested. */
describe('relate tool guards', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await connectHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('rejects a self-loop as a validation error and writes nothing', async () => {
    const m = await insertTestMemory({ name: 'relate-guard-self', type: 'fact' });
    createdIds.push(m.id);

    const e = parseErrorResult(await h.client.callTool({
      name: 'relate',
      arguments: { fromId: m.id, toId: m.id, relationType: 'supersedes' },
    }));

    expect(e.errorCategory).toBe('validation');
    expect(await getRelations(m.id)).toEqual([]);
  });

  it('rejects a self-loop whose ids differ only in case', async () => {
    const m = await insertTestMemory({ name: 'relate-guard-self-case', type: 'fact' });
    createdIds.push(m.id);

    const e = parseErrorResult(await h.client.callTool({
      name: 'relate',
      arguments: { fromId: m.id.toLowerCase(), toId: m.id.toUpperCase(), relationType: 'related_to' },
    }));

    expect(e.errorCategory).toBe('validation');
    expect(await getRelations(m.id)).toEqual([]);
  });

  it('a repeated relate returns the existing edge instead of writing a duplicate', async () => {
    const a = await insertTestMemory({ name: 'relate-guard-dup-a', type: 'fact' });
    const b = await insertTestMemory({ name: 'relate-guard-dup-b', type: 'fact' });
    createdIds.push(a.id, b.id);

    const args = { fromId: a.id, toId: b.id, relationType: 'related_to' };
    const first = parseOk(await h.client.callTool({ name: 'relate', arguments: args }));
    // Checked before the repeat, which would upgrade an inferred insert and hide it.
    expect((await getRelations(a.id)).map((r) => r.provenance)).toEqual(['asserted']);
    const second = parseOk(await h.client.callTool({ name: 'relate', arguments: args }));

    expect(second.id).toBe(first.id);
    expect(second.existing).toBe(true);
    expect(first.existing).toBe(false);
    expect(await getRelations(a.id)).toHaveLength(1);
  });

  it('dedupes on both endpoints: a shared from or to is a new edge', async () => {
    const a = await insertTestMemory({ name: 'relate-guard-ends-a', type: 'fact' });
    const b = await insertTestMemory({ name: 'relate-guard-ends-b', type: 'fact' });
    const c = await insertTestMemory({ name: 'relate-guard-ends-c', type: 'fact' });
    createdIds.push(a.id, b.id, c.id);

    const relate = async (fromId: string, toId: string) =>
      parseOk(await h.client.callTool({ name: 'relate', arguments: { fromId, toId, relationType: 'related_to', weight: 0.4 } }));
    const ab = await relate(a.id, b.id);
    const ac = await relate(a.id, c.id);
    const cb = await relate(c.id, b.id);

    expect(new Set([ab.id, ac.id, cb.id]).size).toBe(3);
    expect([ab.existing, ac.existing, cb.existing]).toEqual([false, false, false]);
    const abRow = (await getRelations(a.id)).find((r) => r.id === ab.id);
    expect(abRow?.to_id).toBe(b.id);
  });

  it('a repeat without weight keeps the stored weight', async () => {
    const a = await insertTestMemory({ name: 'relate-guard-keepw-a', type: 'fact' });
    const b = await insertTestMemory({ name: 'relate-guard-keepw-b', type: 'fact' });
    createdIds.push(a.id, b.id);

    const args = { fromId: a.id, toId: b.id, relationType: 'elaborates' };
    parseOk(await h.client.callTool({ name: 'relate', arguments: { ...args, weight: 0.3 } }));
    parseOk(await h.client.callTool({ name: 'relate', arguments: args }));

    const rows = await getRelations(a.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].weight)).toBeCloseTo(0.3);
  });

  it('a different relation type between the same pair is a new edge', async () => {
    const a = await insertTestMemory({ name: 'relate-guard-type-a', type: 'fact' });
    const b = await insertTestMemory({ name: 'relate-guard-type-b', type: 'fact' });
    createdIds.push(a.id, b.id);

    parseOk(await h.client.callTool({ name: 'relate', arguments: { fromId: a.id, toId: b.id, relationType: 'related_to' } }));
    parseOk(await h.client.callTool({ name: 'relate', arguments: { fromId: a.id, toId: b.id, relationType: 'elaborates' } }));

    expect(await getRelations(a.id)).toHaveLength(2);
  });

  it('relating over an inferred edge upgrades it to asserted and takes the new weight', async () => {
    const a = await insertTestMemory({ name: 'relate-guard-upgrade-a', type: 'fact' });
    const b = await insertTestMemory({ name: 'relate-guard-upgrade-b', type: 'fact' });
    createdIds.push(a.id, b.id);
    const inferred = await insertTestRelation(a.id, b.id, 'related_to', 0.3, 'inferred');

    const r = parseOk(await h.client.callTool({
      name: 'relate',
      arguments: { fromId: a.id, toId: b.id, relationType: 'related_to', weight: 0.9 },
    }));

    expect(r.id).toBe(inferred.id);
    const rows = await getRelations(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].provenance).toBe('asserted');
    expect(Number(rows[0].weight)).toBeCloseTo(0.9);
  });

  it('concurrent identical relates leave one row and report the same edge', async () => {
    const a = await insertTestMemory({ name: 'relate-guard-race-a', type: 'fact' });
    const b = await insertTestMemory({ name: 'relate-guard-race-b', type: 'fact' });
    createdIds.push(a.id, b.id);

    const args = { fromId: a.id, toId: b.id, relationType: 'depends_on' };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.client.callTool({ name: 'relate', arguments: args })),
    );
    const parsed = results.map((r) => parseOk(r));

    expect(await getRelations(a.id)).toHaveLength(1);
    expect(new Set(parsed.map((p) => p.id)).size).toBe(1);
    // Exactly one call inserted; every other one found the edge.
    expect(parsed.filter((p) => p.existing === false)).toHaveLength(1);
  });

  it('the unique index rejects a duplicate edge written around the tool', async () => {
    const a = await insertTestMemory({ name: 'relate-guard-index-a', type: 'fact' });
    const b = await insertTestMemory({ name: 'relate-guard-index-b', type: 'fact' });
    createdIds.push(a.id, b.id);
    await insertTestRelation(a.id, b.id, 'related_to');

    const err = await insertTestRelation(a.id, b.id, 'related_to', 0.5, 'asserted')
      .then(() => null, (e: unknown) => e as { cause?: { code?: string; constraint?: string } });
    // Read the cause: an FK or syntax failure must not satisfy this test.
    expect(err?.cause?.code).toBe('23505');
    expect(err?.cause?.constraint).toBe('memory_relations_edge_unique');
  });
});
