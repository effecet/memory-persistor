/**
 * Percentile-assigned thermal tiers.
 *
 * memory_thermal_decay() assigns tier from cume_dist() over the WHOLE
 * entities table, not from absolute thresholds — the absolute-threshold
 * version (0010) returns HOT: 0 on a corpus collapsed toward zero, and
 * (separately) promotes ~everything to HOT on a corpus saturated at the cap.
 * That is the regression this migration closes.
 *
 * The rank function is `cume_dist`, NOT `percent_rank`, and the difference is
 * load-bearing rather than cosmetic: `percent_rank` assigns a tied group its
 * LOWEST rank, and bump() manufactures a tie at exactly 1.0 on every read via
 * `LEAST(1.0::real, ...)`. A tie mass at the TOP therefore lands the whole
 * group BELOW HOT_QUANTILE and empties HOT entirely — the earlier shape, while
 * the derived cutoffs still read as `measured`. `cume_dist` gives a tied group
 * the HIGHEST cumulative fraction (exactly 1.0 for a top tie), so the hottest
 * rows are tiered HOT. `keeps HOT non-empty when a tie mass sits at exactly the
 * cap` below is the regression test for that; it goes RED under percent_rank.
 *
 * Runs against real Postgres. The integration DB is a SHARED fixture across
 * every file in this suite (see helpers.ts) — `DELETE FROM public.entities`
 * would destroy other suites' data, so it is never used here. Consequently:
 *
 *  - Fraction assertions (HOT %) are measured over the WHOLE `entities`
 *    table, not just the rows this file seeds, and are tolerant (±3
 *    percentage points of the target decile) rather than exact.
 *  - At least 200 rows are seeded per fraction test so the tolerance stays
 *    meaningful even if a few stray rows from another suite are present.
 *  - Every other assertion is scoped to a single row this suite owns by id.
 *  - `afterEach` cleans up only the ids this suite created.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  testDb,
  insertTestMemory,
  cleanupMemories,
  closeTestDb,
} from '../helpers.js';
import { resolveCutoffs } from '../../../src/thermal-cutoffs.js';
import { WARM_QUANTILE } from '../../../src/config.js';

const PREFIX = 'thermal-pct-decay-';

describe('memory_thermal_decay percentile tiers', () => {
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

  /** Insert `temps.length` rows with the given temperatures, tracked for cleanup. */
  async function seed(temps: number[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < temps.length; i++) {
      const entity = await insertTestMemory({
        name: `${PREFIX}${i}-${Math.random().toString(36).slice(2)}`,
        temperature: temps[i],
      });
      ids.push(entity.id);
    }
    createdIds.push(...ids);
    return ids;
  }

  /** Fraction of the WHOLE entities table currently tiered HOT. */
  async function hotFraction(): Promise<number> {
    const r = await testDb.execute(sql`
      SELECT COUNT(*) FILTER (WHERE tier = 'HOT')::real / COUNT(*)::real AS frac
      FROM public.entities
    `);
    return Number((r.rows[0] as { frac: string | number }).frac);
  }

  /** temperature / tier / importance for one owned row. */
  async function snapshotRow(id: string): Promise<{
    temperature: string | number;
    tier: string;
    importance: string | number;
  }> {
    const r = await testDb.execute(sql`
      SELECT temperature, tier, importance FROM public.entities WHERE id = ${id}
    `);
    return r.rows[0] as { temperature: string | number; tier: string; importance: string | number };
  }

  /** Row count of the WHOLE entities table (the integration DB is shared). */
  async function corpusCount(): Promise<number> {
    const r = await testDb.execute(sql`SELECT COUNT(*)::int AS n FROM public.entities`);
    return Number((r.rows[0] as { n: string | number }).n);
  }

  it('yields ~10% HOT on a corpus saturated at the cap (distinct values)', async () => {
    await seed(Array.from({ length: 200 }, () => 1.0 - Math.random() * 1e-3));
    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);
    const frac = await hotFraction();
    expect(frac).toBeGreaterThanOrEqual(0.07);
    expect(frac).toBeLessThanOrEqual(0.13);
  });

  it('keeps HOT non-empty when a tie mass sits at exactly the cap', async () => {
    // The saturation case that actually occurs: bump() clamps with
    // LEAST(1.0::real, ...), so every read manufactures a row at EXACTLY 1.0.
    // Distinct near-cap values (the test above) never exercise this — a tie is
    // the whole point, so seed one at exactly 1.0, not 1.0 - epsilon.
    const before = await corpusCount();
    // Sized against the LIVE corpus, not a constant: the integration DB is
    // shared and accumulates rows from earlier files, and the defect only
    // shows when the tie group exceeds 1 - HOT_QUANTILE of the whole table.
    const ties = Math.max(100, Math.ceil(before * 0.5));
    const tiedIds = await seed(Array.from({ length: ties }, () => 1.0));
    await seed(Array.from({ length: 100 }, (_, i) => (i / 200) * 0.9));

    // Precondition, asserted rather than assumed: if the tie group were under
    // 10% of the corpus this test would pass against percent_rank too, i.e.
    // vacuously. Fail loudly instead of silently measuring nothing.
    const total = await corpusCount();
    expect(ties / total).toBeGreaterThan(0.10);

    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);

    const r = await testDb.execute(sql`
      SELECT COUNT(*)::int AS hot FROM public.entities WHERE tier = 'HOT'
    `);
    // Under percent_rank the tied group takes the group's LOWEST rank
    // ((total-ties)/(total-1) < 0.90 here) and nothing sits above it, so HOT is
    // EMPTY. Under cume_dist the group takes 1.0 and is HOT.
    expect(Number((r.rows[0] as { hot: string | number }).hot)).toBeGreaterThan(0);

    // Stronger: every tied row is HOT, not just some row somewhere.
    // A JS array binds as a record, not an array — pass the Postgres array
    // literal as a single text parameter and cast it.
    const t = await testDb.execute(sql`
      SELECT COUNT(*)::int AS n FROM public.entities
      WHERE id = ANY(${`{${tiedIds.join(',')}}`}::uuid[]) AND tier <> 'HOT'
    `);
    expect(Number((t.rows[0] as { n: string | number }).n)).toBe(0);
  });

  it('yields ~10% HOT on a corpus collapsed toward zero', async () => {
    await seed(Array.from({ length: 200 }, (_, i) => i * 1e-9));
    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);
    const frac = await hotFraction();
    expect(frac).toBeGreaterThanOrEqual(0.07);
    expect(frac).toBeLessThanOrEqual(0.13);
  });

  it('floors a sub-epsilon temperature to exactly zero after decay', async () => {
    const [id] = await seed([1e-20]);
    await testDb.execute(sql`
      UPDATE public.entities SET last_accessed_at = NOW() - INTERVAL '2 days' WHERE id = ${id}
    `);
    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);
    const r = await testDb.execute(
      sql`SELECT temperature FROM public.entities WHERE id = ${id}`,
    );
    expect(Number((r.rows[0] as { temperature: string | number }).temperature)).toBe(0);
  });

  it('derives cutoffs that agree with the live tier assignment', async () => {
    await seed(Array.from({ length: 200 }, (_, i) => i / 200));
    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);
    const r = await testDb.execute(sql`
      SELECT c.hot_cutoff, c.warm_cutoff, c.corpus_size,
             (SELECT MIN(temperature) FROM public.entities WHERE tier = 'HOT')  AS min_hot,
             (SELECT MIN(temperature) FROM public.entities WHERE tier = 'WARM') AS min_warm,
             (SELECT COUNT(*) FROM public.entities) AS live_count
      FROM public.thermal_cutoffs c
    `);
    const row = r.rows[0] as Record<string, string | number>;
    expect(Number(row.hot_cutoff)).toBeCloseTo(Number(row.min_hot), 6);
    expect(Number(row.warm_cutoff)).toBeCloseTo(Number(row.min_warm), 6);
    expect(Number(row.hot_cutoff)).toBeGreaterThan(Number(row.warm_cutoff));
    // corpus_size is derived from the whole table, not just our seeded rows —
    // assert it matches a live re-count rather than a hardcoded size.
    expect(Number(row.corpus_size)).toBe(Number(row.live_count));
  });

  it('writes a pure seed row when a band comes back empty, never a mixed one', async () => {
    // Shape the WHOLE table into two poles with nothing in the WARM band:
    // a tie mass at exactly 1.0 (cume_dist 1.0 → HOT) and enough rows at
    // exactly 0.0 that every pre-existing row from another suite is pushed
    // below WARM_QUANTILE. Sized from the live count because the integration
    // DB is shared: with E pre-existing rows, E zeros and O ones, the highest
    // pre-existing row sits at (E + E) / (2E + O), which must stay under 0.70.
    const existing = await corpusCount();
    const zeros = existing;
    const ones = Math.ceil(existing * 1.5) + 60;
    await seed(Array.from({ length: zeros }, () => 0.0));
    await seed(Array.from({ length: ones }, () => 1.0));

    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);

    // Precondition, asserted not assumed — if WARM were non-empty this test
    // would exercise the measured branch and prove nothing about the guard.
    const bands = await testDb.execute(sql`
      SELECT COUNT(*) FILTER (WHERE tier = 'WARM')::int AS warm,
             COUNT(*) FILTER (WHERE tier = 'HOT')::int  AS hot
      FROM public.entities
    `);
    expect(Number((bands.rows[0] as { warm: string | number }).warm)).toBe(0);
    expect(Number((bands.rows[0] as { hot: string | number }).hot)).toBeGreaterThan(0);

    const r = await testDb.execute(sql`
      SELECT hot_cutoff, warm_cutoff, corpus_size FROM public.thermal_cutoffs WHERE id = 1
    `);
    const row = r.rows[0] as Record<string, string | number>;
    // All-or-nothing: BOTH seeds and corpus_size 0, so resolveCutoffs() reads
    // it as `seed`. A per-band COALESCE would instead pair a measured
    // hot_cutoff (1.0 here) with the 0.3 warm seed — a mixed row describing two
    // different distributions, and the shape that manufactures hot <= warm.
    expect(Number(row.hot_cutoff)).toBeCloseTo(0.7, 6);
    expect(Number(row.warm_cutoff)).toBeCloseTo(0.3, 6);
    expect(Number(row.corpus_size)).toBe(0);
  });

  /** The stored cutoffs row, shaped for resolveCutoffs(). */
  async function storedCutoffs() {
    const r = await testDb.execute(sql`
      SELECT hot_cutoff, warm_cutoff, corpus_size, computed_at
      FROM public.thermal_cutoffs WHERE id = 1
    `);
    const row = r.rows[0] as Record<string, string | number | Date>;
    return {
      hotCutoff: Number(row.hot_cutoff),
      warmCutoff: Number(row.warm_cutoff),
      corpusSize: Number(row.corpus_size),
      computedAt: new Date(row.computed_at as string | Date),
    };
  }

  it('keeps COLD reachable when a tie mass sits at exactly the floor', async () => {
    // Mirror of 'keeps HOT non-empty when a tie mass sits at exactly the cap',
    // at the other pole. Pass 1 writes EXACTLY 0 below epsilon, so a tie mass
    // at the FLOOR is what a long-unread corpus settles into — the same way
    // bump()'s LEAST(1.0, ...) manufactures one at the cap on every read.
    //
    // Under a whole-corpus cume_dist the floored group takes group/N, so once
    // it passes WARM_QUANTILE the entire DEAD mass is tiered WARM and COLD is
    // empty. Worse than the empty-band case: both bands are non-empty, so
    // pass 3's all-or-nothing guard never fires and it writes a MEASURED row
    // with warm_cutoff = 0 — which bump() compares with >=, making COLD
    // unreachable there too while health reports `measured`.
    const existing = await corpusCount();
    const live = 100;
    // Sized against the LIVE corpus, not a constant: the defect needs the
    // floored group to exceed WARM_QUANTILE of the WHOLE table, and this
    // database is shared by the other files in this directory.
    const zeros = Math.ceil((existing + live) * 3);
    const zeroIds = await seed(Array.from({ length: zeros }, () => 0.0));
    await seed(Array.from({ length: live }, (_, i) => ((i + 1) / live) * 0.9));

    // Precondition, asserted rather than assumed: below WARM_QUANTILE the
    // floored group tiers COLD anyway and this test would pass vacuously.
    // Compared against the IMPORTED constant, never a hardcoded 0.70 — if
    // WARM_QUANTILE were raised to 0.80 a literal would still pass while the
    // defect no longer bites, and the test would go quietly vacuous.
    const total = await corpusCount();
    expect(zeros / total).toBeGreaterThan(WARM_QUANTILE);

    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);

    // Every floored row is COLD — not just "some row somewhere is COLD".
    const notCold = await testDb.execute(sql`
      SELECT COUNT(*)::int AS n FROM public.entities
      WHERE id = ANY(${`{${zeroIds.join(',')}}`}::uuid[]) AND tier <> 'COLD'
    `);
    expect(Number((notCold.rows[0] as { n: string | number }).n)).toBe(0);

    // Every floored row also gets rank EXACTLY 0 — not merely a low rank.
    // temperature_rank is the recall thermal prior (TEMPERATURE_EXPR in
    // src/retrieve.ts), so this is the retrieval half of the cold-pole fix and it is the
    // user-visible half: before the fix these rows took cume_dist = group/N,
    // handing a dead memory a prior of up to 0.70 in ranking.
    const ranks = await testDb.execute(sql`
      SELECT COUNT(*)::int AS n FROM public.entities
      WHERE id = ANY(${`{${zeroIds.join(',')}}`}::uuid[])
        AND (temperature_rank IS DISTINCT FROM 0::real)
    `);
    expect(Number((ranks.rows[0] as { n: string | number }).n)).toBe(0);

    // The live population still spans all three tiers, so excluding the floor
    // from the ranking has not collapsed the distribution it ranks.
    const bands = await testDb.execute(sql`
      SELECT COUNT(*) FILTER (WHERE tier = 'HOT')::int  AS hot,
             COUNT(*) FILTER (WHERE tier = 'WARM')::int AS warm
      FROM public.entities
    `);
    expect(Number((bands.rows[0] as { hot: string | number }).hot)).toBeGreaterThan(0);
    expect(Number((bands.rows[0] as { warm: string | number }).warm)).toBeGreaterThan(0);

    // The WARM band's own minimum is non-zero — this is the the cold-pole fix property
    // itself, read from the corpus rather than inferred from the cutoffs row.
    // Before the fix the floored mass WAS the WARM band, so this was exactly 0.
    const band = await testDb.execute(sql`
      SELECT MIN(temperature)::real AS min_warm
      FROM public.entities WHERE tier = 'WARM'
    `);
    const minWarm = Number((band.rows[0] as { min_warm: string | number }).min_warm);
    expect(minWarm).toBeGreaterThan(0);

    // And the row pass 3 wrote is one the READERS accept — judged by the very
    // function bump()'s SQL mirrors, not by re-reading the numbers here. A
    // measured row whose WARM boundary is 0 is the shape that makes COLD
    // unreachable in bump() while health calls the corpus healthy.
    //
    // Compared against the live band minimum, NOT merely asserted to be > 0:
    // resolveCutoffs() returns the 0.3 seed on every rejection path, so
    // `warm > 0` is satisfied by a degraded result too and would pin nothing.
    // Only a genuinely measured row matches the band it was derived from.
    const resolved = resolveCutoffs(await storedCutoffs());
    expect(resolved.source).toBe('measured');
    expect(resolved.warm).toBeCloseTo(minWarm, 6);
  });

  it('tiers a NULL temperature COLD rather than HOT', async () => {
    // entities.temperature is nullable (default 1.0, but an explicit NULL is
    // accepted). `ORDER BY temperature` sorts NULLS LAST on ASC, so a whole-
    // corpus cume_dist hands a NULL row the HIGHEST rank and tiers it HOT —
    // the hottest memory in the brain being the one with no temperature at
    // all. Excluding the floor from the ranking excludes NULL with it, since
    // `NULL > 0` is not true.
    const [id] = await seed([0.5]);
    await testDb.execute(sql`UPDATE public.entities SET temperature = NULL WHERE id = ${id}`);
    await seed(Array.from({ length: 100 }, (_, i) => ((i + 1) / 100) * 0.9));

    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);

    const r = await testDb.execute(
      sql`SELECT tier, temperature_rank FROM public.entities WHERE id = ${id}`,
    );
    const row = r.rows[0] as { tier: string; temperature_rank: string | number };
    expect(row.tier).toBe('COLD');
    expect(Number(row.temperature_rank)).toBe(0);
  });

  it('returns only rows that changed, not the whole corpus, on a settled run', async () => {
    // decayAll() file-syncs EVERY row the function returns, so returning the
    // whole corpus rewrites ~900 markdown files nightly. Run once to settle,
    // then again: the second run must return strictly fewer rows than the
    // table holds.
    await seed(Array.from({ length: 200 }, (_, i) => i / 200));
    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);

    const r = await testDb.execute(sql`
      SELECT (SELECT COUNT(*)::int FROM public.memory_thermal_decay()) AS returned,
             (SELECT COUNT(*)::int FROM public.entities)               AS total
    `);
    const row = r.rows[0] as Record<string, string | number>;
    expect(Number(row.total)).toBeGreaterThan(0);
    expect(Number(row.returned)).toBeLessThan(Number(row.total));
  });

  it('returns a row whose ONLY change is importance drift', async () => {
    // The change filter must cover every mutable column syncToFile() writes to
    // markdown, not just the ones pass 2 touches. Pass 1 drifts importance on
    // its own axis (+0.05 when access_count >= 5), so a row floored at
    // temperature 0 with a stable tier still changes nightly — and importance
    // IS in the frontmatter. Dropping it from the filter left that file
    // permanently stale, breaking the dual-write invariant.
    const [id] = await seed([0.0]);
    await testDb.execute(sql`
      UPDATE public.entities
      SET access_count = 5, importance = 0.5, last_accessed_at = NOW() - INTERVAL '2 days'
      WHERE id = ${id}
    `);

    // Settle first: this run floors the temperature and assigns the tier, so
    // the SECOND run is the one where importance is the only thing that moves.
    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);
    const before = await snapshotRow(id);

    const r = await testDb.execute(sql`
      SELECT COUNT(*)::int AS n FROM public.memory_thermal_decay() d WHERE d.id = ${id}
    `);
    const after = await snapshotRow(id);

    // Preconditions, asserted not assumed: if temperature or tier had also
    // moved, the row would be returned for those instead and this test would
    // pass without covering importance at all.
    expect(Number(after.temperature)).toBe(Number(before.temperature));
    expect(after.tier).toBe(before.tier);
    expect(Number(after.importance)).toBeGreaterThan(Number(before.importance));

    expect(Number((r.rows[0] as { n: string | number }).n)).toBe(1);
  });

  it('assigns every row in the corpus a temperature_rank', async () => {
    await seed(Array.from({ length: 200 }, (_, i) => i / 200));
    await testDb.execute(sql`SELECT public.memory_thermal_decay()`);
    const r = await testDb.execute(sql`
      SELECT COUNT(*)::int AS n FROM public.entities WHERE temperature_rank IS NULL
    `);
    expect(Number((r.rows[0] as { n: string | number }).n)).toBe(0);
  });
});
