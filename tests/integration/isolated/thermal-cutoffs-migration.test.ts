/**
 * Migration 0012 — thermal_cutoffs table + entities.temperature_rank column.
 *
 * Schema only. No behaviour change: the seeded row holds
 * 0.7/0.3, which are today's TIER_HOT/TIER_WARM from src/config.ts, so
 * anything reading it reproduces today's tiering exactly.
 *
 * ⚠️ Since 0013, `memory_thermal_decay()` WRITES to this same single-row table
 * (Pass 3) every time it runs — and the other files in
 * tests/integration/isolated/ call it (directly or via `decayAll()`) before
 * this file's tests do. the isolated thermal suite gave this directory its own database, which
 * narrowed that set from 38 files to 6 but did not empty it. So the
 * row is no longer guaranteed to still hold 0012's exact seed values by the
 * time this test executes. `beforeEach` restores them via the identical
 * upsert 0012's own migration performs, so this stays a test of 0012's SEED
 * CONTRACT rather than an assertion that nothing else in the suite ever
 * touches the row (which 0013 made false by design — see its header comment).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { testDb } from '../helpers.js';

describe('0012_thermal_cutoffs', () => {
  beforeEach(async () => {
    await testDb.execute(sql`
      INSERT INTO public.thermal_cutoffs (id, hot_cutoff, warm_cutoff, corpus_size)
      VALUES (1, 0.7, 0.3, 0)
      ON CONFLICT (id) DO UPDATE SET
        hot_cutoff  = EXCLUDED.hot_cutoff,
        warm_cutoff = EXCLUDED.warm_cutoff,
        corpus_size = EXCLUDED.corpus_size
    `);
  });

  it('seeds exactly one row holding the TIER_HOT/TIER_WARM values', async () => {
    const r = await testDb.execute(
      sql`SELECT id, hot_cutoff, warm_cutoff, corpus_size FROM public.thermal_cutoffs`
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].hot_cutoff)).toBeCloseTo(0.7, 6);
    expect(Number(r.rows[0].warm_cutoff)).toBeCloseTo(0.3, 6);
    expect(Number(r.rows[0].corpus_size)).toBe(0);
  });

  it('rejects a second row', async () => {
    await expect(
      testDb.execute(
        sql`INSERT INTO public.thermal_cutoffs (id, hot_cutoff, warm_cutoff) VALUES (2, 0.5, 0.2)`
      )
    ).rejects.toThrow();
  });

  it('adds a nullable temperature_rank column to entities', async () => {
    const r = await testDb.execute(sql`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'entities'
        AND column_name = 'temperature_rank'
    `);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].is_nullable).toBe('YES');
  });
});
