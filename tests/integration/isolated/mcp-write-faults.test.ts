/**
 * Partial failures of the write tools (the error contract), proven with REAL
 * faults — not mocks of our code: the real handlers run over the real SDK path,
 * and Postgres (or the filesystem) makes the step fail.
 *
 * Lives in isolated/ because it changes DATABASE-WIDE state — a trigger, a
 * renamed extension function. the isolated thermal suite moved exactly this class of test out of the
 * shared main set: a run killed mid-test would leave `word_similarity` missing
 * for every recall suite that ran next. Here it runs on a database it owns.
 *
 * Belt and braces on top of that: beforeAll refuses any database whose name
 * does not end in `_test` or `_isolated` — `memory_persistor_isolated_test`
 * locally, `thermal_isolated` in CI (db-guard checks the HOST, so a bare
 * `npm run test:integration:isolated` against ./.env would otherwise reach the
 * local dev DB) — and every fault is undone in afterEach AND pre-emptively in
 * beforeAll.
 *
 * The markdown faults replace MEMORY.md with a DIRECTORY rather than making it
 * read-only: CI runs as root, and root writes straight through 0444. Writing
 * to a directory path fails with EISDIR for every user.
 *
 * Stated limit (spec): dedup cannot be faulted ALONE — every function it calls,
 * auto-relate also calls. Fault A proves auto-relate's catch alone; Fault B
 * proves dedup's catch in combination.
 */
import { closeTestDb, insertTestMemory, cleanupMemory, getMemory, getRelations, testDb } from '../helpers.js';
import { connectHarness, parseErrorResult, parseOk, type Harness } from '../mcp-harness.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, gte, sql } from 'drizzle-orm';
import { entities, events } from '../../../src/schema.js';
import { CLAUDE_DIR } from '../../../src/config.js';

const ANCHOR_TEXT =
  'fault injection anchor: the quick brown fox jumps over the lazy dog near the riverbank';
const TEST_SOURCE = '/tmp/mem-faults';
const TEST_MEMORY_DIR = join(CLAUDE_DIR, 'projects', '-tmp-mem-faults', 'memory');
const seeded: string[] = [];
const remembered: string[] = [];
let h: Harness;

const INDEX = join(TEST_MEMORY_DIR, 'MEMORY.md');

/** Make the markdown index unwritable for ANY user, root included. */
function breakIndex(): void {
  rmSync(INDEX, { force: true });
  mkdirSync(INDEX);
}

async function restoreFaults(): Promise<void> {
  if (existsSync(INDEX) && statSync(INDEX).isDirectory()) rmSync(INDEX, { recursive: true, force: true });
  await testDb.execute(sql`DROP TRIGGER IF EXISTS test_fault_relations ON public.memory_relations`);
  await testDb.execute(sql`DROP FUNCTION IF EXISTS public.test_fault_relations()`);
  await testDb.execute(sql`DROP TRIGGER IF EXISTS test_fault_entity_delete ON public.entities`);
  await testDb.execute(sql`DROP FUNCTION IF EXISTS public.test_fault_entity_delete()`);
  await testDb.execute(sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'word_similarity_fault_b') THEN
        EXECUTE 'ALTER FUNCTION word_similarity_fault_b(text, text) RENAME TO word_similarity';
      END IF;
    END $$`);
}

async function seedAnchor(): Promise<string> {
  const anchor = await insertTestMemory({ name: 'Fault injection anchor', type: 'fact', observations: ANCHOR_TEXT });
  seeded.push(anchor.id);
  return anchor.id;
}

async function rememberNearDuplicate(label: string): Promise<Record<string, unknown>> {
  const body = parseOk(
    await h.client.callTool({
      name: 'remember',
      arguments: {
        name: `Fault injection anchor ${label}`,
        type: 'fact',
        observations: ANCHOR_TEXT,
        tags: ['fault-test'],
        importance: 0.1,
        source: TEST_SOURCE,
      },
    }),
  );
  remembered.push(body.id as string);
  return body;
}

/** logEvent is fire-and-forget, so poll briefly for the row rather than race it. */
async function waitForEvent(eventType: string, memoryId: string): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 20; i++) {
    const [row] = await testDb
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.eventType, eventType), eq(events.memoryId, memoryId), gte(events.createdAt, new Date(Date.now() - 60_000))))
      .limit(1);
    if (row) return row.payload as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

beforeAll(async () => {
  const { rows } = await testDb.execute(sql`SELECT current_database() AS db`);
  const db = (rows[0] as { db: string }).db;
  if (!/_(test|isolated)$/.test(db)) {
    throw new Error(`refusing to inject faults into database "${db}" — only *_test / *_isolated databases`);
  }
  await restoreFaults();
  h = await connectHarness();
});

afterEach(async () => {
  try {
    await restoreFaults();
  } finally {
    // forget (not a bare DELETE) so the markdown file remember wrote goes too.
    while (remembered.length) {
      const id = remembered.pop() as string;
      if (await getMemory(id)) parseOk(await h.client.callTool({ name: 'forget', arguments: { id } }));
    }
    while (seeded.length) await cleanupMemory(seeded.pop() as string);
  }
});

afterAll(async () => {
  try {
    await h?.close(); // undefined when beforeAll refused the database
    await closeTestDb();
  } finally {
    rmSync(join(CLAUDE_DIR, 'projects', '-tmp-mem-faults'), { recursive: true, force: true });
  }
});

describe('remember partial failures', () => {
  it('CONTROL: with no fault, the near-duplicate is auto-related AND dedup finds the anchor', async () => {
    await seedAnchor();
    const body = await rememberNearDuplicate('control');
    expect(body).not.toHaveProperty('warnings');
    expect((await getRelations(body.id as string)).length).toBeGreaterThan(0);
    // Pins that the fixture is strong enough for Fault B's "no candidates" to mean something.
    expect(body.dedup_candidates).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Fault injection anchor' })]));
  });

  it('Fault A: a failing relation insert → one auto_relate warning, write kept, dedup still works', async () => {
    await seedAnchor();
    await testDb.execute(sql`
      CREATE FUNCTION public.test_fault_relations() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fault A: injected relation insert failure'; END $$`);
    await testDb.execute(sql`
      CREATE TRIGGER test_fault_relations BEFORE INSERT ON public.memory_relations
      FOR EACH ROW EXECUTE FUNCTION public.test_fault_relations()`);

    const body = await rememberNearDuplicate('fault A');

    expect(await getMemory(body.id as string)).toBeTruthy();
    expect(body.warnings).toEqual([
      { step: 'auto_relate', errorCategory: 'internal', error: 'fault A: injected relation insert failure' },
    ]);
    expect(body.dedup_candidates).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Fault injection anchor' })]));
    expect(await waitForEvent('tool_warning', body.id as string)).toEqual({ tool: 'remember', steps: ['auto_relate'] });
  });

  it('Fault B: word_similarity unresolvable (the search_path failure mode) → both warnings, write kept', async () => {
    await seedAnchor();
    await testDb.execute(sql`ALTER FUNCTION word_similarity(text, text) RENAME TO word_similarity_fault_b`);

    const body = await rememberNearDuplicate('fault B');

    expect(await getMemory(body.id as string)).toBeTruthy();
    const warnings = body.warnings as { step: string; errorCategory: string }[];
    expect(warnings.map((w) => w.step)).toEqual(['auto_relate', 'dedup']);
    expect(warnings.every((w) => w.errorCategory === 'internal')).toBe(true);
    // CONTROL proves this fixture DOES produce candidates, so their absence
    // here is the failed check — which the dedup warning now says out loud.
    expect(body).not.toHaveProperty('dedup_candidates');
  });
});

describe('merge is atomic (the error contract gate)', () => {
  it('a failure on the final delete rolls back the target update and the edge transfer', async () => {
    const target = await insertTestMemory({ name: 'Merge fault target', observations: 'target body' });
    const source = await insertTestMemory({ name: 'Merge fault source', observations: 'source body' });
    const third = await insertTestMemory({ name: 'Merge fault neighbour' });
    seeded.push(target.id, source.id, third.id);
    await testDb.execute(sql`INSERT INTO public.memory_relations (from_id, to_id, relation_type) VALUES (${source.id}, ${third.id}, 'related_to')`);
    await testDb.execute(sql`
      CREATE FUNCTION public.test_fault_entity_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'merge fault: injected delete failure'; END $$`);
    await testDb.execute(sql`
      CREATE TRIGGER test_fault_entity_delete BEFORE DELETE ON public.entities
      FOR EACH ROW EXECUTE FUNCTION public.test_fault_entity_delete()`);

    const e = parseErrorResult(await h.client.callTool({ name: 'merge', arguments: { sourceId: source.id, targetId: target.id } }));
    expect(e.errorCategory).toBe('internal');
    await restoreFaults();

    expect((await getMemory(target.id))?.observations).toBe('target body');
    expect(await getMemory(source.id)).toBeTruthy();
    const targetEdges = (await getRelations(target.id)) as { to_id: string }[];
    expect(targetEdges.filter((r) => r.to_id === third.id)).toEqual([]);
  });
});

describe('a markdown failure after a committed write is a warning, not a failed call', () => {
  it('forget with MEMORY.md unwritable (a directory) → success, row gone, file_sync warning', async () => {
    const body = await rememberNearDuplicate('forget fault');
    const id = body.id as string; // stays in `remembered`: afterEach forgets it if this test fails first
    breakIndex();

    const res = parseOk(await h.client.callTool({ name: 'forget', arguments: { id } }));

    expect(await getMemory(id)).toBeNull();
    expect(res.success).toBe(true);
    expect((res.warnings as { step: string }[]).map((w) => w.step)).toEqual(['file_sync']);
  });

  it('update with MEMORY.md unwritable (a directory) → success, row updated, file_sync warning', async () => {
    const body = await rememberNearDuplicate('update fault');
    const id = body.id as string;
    breakIndex();

    const res = parseOk(await h.client.callTool({ name: 'update', arguments: { id, tags: ['after-fault'] } }));

    expect((await getMemory(id))?.tags).toEqual(['after-fault']);
    expect(res.updated_fields).toEqual(['tags']);
    expect((res.warnings as { step: string }[]).map((w) => w.step)).toEqual(['file_sync']);
  });

  it('merge with MEMORY.md unwritable (a directory) → committed merge, success, file_sync warning', async () => {
    const target = await rememberNearDuplicate('merge fault target');
    const source = await rememberNearDuplicate('merge fault source');
    breakIndex();

    const res = parseOk(
      await h.client.callTool({ name: 'merge', arguments: { sourceId: source.id, targetId: target.id } }),
    );

    expect(await getMemory(source.id as string)).toBeNull();
    expect(res.sourceDeleted).toBe(true);
    expect((res.warnings as { step: string }[]).map((w) => w.step)).toEqual(['file_sync']);
  });
});
