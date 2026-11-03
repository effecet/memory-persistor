/**
 * bump() tiers against the cached public.thermal_cutoffs row.
 *
 * bump() is the per-read hot path: it must stay ONE statement (see the comment
 * in src/thermal.ts), so the cutoff resolution happens inside the SQL itself
 * rather than via a read-then-write round trip. The SQL CASE arms mirror
 * resolveCutoffs() in src/thermal-cutoffs.ts — missing, stale, or degenerate
 * (hot_cutoff <= warm_cutoff) all fall back to the TIER_HOT / TIER_WARM seeds.
 * This file pins the two implementations against each other.
 *
 * `thermal_cutoffs` is a single row shared by EVERY file in
 * tests/integration/isolated/ (see thermal-cutoffs-migration.test.ts and
 * thermal-percentile-decay.test.ts, which mutate the same row). Isolating
 * this directory onto its own database narrowed that sharing from 38
 * files to 6 — it did not remove it, and file order here is not pinned.
 *
 * This suite never DELETEs the row — it upserts id=1 in beforeEach, matching
 * the established pattern — and restores the migration-0012 seed values in
 * afterAll so a later-running file (e.g. tests/integration/thermal-decay.test.ts,
 * which pins bump()'s tier against the absolute TIER_HOT/TIER_WARM constants
 * via computeTier()) sees the same fallback-equivalent state it always did.
 *
 * Never `DELETE FROM public.entities` — the integration database is shared
 * across suites. Seed via insertTestMemory and clean up only owned ids via
 * cleanupMemories.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { testDb, insertTestMemory, cleanupMemories, closeTestDb } from '../helpers.js';
import { bump } from '../../../src/thermal.js';

const PREFIX = 'bump-cutoffs-';
const createdIds: string[] = [];

describe('bump applies cached cutoffs', () => {
  beforeEach(async () => {
    await testDb.execute(sql`
      INSERT INTO public.thermal_cutoffs (id, hot_cutoff, warm_cutoff, corpus_size, computed_at)
      VALUES (1, 0.15, 0.05, 100, NOW())
      ON CONFLICT (id) DO UPDATE SET
        hot_cutoff = 0.15, warm_cutoff = 0.05, corpus_size = 100, computed_at = NOW()
    `);
  });

  afterAll(async () => {
    // Restore the migration-0012 seed so later-running files in the isolated
    // suite see the same TIER_HOT/TIER_WARM-equivalent state they relied on
    // before this file ran. Still load-bearing after the isolated thermal suite: the isolated
    // database is shared by all six files in this directory.
    await testDb.execute(sql`
      UPDATE public.thermal_cutoffs
      SET hot_cutoff = 0.7, warm_cutoff = 0.3, corpus_size = 0, computed_at = NOW()
      WHERE id = 1
    `);
    if (createdIds.length > 0) {
      await cleanupMemories([...createdIds]);
      createdIds.length = 0;
    }
    await closeTestDb();
  });

  it('tiers a bumped row against the cached cutoffs, not TIER_HOT', async () => {
    const entity = await insertTestMemory({
      name: `${PREFIX}fresh-cutoffs`,
      temperature: 0.0,
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await testDb.execute(
      sql`SELECT temperature, tier FROM public.entities WHERE id = ${entity.id}`,
    );
    // +0.2 lands at 0.2, above the cached hot_cutoff 0.15 — HOT.
    // Under the old absolute TIER_HOT 0.7 this row would be COLD.
    expect(Number((after.rows[0] as { temperature: string | number }).temperature)).toBeCloseTo(0.2, 6);
    expect((after.rows[0] as { tier: string }).tier).toBe('HOT');
  });

  it('tiers a row landing EXACTLY on hot_cutoff as HOT, matching decay', async () => {
    // Pass 3 of drizzle/0013 derives hot_cutoff as MIN(temperature) WHERE
    // tier = 'HOT', so the row that DEFINES the cutoff is HOT by decay's own
    // assignment. bump() must agree at that boundary — a strict `>` would tier
    // the very row the cutoff came from as WARM.
    await testDb.execute(sql`
      UPDATE public.thermal_cutoffs
      SET hot_cutoff = 0.2, warm_cutoff = 0.05, computed_at = NOW() WHERE id = 1
    `);
    const entity = await insertTestMemory({ name: `${PREFIX}hot-boundary`, temperature: 0.0 });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await testDb.execute(
      sql`SELECT temperature, tier FROM public.entities WHERE id = ${entity.id}`,
    );
    // 0.0 + BUMP_AMOUNT lands exactly on 0.2 in float4.
    expect(Number((after.rows[0] as { temperature: string | number }).temperature)).toBeCloseTo(0.2, 6);
    expect((after.rows[0] as { tier: string }).tier).toBe('HOT');
  });

  it('tiers a row landing EXACTLY on warm_cutoff as WARM, matching decay', async () => {
    // Same boundary contract at the other band edge: warm_cutoff is
    // MIN(temperature) WHERE tier = 'WARM'.
    await testDb.execute(sql`
      UPDATE public.thermal_cutoffs
      SET hot_cutoff = 0.5, warm_cutoff = 0.2, computed_at = NOW() WHERE id = 1
    `);
    const entity = await insertTestMemory({ name: `${PREFIX}warm-boundary`, temperature: 0.0 });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await testDb.execute(
      sql`SELECT tier FROM public.entities WHERE id = ${entity.id}`,
    );
    expect((after.rows[0] as { tier: string }).tier).toBe('WARM');
  });

  it('falls back to TIER_HOT/TIER_WARM when the cutoffs row is stale', async () => {
    await testDb.execute(
      sql`UPDATE public.thermal_cutoffs SET computed_at = NOW() - INTERVAL '5 days' WHERE id = 1`,
    );
    const entity = await insertTestMemory({
      name: `${PREFIX}stale-cutoffs`,
      temperature: 0.0,
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await testDb.execute(
      sql`SELECT tier FROM public.entities WHERE id = ${entity.id}`,
    );
    // Fresh cutoffs (0.15/0.05) would tier this HOT; the stale fallback to
    // TIER_WARM=0.3 means 0.2 lands COLD.
    expect((after.rows[0] as { tier: string }).tier).toBe('COLD');
  });

  it('falls back to TIER_HOT/TIER_WARM when corpus_size marks the row as a seed', async () => {
    // bump()'s SQL must mirror resolveCutoffs() on the seed marker too, or the
    // two contracts diverge again: health would say `seed` while bump tiered
    // against the stored numbers. 0.15/0.05 are cutoffs the seeds could never
    // be, so this cannot pass by the values coincidentally matching.
    await testDb.execute(
      sql`UPDATE public.thermal_cutoffs SET corpus_size = 0, computed_at = NOW() WHERE id = 1`,
    );
    const entity = await insertTestMemory({
      name: `${PREFIX}seed-marker`,
      temperature: 0.0,
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await testDb.execute(
      sql`SELECT tier FROM public.entities WHERE id = ${entity.id}`,
    );
    // Honouring 0.15 would tier 0.2 HOT; the seed fallback to TIER_WARM=0.3
    // means it lands COLD.
    expect((after.rows[0] as { tier: string }).tier).toBe('COLD');
  });

  it('falls back to TIER_HOT/TIER_WARM when warm_cutoff is 0', async () => {
    // Fresh, non-seed, and hot > warm — so neither the staleness, corpus_size
    // nor degenerate arm catches it. But a WARM boundary of exactly 0 makes
    // `temperature >= warm_cutoff` true for every row in the corpus, so COLD
    // becomes unreachable through bump(). Produced by decay before the cold-pole fix when a
    // tie mass at the floor was tiered WARM: MIN(temperature) over that band
    // is 0.
    await testDb.execute(
      sql`UPDATE public.thermal_cutoffs SET hot_cutoff = 0.5, warm_cutoff = 0.0, corpus_size = 100, computed_at = NOW() WHERE id = 1`,
    );
    const entity = await insertTestMemory({
      name: `${PREFIX}zero-warm-cutoff`,
      temperature: 0.0,
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await testDb.execute(
      sql`SELECT tier FROM public.entities WHERE id = ${entity.id}`,
    );
    // Without the guard the bumped 0.2 clears warm_cutoff 0.0 and lands WARM.
    // With it, the seeds apply and 0.2 < TIER_WARM (0.3) lands COLD.
    expect((after.rows[0] as { tier: string }).tier).toBe('COLD');
  });

  it('falls back to TIER_HOT/TIER_WARM when hot_cutoff is not finite', async () => {
    // resolveCutoffs() rejects a non-finite cutoff via Number.isFinite(); the
    // SQL had no counterpart, and the two had silently drifted. Postgres orders
    // NaN ABOVE every other real, so `hot_cutoff <= warm_cutoff` is FALSE for
    // NaN — the degenerate arm does not catch it — and bump() would then
    // compare `temperature >= NaN`, which is false for everything, so NOTHING
    // in the corpus could ever tier HOT.
    await testDb.execute(
      sql`UPDATE public.thermal_cutoffs SET hot_cutoff = 'NaN'::real, warm_cutoff = 0.05, corpus_size = 100, computed_at = NOW() WHERE id = 1`,
    );
    const entity = await insertTestMemory({
      name: `${PREFIX}nan-hot-cutoff`,
      temperature: 0.0,
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await testDb.execute(
      sql`SELECT tier FROM public.entities WHERE id = ${entity.id}`,
    );
    // Without the guard the bumped 0.2 clears warm_cutoff 0.05 and lands WARM.
    // With it, the seeds apply and 0.2 < TIER_WARM (0.3) lands COLD.
    expect((after.rows[0] as { tier: string }).tier).toBe('COLD');
  });

  it('falls back to TIER_HOT/TIER_WARM when the cutoffs row is degenerate (hot <= warm)', async () => {
    // Fresh (computed_at NOW()), but hot_cutoff <= warm_cutoff — reachable when
    // pass 3 writes the 0.7 COALESCE fallback for an empty HOT band while
    // warm_cutoff holds a measured value above it (flagged in Task 3 review).
    await testDb.execute(
      sql`UPDATE public.thermal_cutoffs SET hot_cutoff = 0.05, warm_cutoff = 0.15, computed_at = NOW() WHERE id = 1`,
    );
    const entity = await insertTestMemory({
      name: `${PREFIX}degenerate-cutoffs`,
      temperature: 0.0,
    });
    createdIds.push(entity.id);

    await bump(entity.id);

    const after = await testDb.execute(
      sql`SELECT tier FROM public.entities WHERE id = ${entity.id}`,
    );
    // Without the degenerate guard, 0.2 > hot_cutoff (0.05) would tier HOT.
    // The fallback to TIER_WARM=0.3 means 0.2 lands COLD.
    expect((after.rows[0] as { tier: string }).tier).toBe('COLD');
  });
});
