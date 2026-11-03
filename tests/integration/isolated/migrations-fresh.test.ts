/**
 * Every migration applies to an empty database, and the hand-written ones
 * (0008 onward) apply a second time.
 *
 * Each run creates its own throwaway database on the server DATABASE_URL points
 * at (the isolated test server, never a managed one: the guard in helpers.ts
 * has already refused a remote URL by the time this file runs), so the result
 * does not depend on what the rest of the suite left behind.
 *
 * The database has no pg_cron. 0010 must skip the decay schedule with a NOTICE
 * rather than abort, which is what a laptop or a CI service container sees.
 *
 * 0000-0007 are drizzle-generated CREATE/ALTER statements and are not
 * re-runnable; only 0008+ are written to be idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import './../helpers.js'; // runs the non-local-target guard before anything connects

const DRIZZLE = join(import.meta.dirname, '..', '..', '..', 'drizzle');
const FILES = readdirSync(DRIZZLE).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const IDEMPOTENT = FILES.filter((f) => Number(f.slice(0, 4)) >= 8);
const DB = `mp_fresh_${process.pid}_${Date.now()}`;

function urlFor(db: string): string {
  const u = new URL(process.env.DATABASE_URL ?? '');
  u.pathname = `/${db}`;
  return u.toString();
}

async function withClient<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function apply(files: string[]): Promise<void> {
  await withClient(DB, async (c) => {
    for (const f of files) {
      try {
        await c.query(readFileSync(join(DRIZZLE, f), 'utf-8'));
      } catch (err) {
        throw new Error(`${f}: ${(err as Error).message}`);
      }
    }
  });
}

describe('migrations on an empty database without pg_cron', () => {
  beforeAll(async () => {
    await withClient('postgres', (c) => c.query(`CREATE DATABASE ${DB}`));
  });

  afterAll(async () => {
    await withClient('postgres', (c) => c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));
  });

  it('applies every migration in order', async () => {
    await expect(apply(FILES)).resolves.toBeUndefined();
  });

  it('re-applies the hand-written migrations (0008+)', async () => {
    await expect(apply(IDEMPOTENT)).resolves.toBeUndefined();
  });

  it('leaves memory_thermal_decay() returning origin_host, with no cron schema', async () => {
    const cols = await withClient(DB, (c) =>
      c.query(`
        SELECT unnest(p.proargnames) AS name, unnest(p.proargmodes) AS mode
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'memory_thermal_decay'`),
    );
    const out = cols.rows.filter((r) => r.mode === 't').map((r) => r.name);
    expect(out).toContain('origin_host');
    const cron = await withClient(DB, (c) => c.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'cron'`));
    expect(cron.rows).toHaveLength(0);
  });
});
