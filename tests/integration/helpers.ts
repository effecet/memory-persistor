/**
 * Shared helpers for integration tests.
 * Tests run against the real Docker Postgres instance.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { entities, memoryRelations } from '../../src/schema.js';
import * as schema from '../../src/schema.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const testDb = drizzle(pool, { schema });

/**
 * Insert a test memory and return it. Caller is responsible for cleanup.
 */
export async function insertTestMemory(overrides: Partial<{
  name: string;
  type: string;
  observations: string | null;
  tags: string[];
  source: string;
  importance: number;
  temperature: number;
  tier: string;
  accessCount: number;
}> = {}) {
  const [entity] = await testDb
    .insert(entities)
    .values({
      name: overrides.name ?? `test-memory-${Date.now()}`,
      type: overrides.type ?? 'fact',
      observations: overrides.observations ?? 'test observation content',
      tags: overrides.tags ?? ['test'],
      source: overrides.source ?? '/tmp/test-project',
      importance: overrides.importance ?? 0.5,
      temperature: overrides.temperature ?? 1.0,
      tier: overrides.tier ?? 'HOT',
      accessCount: overrides.accessCount ?? 0,
    })
    .returning();

  return entity;
}

/**
 * Insert a test relation between two entities.
 */
export async function insertTestRelation(
  fromId: string,
  toId: string,
  relationType = 'related_to',
  weight = 1.0,
) {
  const [relation] = await testDb
    .insert(memoryRelations)
    .values({ fromId, toId, relationType, weight })
    .returning();

  return relation;
}

/**
 * Delete a test memory and its relations by ID.
 */
export async function cleanupMemory(id: string): Promise<void> {
  await testDb.delete(entities).where(eq(entities.id, id));
}

/**
 * Delete multiple test memories.
 */
export async function cleanupMemories(ids: string[]): Promise<void> {
  for (const id of ids) {
    await testDb.delete(entities).where(eq(entities.id, id));
  }
}

/**
 * Get a memory by ID.
 */
export async function getMemory(id: string) {
  const [entity] = await testDb
    .select()
    .from(entities)
    .where(eq(entities.id, id))
    .limit(1);
  return entity ?? null;
}

/**
 * Get all relations for a memory (bidirectional).
 */
export async function getRelations(id: string) {
  const result = await testDb.execute(sql`
    SELECT r.id, r.from_id, r.to_id, r.relation_type, r.weight
    FROM public.memory_relations r
    WHERE r.from_id = ${id} OR r.to_id = ${id}
  `);
  return result.rows;
}

/**
 * Close the test database pool.
 */
export async function closeTestDb(): Promise<void> {
  await pool.end();
}

/**
 * Find a pair in a list by matching two ids in either order.
 * Used by dedup-pair tests that can't rely on a fixed a/b ordering
 * (the SQL picks a canonical order via a.id < b.id, which is random).
 */
export function findPair<T extends { aId: string; bId: string }>(
  pairs: T[],
  id1: string,
  id2: string,
): T | undefined {
  return pairs.find(
    (p) =>
      (p.aId === id1 && p.bId === id2) || (p.aId === id2 && p.bId === id1),
  );
}
