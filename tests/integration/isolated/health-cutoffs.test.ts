/**
 * health reports which thermal cutoffs tiering is actually running on (percentile tiering
 * Task 6). The property under test: a stale or degenerate stored row must be
 * reported through resolveCutoffs(), not as the raw stored columns — reporting
 * the raw row would say `measured` while bump() was actually using the
 * TIER_HOT/TIER_WARM seeds, which is the exact silent divergence this task
 * exists to prevent.
 *
 * `thermal_cutoffs` is a single row shared by every file in
 * tests/integration/isolated/ (see bump-cutoffs.test.ts and
 * thermal-cutoffs-migration.test.ts). This suite upserts
 * id=1 in beforeEach, matching the established pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { testDb } from '../helpers.js';
import { getHealth } from '../../../src/observability.js';

describe('health reports thermal cutoff provenance', () => {
  beforeEach(async () => {
    await testDb.execute(sql`
      INSERT INTO public.thermal_cutoffs (id, hot_cutoff, warm_cutoff, corpus_size, computed_at)
      VALUES (1, 0.42, 0.11, 905, NOW())
      ON CONFLICT (id) DO UPDATE SET
        hot_cutoff = 0.42, warm_cutoff = 0.11, corpus_size = 905, computed_at = NOW()
    `);
  });

  it('reports a fresh row as measured', async () => {
    const h = await getHealth();
    expect(h.thermalCutoffs.source).toBe('measured');
    expect(h.thermalCutoffs.hot).toBeCloseTo(0.42, 6);
    expect(h.thermalCutoffs.corpusSize).toBe(905);
  });

  it('reports a stale row as seed, with the seed values not the stored ones', async () => {
    await testDb.execute(
      sql`UPDATE public.thermal_cutoffs SET computed_at = NOW() - INTERVAL '5 days'`,
    );
    const h = await getHealth();
    expect(h.thermalCutoffs.source).toBe('seed');
    expect(h.thermalCutoffs.hot).toBeCloseTo(0.7, 6);
  });

  it('reports the 0012 seed row as seed, not measured', async () => {
    // The exact state a machine sits in before the first decay run, and the
    // state 0013's pass 3 rewrites whenever a tier band is empty: fresh
    // computed_at, non-degenerate 0.7 > 0.3, corpus_size 0. The numbers alone
    // cannot distinguish it from a measured row that happened to land on the
    // seeds — corpus_size is the only marker, and before this it was plumbed
    // into HealthResult but never consulted, so health reported `measured`
    // while the fleet was on earlier absolute thresholds.
    await testDb.execute(sql`
      UPDATE public.thermal_cutoffs
      SET hot_cutoff = 0.7, warm_cutoff = 0.3, corpus_size = 0, computed_at = NOW()
    `);
    const h = await getHealth();
    expect(h.thermalCutoffs.source).toBe('seed');
    expect(h.thermalCutoffs.corpusSize).toBe(0);
  });

  it('reports a fresh, non-degenerate row with corpus_size 0 as seed', async () => {
    // Complement of the above: cutoffs that could never be the seeds still read
    // as seed on the marker alone, so the assertion cannot pass by the values
    // coincidentally matching TIER_HOT/TIER_WARM.
    await testDb.execute(
      sql`UPDATE public.thermal_cutoffs SET corpus_size = 0, computed_at = NOW()`,
    );
    const h = await getHealth();
    expect(h.thermalCutoffs.source).toBe('seed');
    expect(h.thermalCutoffs.hot).toBeCloseTo(0.7, 6);
  });

  it('reports a degenerate row as seed', async () => {
    await testDb.execute(
      sql`UPDATE public.thermal_cutoffs SET hot_cutoff = 0.0, warm_cutoff = 0.0, computed_at = NOW()`,
    );
    const h = await getHealth();
    expect(h.thermalCutoffs.source).toBe('seed');
  });
});
