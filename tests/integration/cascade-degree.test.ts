/**
 * The cascade term in bump() divides by the bumped row's total degree (percentile tiering
 * Task 5), so a hub with many neighbours cannot broadcast the same fixed
 * amount of heat to each of them — the total heat spread stays bounded
 * regardless of connectivity.
 *
 * Never `DELETE FROM public.entities` or `public.memory_relations` wholesale
 * — the integration database is shared across suites. Seed via
 * insertTestMemory/insertTestRelation and clean up only owned ids via
 * cleanupMemories. The two hubs in this file use disjoint id sets rather than
 * wiping between them, so they can coexist with whatever else is in the DB.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  closeTestDb,
} from './helpers.js';
import { bump } from '../../src/thermal.js';

const PREFIX = 'cascade-degree-';
const createdIds: string[] = [];

afterAll(async () => {
  if (createdIds.length > 0) {
    await cleanupMemories([...createdIds]);
    createdIds.length = 0;
  }
  await closeTestDb();
});

/**
 * Create a hub entity with `degree` neighbours, each connected by a
 * related_to edge of weight 1.0. Returns the hub id and the neighbour ids
 * (both tracked in `createdIds` for cleanup).
 */
async function makeHub(degree: number): Promise<{ hubId: string; neighbourIds: string[] }> {
  const hub = await insertTestMemory({
    name: `${PREFIX}hub-${degree}`,
    temperature: 0.0,
  });
  createdIds.push(hub.id);

  const neighbourIds: string[] = [];
  for (let i = 0; i < degree; i++) {
    const n = await insertTestMemory({
      name: `${PREFIX}n${i}-of-${degree}`,
      temperature: 0.0,
    });
    createdIds.push(n.id);
    neighbourIds.push(n.id);
    await insertTestRelation(hub.id, n.id, 'related_to', 1.0);
  }

  return { hubId: hub.id, neighbourIds };
}

/** Sum temperature across exactly the given (own, seeded) ids. */
async function totalHeat(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await testDb.execute(
    sql`SELECT COALESCE(SUM(temperature), 0)::float8 AS s FROM public.entities WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
  );
  return Number((r.rows[0] as { s: number | string }).s);
}

describe('cascade is bounded independent of degree', () => {
  it('spreads the same total heat to 4 neighbours as to 40', async () => {
    const small = await makeHub(4);
    await bump(small.hubId);
    const heatSmall = await totalHeat(small.neighbourIds);

    const big = await makeHub(40);
    await bump(big.hubId);
    const heatBig = await totalHeat(big.neighbourIds);

    expect(heatBig).toBeCloseTo(heatSmall, 4);
  });

  it('gives each neighbour of a 40-degree hub a tenth of what a 4-degree hub gives', async () => {
    const big = await makeHub(40);
    await bump(big.hubId);
    const r = await testDb.execute(
      sql`SELECT MAX(temperature)::float8 AS m FROM public.entities WHERE id IN (${sql.join(big.neighbourIds.map((id) => sql`${id}`), sql`, `)})`,
    );
    // BUMP_AMOUNT 0.2 * CASCADE_FACTOR 0.5 * weight 1.0 / degree 40 = 0.0025
    expect(Number((r.rows[0] as { m: number | string }).m)).toBeCloseTo(0.0025, 6);
  });

  it('bumping a zero-degree row succeeds without touching any cascade rows', async () => {
    const solo = await insertTestMemory({
      name: `${PREFIX}solo`,
      temperature: 0.0,
    });
    createdIds.push(solo.id);

    await expect(bump(solo.id)).resolves.toBeUndefined();

    const after = await testDb.execute(
      sql`SELECT temperature FROM public.entities WHERE id = ${solo.id}`,
    );
    expect(Number((after.rows[0] as { temperature: number | string }).temperature)).toBeCloseTo(0.2, 6);
  });
});
