/**
 * Graph centrality must never exceed 1.0, executed against real Postgres.
 *
 * an earlier issue. The numerator counts a node's TOTAL degree while the denominator
 * took the max ONE-DIRECTIONAL degree, so the ratio was unbounded and the signal
 * could pay more than its own weight. Measured before the fix: 287/285 = 1.007 on
 * a production corpus, 28/24 = 1.167 on the local dev corpus.
 *
 * This is the behavioural counterpart to `tests/centrality-normalization.test.ts`,
 * which can only assert on source text. Source assertions cannot prove a bound —
 * they pin a shape, and a differently-shaped-but-equally-wrong expression passes
 * them. This file runs the real exported expressions and checks the real number.
 *
 * The fixture is built to guarantee a pre-fix violation regardless of what else is
 * in the database: it measures the corpus max one-directional degree FIRST, then
 * gives one hub (max + 1) out-edges and (max + 1) in-edges. The new max
 * one-directional degree is then exactly (max + 1) while the hub's total degree is
 * 2 * (max + 1) — so the old denominator produced a ratio of exactly 2.0, a 100%
 * overpayment, whatever the starting data. It also plants a self-loop, a case
 * where the numerator and denominator count differently. (Duplicate edges were
 * the other; drizzle/0017's unique index has made them impossible.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { CENTRALITY_EXPR, CENTRALITY_DENOM_EXPR } from '../../src/retrieve.js';
import { PRIOR_WEIGHTS } from '../../src/config.js';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  closeTestDb,
} from './helpers.js';

const PREFIX = 'centrality-bound-';
const createdIds: string[] = [];

/** Highest one-directional degree in the corpus — the OLD, buggy denominator. */
async function maxOneDirectionalDegree(): Promise<number> {
  const r = await testDb.execute(sql`
    SELECT COALESCE((
      SELECT MAX(cnt) FROM (
        SELECT COUNT(*)::float AS cnt FROM public.memory_relations GROUP BY from_id
        UNION ALL
        SELECT COUNT(*)::float FROM public.memory_relations GROUP BY to_id
      ) s
    ), 0) AS d
  `);
  return Number((r.rows[0] as { d: string | number }).d);
}

/** Worst normalized centrality across the whole corpus, via the real expressions. */
async function maxNormalizedCentrality(): Promise<number> {
  const r = await testDb.execute(sql`
    SELECT COALESCE(MAX(${CENTRALITY_EXPR} / ${CENTRALITY_DENOM_EXPR}), 0) AS ratio
    FROM public.entities e
  `);
  return Number((r.rows[0] as { ratio: string | number }).ratio);
}

describe('graph centrality is bounded by 1.0', () => {
  let hubId: string;
  let baseline: number;

  beforeAll(async () => {
    baseline = await maxOneDirectionalDegree();

    const hub = await insertTestMemory({
      name: `${PREFIX}hub`,
      type: 'fact',
      observations: 'Hub with asymmetric in and out degree',
    });
    hubId = hub.id;
    createdIds.push(hub.id);

    // (baseline + 1) in each direction, so the hub's TOTAL degree is exactly
    // twice the corpus max one-directional degree. Each edge needs its own
    // partner: the unique (from, to, type) index rejects a repeated edge.
    const perSide = baseline + 1;
    for (let i = 0; i < perSide; i++) {
      const outTarget = await insertTestMemory({
        name: `${PREFIX}out target ${i}`,
        type: 'fact',
        observations: 'Receives an edge from the hub',
      });
      const inSource = await insertTestMemory({
        name: `${PREFIX}in source ${i}`,
        type: 'fact',
        observations: 'Sends an edge to the hub',
      });
      createdIds.push(outTarget.id, inSource.id);
      await insertTestRelation(hubId, outTarget.id, 'related_to');
      await insertTestRelation(inSource.id, hubId, 'related_to');
    }

    // Self-loop: counted once by the numerator's OR, twice by the denominator's
    // UNION ALL. Inflates the denominator, so the bound must still hold.
    await insertTestRelation(hubId, hubId, 'related_to');
  });

  afterAll(async () => {
    await cleanupMemories(createdIds);
    await closeTestDb();
  });

  it('gives the hub a total degree of twice the max one-directional degree', async () => {
    // Proves the fixture is adversarial. Without this, a passing bound assertion
    // below could simply mean the fixture never stressed anything.
    const r = await testDb.execute(sql`
      SELECT (SELECT COUNT(*)::float FROM public.memory_relations rel
              WHERE rel.from_id = e.id OR rel.to_id = e.id) AS total
      FROM public.entities e WHERE e.id = ${hubId}
    `);
    const total = Number((r.rows[0] as { total: string | number }).total);

    // 2 * (baseline + 1) edges, plus the single self-loop row.
    expect(total).toBe(2 * (baseline + 1) + 1);
    expect(total).toBeGreaterThan(await maxOneDirectionalDegree());
  });

  it('never normalizes any memory above 1.0', async () => {
    // The whole point. Pre-fix this returned ~2.0 for the fixture above.
    expect(await maxNormalizedCentrality()).toBeLessThanOrEqual(1.0);
  });

  it('would have exceeded 1.0 under the old one-directional denominator', async () => {
    // Pins that the fixture genuinely reproduces an earlier issue rather than passing
    // vacuously — if this stops failing under the old formula, the fixture has
    // decayed and the assertion above no longer proves anything.
    // The PRE-the hub-ranking bug formula in full: raw COUNT numerator over the one-directional
    // denominator. Deliberately not CENTRALITY_EXPR, which is provenance-
    // weighted since then — mixing the two measures nothing.
    const r = await testDb.execute(sql`
      SELECT MAX((SELECT COUNT(*)::float FROM public.memory_relations rel
                  WHERE rel.from_id = e.id OR rel.to_id = e.id) / GREATEST(1.0, (
        SELECT MAX(cnt) FROM (
          SELECT COUNT(*)::float AS cnt FROM public.memory_relations GROUP BY from_id
          UNION ALL
          SELECT COUNT(*)::float FROM public.memory_relations GROUP BY to_id
        ) sub
      ))) AS ratio
      FROM public.entities e
    `);
    expect(Number((r.rows[0] as { ratio: string | number }).ratio)).toBeGreaterThan(1.0);
  });

  it('keeps the centrality contribution within its configured weight', async () => {
    // The bound only matters because of what it funds. A ratio of 1.007 spent
    // 0.1511 of a 1.0 score against a 0.15 budget.
    const worst = await maxNormalizedCentrality();
    const contribution = worst * PRIOR_WEIGHTS.graphCentrality;
    expect(contribution).toBeLessThanOrEqual(PRIOR_WEIGHTS.graphCentrality + 1e-9);
  });

  it('returns 1.0 from the denominator when the corpus has no relations', async () => {
    // Divide-by-zero guard, on the REAL expression (not a copy of it): every
    // edge is deleted inside a transaction that is always rolled back.
    // MAX over zero rows is NULL, which COALESCE(NULLIF(…, 0), 1.0) turns into
    // 1.0 (edge provenance replaced the earlier GREATEST(1.0, …) floor).
    let d: number | undefined;
    await testDb.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM public.memory_relations`);
      const r = await tx.execute(sql`SELECT ${CENTRALITY_DENOM_EXPR} AS d`);
      d = Number((r.rows[0] as { d: string | number }).d);
      tx.rollback();
    }).catch((e) => { if (!(e instanceof TransactionRollbackError)) throw e; });
    expect(d).toBe(1);
  });
});
