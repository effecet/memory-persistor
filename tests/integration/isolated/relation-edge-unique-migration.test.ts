/**
 * Migration 0017 — collapse duplicate (from, to, type) edges, then index them
 * unique.
 *
 * Lives in isolated/ because it DROPS the unique index to plant duplicates:
 * database-wide state that would let any concurrently running file write a
 * duplicate. The migration recreates the index; `afterAll` re-runs it so a
 * failure mid-test cannot leave the database without one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  closeTestDb,
} from '../helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration = readFileSync(resolve(repoRoot, 'drizzle/0017_relation_edge_unique.sql'), 'utf-8');
const created: string[] = [];
let guardPassed = false;

beforeAll(async () => {
  // A hand-run `vitest run tests/integration/` includes this directory; never
  // drop the index or run the table-wide DELETE outside a throwaway database.
  const { rows } = await testDb.execute(sql`SELECT current_database() AS db`);
  const db = (rows[0] as { db: string }).db;
  if (!/_(test|isolated)$/.test(db)) {
    throw new Error(`refusing to run migration 0017 tests against database "${db}"`);
  }
  guardPassed = true;
});

afterAll(async () => {
  // vitest runs afterAll even when beforeAll threw: never undo the guard here.
  if (guardPassed) await testDb.execute(sql.raw(migration));
  await cleanupMemories(created);
  await closeTestDb();
});

async function edgeRows(fromId: string) {
  return (await testDb.execute(sql`
    SELECT to_id::text, relation_type, provenance, weight FROM public.memory_relations
    WHERE from_id = ${fromId} ORDER BY relation_type, to_id
  `)).rows as { to_id: string; relation_type: string; provenance: string; weight: number }[];
}

describe('0017_relation_edge_unique', () => {
  it('keeps the asserted, then heavier, row of each duplicate and leaves distinct edges alone', async () => {
    const a = await insertTestMemory({ name: '0017 a', type: 'fact' });
    const b = await insertTestMemory({ name: '0017 b', type: 'fact' });
    const c = await insertTestMemory({ name: '0017 c', type: 'fact' });
    created.push(a.id, b.id, c.id);

    // No IF EXISTS on purpose: a database reset without 0017 should fail here.
    await testDb.execute(sql`DROP INDEX public.memory_relations_edge_unique`);
    // Asserted written second: keeping the oldest would wrongly pick the guess.
    await insertTestRelation(a.id, b.id, 'related_to', 0.9, 'inferred');
    await insertTestRelation(a.id, b.id, 'related_to', 0.4, 'asserted');
    // Same provenance: the heavier row survives, whatever its age.
    await insertTestRelation(a.id, c.id, 'elaborates', 0.2, 'inferred');
    await insertTestRelation(a.id, c.id, 'elaborates', 0.7, 'inferred');
    // Distinct edges between the same pair: a different type, the reverse direction.
    await insertTestRelation(a.id, b.id, 'depends_on', 1.0, 'inferred');
    await insertTestRelation(b.id, a.id, 'related_to', 1.0, 'inferred');

    await testDb.execute(sql.raw(migration));

    const fromA = await edgeRows(a.id);
    expect(fromA.map((r) => [r.to_id, r.relation_type, r.provenance, Number(r.weight).toFixed(1)])).toEqual(
      [
        [b.id, 'depends_on', 'inferred', '1.0'],
        [c.id, 'elaborates', 'inferred', '0.7'],
        [b.id, 'related_to', 'asserted', '0.4'],
      ],
    );
    expect(await edgeRows(b.id)).toHaveLength(1);
  });

  it('breaks a provenance-and-weight tie by keeping the oldest row', async () => {
    // The common production case: 30 of the 31 groups differed only in age.
    const a = await insertTestMemory({ name: '0017 age a', type: 'fact' });
    const b = await insertTestMemory({ name: '0017 age b', type: 'fact' });
    created.push(a.id, b.id);

    await testDb.execute(sql`DROP INDEX public.memory_relations_edge_unique`);
    const ins = (createdAt: string) => testDb.execute(sql`
      INSERT INTO public.memory_relations (from_id, to_id, relation_type, provenance, created_at)
      VALUES (${a.id}, ${b.id}, 'related_to', 'inferred', ${createdAt}::timestamptz)
      RETURNING id::text
    `);
    // Newer row inserted first, so physical order cannot pick the right one.
    await ins('2026-02-01T00:00:00Z');
    const older = ((await ins('2026-01-01T00:00:00Z')).rows[0] as { id: string }).id;

    await testDb.execute(sql.raw(migration));

    const left = (await testDb.execute(sql`
      SELECT id::text FROM public.memory_relations WHERE from_id = ${a.id}
    `)).rows as { id: string }[];
    expect(left).toEqual([{ id: older }]);
  });

  it('is idempotent and leaves the unique index in place', async () => {
    await testDb.execute(sql.raw(migration));
    const idx = await testDb.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'memory_relations_edge_unique'
    `);
    expect(idx.rows).toHaveLength(1);
    expect(String(idx.rows[0].indexdef)).toMatch(/UNIQUE INDEX .* \(from_id, to_id, relation_type\)/);
  });
});
