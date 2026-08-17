/**
 * Integration tests for fetchThermalByPgId against a real Postgres.
 *
 * WHY THIS FILE EXISTS: the unit tests in tests/file-sync.test.ts all *inject* a
 * ThermalMap, so none of them execute the query. That left the actual hot path —
 * the lookup every remember/update/forget/merge performs — completely unexercised,
 * and it shipped broken twice on 2026-08-16:
 *
 *   1. `WHERE id = ANY(${ids})` — drizzle's sql template flattens a JS array into
 *      separate placeholders, emitting `ANY(($1))` with a scalar. Every call threw
 *      and fell back to frontmatter ranking, making the whole feature a no-op.
 *   2. The `process.env.DATABASE_URL` guard ran BEFORE the dynamic import of
 *      ./db.js — but importing db.js is what runs dotenv.config(), so the guard
 *      read an unpopulated env and returned the fallback sentinel on every call.
 *
 * Both failures were SILENT: fetchThermalByPgId catches everything and degrades to
 * frontmatter by design, so the only symptom was a stderr line nobody was reading.
 * Any future regression of that shape must fail a test instead.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { fetchThermalByPgId } from '../../src/file-sync.js';
import { execFileSync } from 'node:child_process';
import { insertTestMemory, cleanupMemories, closeTestDb } from './helpers.js';

describe('fetchThermalByPgId integration', () => {
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

  it('resolves live tier and temperature for a real row', async () => {
    const { id } = await insertTestMemory({ temperature: 0.42, tier: 'WARM' });
    createdIds.push(id);

    const map = await fetchThermalByPgId([id]);

    // Not null and not empty — this is the assertion both shipped bugs failed.
    expect(map).not.toBeNull();
    expect(map!.size).toBe(1);
    const row = map!.get(id)!;
    expect(row.tier).toBe('WARM');
    expect(row.temperature).toBeCloseTo(0.42, 5);
  });

  it('resolves a multi-id batch in ONE query', async () => {
    const { id: a } = await insertTestMemory({ temperature: 0.9, tier: 'HOT' });
    const { id: b } = await insertTestMemory({ temperature: 0.1, tier: 'COLD' });
    createdIds.push(a, b);

    // The array-flattening bug only reproduced with a real list, so batch size
    // > 1 is load-bearing here, not incidental.
    const map = await fetchThermalByPgId([a, b]);

    expect(map!.size).toBe(2);
    expect(map!.get(a)!.tier).toBe('HOT');
    expect(map!.get(b)!.tier).toBe('COLD');
  });

  it('returns an empty map (not null) when the database is reachable but no row matches', async () => {
    // Reachable + unmatched is the ORPHAN case: callers must rank these at
    // temperature 0, which is only distinguishable from the unreachable case
    // because this returns a Map rather than null.
    const map = await fetchThermalByPgId(['00000000-0000-4000-8000-0000000000ff']);

    expect(map).not.toBeNull();
    expect(map!.size).toBe(0);
  });

  it('returns the fallback sentinel for an empty id list without querying', async () => {
    expect(await fetchThermalByPgId([])).toBeNull();
  });

  it('ignores malformed ids rather than failing the whole lookup', async () => {
    const { id } = await insertTestMemory({ temperature: 0.5, tier: 'WARM' });
    createdIds.push(id);

    // A non-uuid must not reach the query — the ::uuid[] cast would reject the
    // whole batch and degrade a working directory to frontmatter ranking.
    const map = await fetchThermalByPgId([id, 'not-a-uuid']);

    expect(map!.size).toBe(1);
    expect(map!.get(id)!.tier).toBe('WARM');
  });

  it('resolves DATABASE_URL from dotenv in a clean environment', async () => {
    // Bug #2 above is INVISIBLE to the tests in this file: vitest's harness has
    // already populated process.env.DATABASE_URL by the time they run, so an
    // env-check-before-dotenv ordering still passes. Verified by control on
    // 2026-08-16 — reintroducing that bug left all the other cases green.
    //
    // Reproducing it requires a subprocess with DATABASE_URL genuinely unset,
    // where importing db.js (which runs dotenv.config) is the only thing that
    // populates it. If the guard runs first, this returns null and fails.
    const { id } = await insertTestMemory({ temperature: 0.77, tier: 'HOT' });
    createdIds.push(id);

    const repo = new URL('../..', import.meta.url).pathname;
    const script =
      `import { fetchThermalByPgId } from '${repo}src/file-sync.ts';` +
      `const m = await fetchThermalByPgId(['${id}']);` +
      `console.log(JSON.stringify(m === null ? null : [...m.entries()]));`;

    // Honor the harness's dotenv path — `make test-integration` points it at a
    // throwaway env file for an isolated test database. Hardcoding '.env' would
    // send the subprocess to the dev DB, where the row just seeded here does
    // not exist.
    const env = { ...process.env, DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH ?? '.env' };
    delete env.DATABASE_URL;

    const out = execFileSync(
      'node',
      ['--import', `file://${repo}node_modules/tsx/dist/loader.mjs`,
       '--input-type=module', '-e', script],
      { cwd: repo, env, encoding: 'utf-8', timeout: 60_000 },
    );

    const parsed = JSON.parse(out.trim().split('\n').pop()!);
    expect(parsed).not.toBeNull();       // null = fell back; the ordering bug
    expect(parsed).toHaveLength(1);
    expect(parsed[0][1].tier).toBe('HOT');
  });
});
