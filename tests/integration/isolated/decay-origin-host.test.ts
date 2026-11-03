/**
 * memory_thermal_decay() must return origin_host.
 *
 * decayAll() in src/thermal.ts runs syncToFile() over every row the function
 * hands back, and buildMarkdown writes `origin_host: ${entity.originHost ??
 * 'unknown'}`. The function's RETURNS TABLE omitted the column, so decayAll
 * could not pass it and every decay-synced file had its machine attribution
 * blanked to `unknown` — silently, on every nightly run.
 *
 * The column reaching the result set is the root fix; that decayAll actually
 * forwards it is pinned separately in tests/decay-sync-origin-host.test.ts,
 * because the two can fail independently.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { testDb, insertTestMemory, cleanupMemories } from '../helpers.js';

describe('memory_thermal_decay origin_host', () => {
  const created: string[] = [];

  afterEach(async () => {
    await cleanupMemories(created.splice(0));
  });

  it('returns the row real origin_host', async () => {
    // last_accessed_at three days back so pass 1 decays the temperature and the
    // row is guaranteed to appear in the changed-rows filter. Seeding a row that
    // does NOT change would make this pass or fail on unrelated corpus shape.
    const entity = await insertTestMemory({
      originHost: 'probe-host-92',
      temperature: 0.5,
      lastAccessedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    created.push(entity.id);

    const result = await testDb.execute(sql`
      SELECT id, origin_host
      FROM public.memory_thermal_decay()
      WHERE id = ${entity.id}
    `);

    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as Record<string, unknown>).origin_host).toBe('probe-host-92');
  });

  it('returns NULL rather than a placeholder when the row has no origin_host', async () => {
    // Rows predating the origin_host column exist in a production corpus (42 of
    // them). The function must pass the NULL through untouched — inventing a
    // string here would be the same defect as `unknown`, one layer down.
    const entity = await insertTestMemory({
      originHost: null,
      temperature: 0.5,
      lastAccessedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    created.push(entity.id);

    const result = await testDb.execute(sql`
      SELECT id, origin_host
      FROM public.memory_thermal_decay()
      WHERE id = ${entity.id}
    `);

    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as Record<string, unknown>).origin_host).toBeNull();
  });
});
