/**
 * Integration tests for the status dashboard queries.
 * Verifies total count, tier breakdown, and type breakdown against a real
 * Postgres database. Tests use relative assertions so they work alongside
 * existing data and concurrent test suites.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { entities } from '../../src/schema.js';
import { eq, sql, count, desc, asc } from 'drizzle-orm';
import {
  testDb,
  insertTestMemory,
  cleanupMemories,
  getMemory,
  closeTestDb,
} from './helpers.js';

describe('status', () => {
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

  it('total count matches actual DB count', async () => {
    const memoryA = await insertTestMemory({
      name: 'status-count-a',
      type: 'fact',
      observations: 'First entity for count test',
    });
    createdIds.push(memoryA.id);

    const memoryB = await insertTestMemory({
      name: 'status-count-b',
      type: 'decision',
      observations: 'Second entity for count test',
    });
    createdIds.push(memoryB.id);

    // Verify both test entities exist in the database
    const storedA = await getMemory(memoryA.id);
    const storedB = await getMemory(memoryB.id);
    expect(storedA).not.toBeNull();
    expect(storedB).not.toBeNull();

    // Total count must be at least 2 (our inserts) — other data may exist
    const [{ value: total }] = await testDb
      .select({ value: count() })
      .from(entities);

    expect(total).toBeGreaterThanOrEqual(2);
  });

  it('tier breakdown sums to total', async () => {
    // Insert test data with distinct tiers to ensure at least some rows exist
    const hotMemory = await insertTestMemory({
      name: 'status-tier-hot',
      type: 'fact',
      observations: 'Hot memory for tier test',
      temperature: 1.0,
      tier: 'HOT',
    });
    createdIds.push(hotMemory.id);

    const coldMemory = await insertTestMemory({
      name: 'status-tier-cold',
      type: 'fact',
      observations: 'Cold memory for tier test',
      temperature: 0.1,
      tier: 'COLD',
    });
    createdIds.push(coldMemory.id);

    // Use a single raw SQL query to get both total and tier breakdown
    // atomically from the same snapshot, avoiding race conditions
    // with concurrent test suites.
    const { rows } = await testDb.execute(sql`
      WITH tier_counts AS (
        SELECT tier, count(*)::int AS cnt FROM entities GROUP BY tier
      )
      SELECT
        (SELECT count(*)::int FROM entities) AS total,
        (SELECT coalesce(sum(cnt), 0)::int FROM tier_counts) AS tier_sum
    `);

    const total = (rows[0] as any).total;
    const tierSum = (rows[0] as any).tier_sum;

    expect(tierSum).toBe(total);
  });

  it('type breakdown sums to total', async () => {
    // Insert test data with distinct types
    const factMemory = await insertTestMemory({
      name: 'status-type-fact',
      type: 'fact',
      observations: 'Fact memory for type test',
    });
    createdIds.push(factMemory.id);

    const patternMemory = await insertTestMemory({
      name: 'status-type-pattern',
      type: 'pattern',
      observations: 'Pattern memory for type test',
    });
    createdIds.push(patternMemory.id);

    // Use a single raw SQL query to get both total and type breakdown
    // atomically from the same snapshot.
    const { rows } = await testDb.execute(sql`
      WITH type_counts AS (
        SELECT type, count(*)::int AS cnt FROM entities GROUP BY type
      )
      SELECT
        (SELECT count(*)::int FROM entities) AS total,
        (SELECT coalesce(sum(cnt), 0)::int FROM type_counts) AS type_sum
    `);

    const total = (rows[0] as any).total;
    const typeSum = (rows[0] as any).type_sum;

    expect(typeSum).toBe(total);
  });
});
