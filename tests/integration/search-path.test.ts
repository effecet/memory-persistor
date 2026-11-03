/**
 * src/db.ts's pool must actually resolve unqualified names from `extensions`.
 *
 * Behavioural counterpart to tests/db-search-path.test.ts, which pins the
 * constant's value and its wiring into both pools. Neither proves the SERVER
 * resolves anything; only a live connection does.
 *
 * The fixture reproduces Supabase's topology on whatever Postgres the suite is
 * pointed at: an `extensions` schema holding a probe function, called
 * UNQUALIFIED through the pool src/db.ts exports. That can only succeed if
 * `extensions` is on the connection's search_path.
 *
 * Deliberately NOT asserted via word_similarity: pg_trgm lives in `public` on
 * local Docker and in CI, so an unqualified word_similarity() call resolves
 * there with or without the fix — it would pass against the broken code and pin
 * nothing. The probe function exists ONLY in `extensions`, so it cannot.
 *
 * This is the only integration file that imports `src/db.js` and closes its
 * pool. That is safe because vitest isolates module state per file
 * (`isolate: true`, the default, which vitest.config.ts does not override) —
 * 17 other suites hold the same pool transitively via retrieve/intelligence/
 * graph. If anyone sets `isolate: false` or `singleFork: true`, those suites
 * will fail with "Cannot use a pool after calling end" and THIS is the reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, closeDb } from '../../src/db.js';
import { assertSafeIntegrationTarget } from './db-guard.js';

// The same guard the shared helpers apply, called directly: importing
// helpers.js would build a second Pool this suite never uses and never closes.
assertSafeIntegrationTarget(
  process.env.DATABASE_URL ?? '',
  process.env.ALLOW_NONLOCAL_INTEGRATION_DB === '1',
);

const PROBE = 'search_path_probe';

beforeAll(async () => {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS extensions`);
  await db.execute(
    sql`CREATE OR REPLACE FUNCTION extensions.search_path_probe() RETURNS integer
        LANGUAGE sql IMMUTABLE AS $$ SELECT 42 $$`,
  );
});

afterAll(async () => {
  // closeDb() must run even if teardown DDL throws, or a failed drop leaks the
  // shared pool for the rest of the file.
  try {
    await db.execute(sql`DROP FUNCTION IF EXISTS extensions.search_path_probe()`);
    // Drop the schema only when it is EMPTY, rather than when this run created
    // it: a run that dies between CREATE and teardown would otherwise leave the
    // schema behind permanently, since every later run would observe it as
    // pre-existing. Emptiness is the property that actually makes dropping safe
    // — on a database where pg_trgm genuinely lives here, it is not empty.
    await db.execute(sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions')
           AND NOT EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'extensions'
           )
           AND NOT EXISTS (
             SELECT 1 FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'extensions'
           )
        THEN
          -- pg_class + pg_proc do not cover every schema-scoped object kind:
          -- types, operators, opclasses, collations, text-search configs and
          -- extension membership can all make RESTRICT refuse. Swallow that
          -- specific refusal so teardown never fails spuriously — leaving the
          -- schema in place is the harmless outcome here.
          BEGIN
            EXECUTE 'DROP SCHEMA extensions RESTRICT';
          EXCEPTION WHEN dependent_objects_still_exist THEN
            NULL;
          END;
        END IF;
      END $$;
    `);
  } finally {
    await closeDb();
  }
});

describe('db.ts connection search_path', () => {
  it('reports extensions on the live connection', async () => {
    const r = await db.execute(sql`SELECT current_setting('search_path') AS sp`);
    expect((r.rows[0] as { sp: string }).sp).toContain('extensions');
  });

  it('resolves an unqualified function that exists only in extensions', async () => {
    const r = await db.execute(sql`SELECT search_path_probe() AS v`);
    expect(Number((r.rows[0] as { v: number }).v)).toBe(42);
  });

  it('the probe really is absent from public, so the last test proved resolution', async () => {
    // Without this, a stray public.search_path_probe would make the test above
    // pass with `extensions` nowhere on the path.
    const r = await db.execute(sql`
      SELECT n.nspname AS schema FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = ${PROBE}
    `);
    const schemas = r.rows.map((row) => (row as { schema: string }).schema);
    expect(schemas).toEqual(['extensions']);
  });

  it('still resolves public, where entities lives', async () => {
    const r = await db.execute(sql`SELECT COUNT(*) AS c FROM entities`);
    expect(Number((r.rows[0] as { c: string }).c)).toBeGreaterThanOrEqual(0);
  });
});
