/**
 * Every scoring signal must evaluate within [0,1].
 *
 * Under the old additive model an out-of-range signal merely overpaid. Under
 * `score = relevance × (1 + α·prior)` it corrupts the whole product, so these
 * bounds are load-bearing rather than cosmetic.
 *
 * Each fixture below reproduces a value the pre-fix code actually produced out of
 * range — measured on 2026-09-06, not hypothesised:
 *   - `1 - cosine_distance` spans [-1,1], so an anti-correlated embedded row
 *     scored BELOW an unembedded one (whose NULL COALESCEs to 0).
 *   - `tagMatch` returned 3.0 for an entity tagged ['a','a','a'] matched against
 *     ['a'] — a 0.30 contribution against a 0.10 weight.
 *   - `recency` went negative for a future `last_accessed_at`, and divided by
 *     zero at exactly +1 day, which aborts the entire recall rather than
 *     degrading one row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq, type SQL } from 'drizzle-orm';
import {
  semanticExpr,
  tagMatchExpr,
  PRIOR_SQL,
  recall,
  RECENCY_EXPR,
  TEMPERATURE_EXPR,
  IMPORTANCE_EXPR,
  ACCESS_FREQ_EXPR,
  CENTRALITY_NORM_EXPR,
} from '../../src/retrieve.js';
import { PRIOR_WEIGHTS } from '../../src/config.js';
import { testDb, insertTestMemory, cleanupMemories, closeTestDb } from './helpers.js';
import { entities } from '../../src/schema.js';

const PREFIX = 'bounds-';
const createdIds: string[] = [];

/** 384-d unit vector; the negation of one is perfectly anti-correlated with it. */
function unitVector(sign: number): number[] {
  return Array.from({ length: 384 }, (_, i) => (i === 0 ? sign : 0));
}

async function scalar(expr: SQL, id: string): Promise<number> {
  const r = await testDb.execute(
    sql`SELECT (${expr}) AS v FROM public.entities e WHERE e.id = ${id}`,
  );
  return Number((r.rows[0] as { v: string | number }).v);
}

describe('scoring signal bounds', () => {
  let antiId: string;
  let dupTagId: string;
  let futureId: string;
  let exactlyOneDayId: string;

  beforeAll(async () => {
    const anti = await insertTestMemory({
      name: `${PREFIX}anti correlated`,
      observations: 'anti correlated embedding',
      embedding: unitVector(1),
    });
    antiId = anti.id;
    createdIds.push(anti.id);

    const dup = await insertTestMemory({
      name: `${PREFIX}duplicate tags`,
      observations: 'duplicate tags',
      tags: ['alpha', 'alpha', 'alpha'],
    });
    dupTagId = dup.id;
    createdIds.push(dup.id);

    const future = await insertTestMemory({
      name: `${PREFIX}future access`,
      observations: 'future timestamp',
    });
    futureId = future.id;
    createdIds.push(future.id);
    await testDb
      .update(entities)
      .set({ lastAccessedAt: sql`NOW() + INTERVAL '2 days'` })
      .where(eq(entities.id, future.id));

    const oneDay = await insertTestMemory({
      name: `${PREFIX}exactly one day future`,
      observations: 'divide by zero case',
    });
    exactlyOneDayId = oneDay.id;
    createdIds.push(oneDay.id);
    await testDb
      .update(entities)
      .set({ lastAccessedAt: sql`NOW() + INTERVAL '1 day'` })
      .where(eq(entities.id, oneDay.id));
  });

  afterAll(async () => {
    await cleanupMemories(createdIds);
    await closeTestDb();
  });

  it('clamps an anti-correlated cosine to 0 instead of -1', async () => {
    const opposing = `[${unitVector(-1).join(',')}]`;
    const v = await scalar(semanticExpr(opposing), antiId);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('clamps tagMatch to 1.0 when an entity has duplicate tags', async () => {
    const v = await scalar(tagMatchExpr(['alpha']), dupTagId);
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThan(0);
  });

  it('counts DISTINCT matching tags, not every duplicate occurrence', async () => {
    // The ≤1 assertion above cannot catch a missing DISTINCT, because LEAST(1.0, …)
    // masks it — the two guards hide each other. This asserts the exact value on a
    // case where they diverge: the entity carries ['alpha','alpha'] and the query
    // asks for ['alpha','beta'], so one of two requested tags matches = 0.5.
    // Counting duplicates instead gives 2/2 = 1.0, i.e. "matched everything asked
    // for", which is wrong and still slips under the ceiling.
    const v = await scalar(tagMatchExpr(['alpha', 'beta']), dupTagId);
    expect(v).toBeCloseTo(0.5, 10);
  });

  it('never returns a negative recency for a future last_accessed_at', async () => {
    const v = await scalar(RECENCY_EXPR, futureId);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('does not divide by zero when last_accessed_at is exactly +1 day', async () => {
    await expect(scalar(RECENCY_EXPR, exactlyOneDayId)).resolves.toBeGreaterThanOrEqual(0);
  });

  it('survives a decayed denormal temperature instead of aborting the query', async () => {
    // Thermal decay multiplies temperature (a float4) by 0.85 per missed day, so a
    // long-untouched memory walks into float4 denormals. In float4, such a value
    // times a weight flushes to zero, and Postgres raises 22003 rather than
    // returning 0 -- which aborts the WHOLE recall, not one row.
    //
    // The fixture is 1.4e-45, NOT the 4e-45 seen on a production corpus: 4e-45 times the
    // current temperature weight (0.2727) is 1e-45, which is still representable, so
    // it does NOT reproduce the fault. An earlier version of this test used 4e-45 and
    // a hardcoded 0.15 literal -- a weight that no longer exists in production -- and
    // as a result the ::real -> ::double precision fix was completely unpinned:
    // reverting it left every test green.
    const denormal = await insertTestMemory({
      name: `${PREFIX}denormal temperature`,
      observations: 'denormal temperature decayed almost to zero',
      temperature: 1.4e-45,
      tier: 'COLD',
    });
    createdIds.push(denormal.id);

    // The float4 path is the failure mode, using the REAL production weight so this
    // cannot rot when weights change.
    let caught: unknown;
    try {
      await testDb.execute(sql`
        SELECT (e.temperature * ${PRIOR_WEIGHTS.temperature}::real) AS v
        FROM public.entities e WHERE e.id = ${denormal.id}
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught, 'float4 multiply should have underflowed').toBeDefined();
    const chain: string[] = [];
    for (let e = caught as Error | undefined; e; e = e.cause as Error | undefined) {
      chain.push(String(e.message));
    }
    expect(chain.join(' | ')).toMatch(/underflow/i);

    // The production prior expression must survive the same row.
    await expect(
      testDb.execute(sql`
        SELECT (${PRIOR_SQL}) AS v FROM public.entities e WHERE e.id = ${denormal.id}
      `),
    ).resolves.toBeDefined();

    // And the real contract: a full recall over a corpus containing this row works.
    await expect(
      recall({ query: 'denormal temperature decayed', skipSemantic: true }),
    ).resolves.toBeDefined();
  });

  it('clamps a stored temperature or importance above 1.0', async () => {
    // Nothing in the schema constrains these columns (no CHECK constraints exist),
    // and the corpus-wide MIN/MAX assertion below cannot catch a missing clamp
    // because no real row is out of range. Without a deliberately out-of-range
    // fixture, removing either clamp survives the whole suite.
    const wild = await insertTestMemory({
      name: `${PREFIX}out of range priors`,
      observations: 'temperature and importance above one',
      temperature: 2.0,
      importance: 1.5,
      tier: 'HOT',
    });
    createdIds.push(wild.id);

    expect(await scalar(TEMPERATURE_EXPR, wild.id)).toBe(1);
    expect(await scalar(IMPORTANCE_EXPR, wild.id)).toBe(1);
    // And therefore the prior blend stays within [0,1] for that row.
    const prior = await scalar(PRIOR_SQL, wild.id);
    expect(prior).toBeGreaterThanOrEqual(0);
    expect(prior).toBeLessThanOrEqual(1);
  });

  it('clamps a negative stored temperature to 0', async () => {
    const neg = await insertTestMemory({
      name: `${PREFIX}negative temperature`,
      observations: 'negative temperature',
      temperature: -5.0,
      tier: 'COLD',
    });
    createdIds.push(neg.id);
    expect(await scalar(TEMPERATURE_EXPR, neg.id)).toBe(0);
  });

  it('treats a row with no timestamps as maximally stale, not maximally recent', async () => {
    // GREATEST(0, NULL) is 0 in Postgres, so an unguarded expression gives such a
    // row recency 1.0 -- the highest possible. "Unknown" must not read as "newest".
    const nulls = await insertTestMemory({
      name: `${PREFIX}no timestamps`,
      observations: 'no timestamps at all',
    });
    createdIds.push(nulls.id);
    await testDb
      .update(entities)
      .set({ lastAccessedAt: null, createdAt: null })
      .where(eq(entities.id, nulls.id));

    expect(await scalar(RECENCY_EXPR, nulls.id)).toBe(0);
  });

  it('keeps every query-independent signal within [0,1] across the whole corpus', async () => {
    const r = await testDb.execute(sql`
      SELECT
        MAX(${TEMPERATURE_EXPR}) AS t_hi, MIN(${TEMPERATURE_EXPR}) AS t_lo,
        MAX(${IMPORTANCE_EXPR}) AS i_hi, MIN(${IMPORTANCE_EXPR}) AS i_lo,
        MAX(${RECENCY_EXPR}) AS r_hi, MIN(${RECENCY_EXPR}) AS r_lo,
        MAX(${ACCESS_FREQ_EXPR}) AS a_hi, MIN(${ACCESS_FREQ_EXPR}) AS a_lo,
        MAX(${CENTRALITY_NORM_EXPR}) AS c_hi, MIN(${CENTRALITY_NORM_EXPR}) AS c_lo
      FROM public.entities e
    `);
    const row = r.rows[0] as Record<string, string | number>;
    for (const k of ['t', 'i', 'r', 'a', 'c']) {
      expect(Number(row[`${k}_hi`])).toBeLessThanOrEqual(1);
      expect(Number(row[`${k}_lo`])).toBeGreaterThanOrEqual(0);
    }
  });
});
