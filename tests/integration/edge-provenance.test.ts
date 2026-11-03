/**
 * Edge provenance: who made the claim an edge represents.
 *
 * 'asserted' = an explicit claim (the `relate` tool, `remember`'s `relatedTo`);
 * 'inferred' = the server's own guess (auto-relate). Centrality pays an
 * inferred edge INFERRED_EDGE_WEIGHT of an asserted one, and `merge` must never
 * downgrade an assertion.
 *
 * Write sites are exercised through a real MCP client (mcp-harness), so a
 * handler that forgets to set provenance fails here even though the column
 * default would quietly fill it in.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { connectHarness, parseOk, type Harness } from './mcp-harness.js';
import { CENTRALITY_EXPR, CENTRALITY_DENOM_EXPR } from '../../src/retrieve.js';
import { INFERRED_EDGE_WEIGHT } from '../../src/config.js';
import { mergeMemories } from '../../src/intelligence.js';
import { getHealth } from '../../src/observability.js';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  closeTestDb,
} from './helpers.js';

const PREFIX = 'edge-provenance-';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function edges(fromId: string): Promise<{ to_id: string; provenance: string; relation_type: string }[]> {
  const r = await testDb.execute(sql`
    SELECT to_id::text, provenance, relation_type FROM public.memory_relations WHERE from_id = ${fromId}
  `);
  return r.rows as { to_id: string; provenance: string; relation_type: string }[];
}

/**
 * Run `fn` against a graph holding ONLY what it inserts: every existing edge is
 * deleted inside a transaction that is always rolled back. The centrality
 * denominator is corpus-wide, so this is the only way to execute it against a
 * known graph without an empty database of its own.
 */
async function withIsolatedGraph<T>(fn: (tx: typeof testDb) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM public.memory_relations`);
      out = await fn(tx as unknown as typeof testDb);
      tx.rollback();
    });
  } catch (e) {
    if (!(e instanceof TransactionRollbackError)) throw e;
  }
  return out as T;
}

async function centrality(id: string): Promise<number> {
  const r = await testDb.execute(sql`
    SELECT ${CENTRALITY_EXPR} AS c FROM public.entities e WHERE e.id = ${id}
  `);
  return Number((r.rows[0] as { c: string | number }).c);
}

describe('edge provenance', () => {
  let h: Harness;
  const created: string[] = [];

  beforeAll(async () => {
    h = await connectHarness();
  });

  afterEach(async () => {
    if (created.length) {
      await cleanupMemories([...created]);
      created.length = 0;
    }
  });

  afterAll(async () => {
    await h.close();
    await closeTestDb();
  });

  it('the relate tool writes an ASSERTED edge', async () => {
    const a = await insertTestMemory({ name: `${PREFIX}relate a`, type: 'fact' });
    const b = await insertTestMemory({ name: `${PREFIX}relate b`, type: 'fact' });
    created.push(a.id, b.id);

    parseOk(await h.client.callTool({
      name: 'relate',
      arguments: { fromId: a.id, toId: b.id, relationType: 'elaborates' },
    }));

    expect(await edges(a.id)).toEqual([{ to_id: b.id, provenance: 'asserted', relation_type: 'elaborates' }]);
  });

  it("remember's relatedTo is ASSERTED and its auto-relate edges are INFERRED", async () => {
    // An explicit link target, plus a near-twin of the new memory so auto-relate
    // has something above AUTO_RELATE_THRESHOLD to find.
    const target = await insertTestMemory({ name: `${PREFIX}explicit target zebra`, type: 'fact' });
    const twin = await insertTestMemory({
      name: `${PREFIX}gradle daemon heap tuning`,
      type: 'fact',
      observations: 'Set org.gradle.jvmargs to raise the gradle daemon heap and stop OOM during builds.',
    });
    created.push(target.id, twin.id);

    const res = await h.client.callTool({
      name: 'remember',
      arguments: {
        name: `${PREFIX}gradle daemon heap tuning again`,
        type: 'fact',
        observations: 'Set org.gradle.jvmargs to raise the gradle daemon heap and stop OOM during builds.',
        tags: [],
        importance: 0.5,
        relatedTo: target.id,
      },
    });
    if (res.isError) throw new Error(JSON.stringify(res.content));
    const body = parseOk(res);
    const newId = String(body.id);
    created.push(newId);

    const out = await edges(newId);
    const explicit = out.filter((e) => e.to_id === target.id);
    const auto = out.filter((e) => e.to_id !== target.id);
    expect(explicit).toEqual([{ to_id: target.id, provenance: 'asserted', relation_type: 'related_to' }]);
    // Non-vacuity: the twin MUST have been auto-related, or this asserts nothing.
    expect(auto.map((e) => e.to_id)).toContain(twin.id);
    expect(auto.every((e) => e.provenance === 'inferred')).toBe(true);
  });

  it('merge preserves and upgrades INCOMING edges too (source as to_id)', async () => {
    const src = await insertTestMemory({ name: `${PREFIX}in source`, type: 'fact' });
    const tgt = await insertTestMemory({ name: `${PREFIX}in target`, type: 'fact' });
    const p = await insertTestMemory({ name: `${PREFIX}in p`, type: 'fact' });
    const q = await insertTestMemory({ name: `${PREFIX}in q`, type: 'fact' });
    created.push(tgt.id, p.id, q.id);
    await insertTestRelation(p.id, src.id, 'depends_on', 1.0, 'asserted'); // moves, keeps asserted
    await insertTestRelation(q.id, src.id, 'related_to', 1.0, 'asserted'); // duplicate below
    await insertTestRelation(q.id, tgt.id, 'related_to', 1.0, 'inferred'); // must be upgraded

    await mergeMemories(src.id, tgt.id);

    expect(await edges(p.id)).toEqual([{ to_id: tgt.id, provenance: 'asserted', relation_type: 'depends_on' }]);
    expect(await edges(q.id)).toEqual([{ to_id: tgt.id, provenance: 'asserted', relation_type: 'related_to' }]);
  });

  it('merge preserves each transferred edge’s provenance', async () => {
    const src = await insertTestMemory({ name: `${PREFIX}merge source`, type: 'fact' });
    const tgt = await insertTestMemory({ name: `${PREFIX}merge target`, type: 'fact' });
    const x = await insertTestMemory({ name: `${PREFIX}merge x`, type: 'fact' });
    const y = await insertTestMemory({ name: `${PREFIX}merge y`, type: 'fact' });
    created.push(tgt.id, x.id, y.id); // src is deleted by the merge
    await insertTestRelation(src.id, x.id, 'related_to', 1.0, 'asserted');
    await insertTestRelation(src.id, y.id, 'related_to', 1.0, 'inferred');

    await mergeMemories(src.id, tgt.id);

    const out = Object.fromEntries((await edges(tgt.id)).map((e) => [e.to_id, e.provenance]));
    expect(out).toEqual({ [x.id]: 'asserted', [y.id]: 'inferred' });
  });

  it('merge survives an identical edge committed while it runs', async () => {
    // merge's NOT EXISTS reads its snapshot, so only ON CONFLICT stops this
    // edge from failing the merge on the unique index. A second connection
    // holds target→x uncommitted; merge's INSERT blocks on it; then it commits.
    const src = await insertTestMemory({ name: `${PREFIX}race source`, type: 'fact' });
    const tgt = await insertTestMemory({ name: `${PREFIX}race target`, type: 'fact' });
    const x = await insertTestMemory({ name: `${PREFIX}race x`, type: 'fact' });
    const y = await insertTestMemory({ name: `${PREFIX}race y`, type: 'fact' });
    created.push(tgt.id, x.id, y.id);
    await insertTestRelation(src.id, x.id, 'related_to', 1.0, 'inferred');
    await insertTestRelation(src.id, y.id, 'related_to', 1.0, 'inferred');

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const held = new Promise<void>((r) => { holding = r; });
    const holder = testDb.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO public.memory_relations (from_id, to_id, relation_type, provenance)
        VALUES (${tgt.id}, ${x.id}, 'related_to', 'inferred')
      `);
      holding();
      await gate;
    });
    await held;

    const merging = mergeMemories(src.id, tgt.id);
    // Proceed once merge's INSERT is waiting on the held row's lock. Without
    // that wait the race never happened and the test would prove nothing.
    let waited = false;
    for (let i = 0; i < 250 && !waited; i++) {
      const w = await testDb.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          -- Not the INSERT keyword: pg_stat_activity truncates query text at
          -- track_activity_query_size (1024 B), before merge's INSERT.
          AND query LIKE '%source_edges%'
      `);
      waited = w.rows.length > 0;
      if (!waited) await new Promise((r) => setTimeout(r, 20));
    }
    release();
    expect(waited).toBe(true);
    await holder;

    const result = await merging;
    expect(result.edgesTransferred).toBe(1); // y only; x was taken by the held row
    expect((await edges(tgt.id)).map((e) => e.to_id).sort()).toEqual([x.id, y.id].sort());
  });

  it('merge UPGRADES a target edge that the source asserted', async () => {
    // Both sides hold (→ x, related_to). The duplicate filter keeps the
    // target's row; it must not stay 'inferred' when the source asserted it.
    const src = await insertTestMemory({ name: `${PREFIX}upgrade source`, type: 'fact' });
    const tgt = await insertTestMemory({ name: `${PREFIX}upgrade target`, type: 'fact' });
    const x = await insertTestMemory({ name: `${PREFIX}upgrade x`, type: 'fact' });
    const z = await insertTestMemory({ name: `${PREFIX}upgrade z`, type: 'fact' });
    created.push(tgt.id, x.id, z.id);
    await insertTestRelation(src.id, x.id, 'related_to', 1.0, 'asserted');
    await insertTestRelation(tgt.id, x.id, 'related_to', 1.0, 'inferred');
    // Control: an inferred duplicate on the source must NOT promote anything.
    await insertTestRelation(src.id, z.id, 'elaborates', 1.0, 'inferred');
    await insertTestRelation(tgt.id, z.id, 'elaborates', 1.0, 'inferred');

    await mergeMemories(src.id, tgt.id);

    const out = await edges(tgt.id);
    expect(out.filter((e) => e.to_id === x.id)).toEqual([{ to_id: x.id, provenance: 'asserted', relation_type: 'related_to' }]);
    expect(out.filter((e) => e.to_id === z.id)).toEqual([{ to_id: z.id, provenance: 'inferred', relation_type: 'elaborates' }]);
  });

  it('centrality pays an inferred edge INFERRED_EDGE_WEIGHT of an asserted one', async () => {
    const a = await insertTestMemory({ name: `${PREFIX}cent asserted hub`, type: 'fact' });
    const i = await insertTestMemory({ name: `${PREFIX}cent inferred hub`, type: 'fact' });
    const leaves = await Promise.all([0, 1, 2].map((n) =>
      insertTestMemory({ name: `${PREFIX}cent leaf ${n}`, type: 'fact' })));
    created.push(a.id, i.id, ...leaves.map((l) => l.id));
    for (const l of leaves) {
      await insertTestRelation(a.id, l.id, 'related_to', 1.0, 'asserted');
      await insertTestRelation(i.id, l.id, 'related_to', 1.0, 'inferred');
    }

    expect(await centrality(a.id)).toBeCloseTo(3, 10);
    expect(await centrality(i.id)).toBeCloseTo(3 * INFERRED_EDGE_WEIGHT, 10);
  });

  it('the normalized ratio stays ≤ 1.0 for an all-inferred hub that sets the max', async () => {
    // Adversarial, like centrality-bound.test.ts: the hub's INFERRED edges alone
    // must exceed every other node's weighted degree, so a raw-count numerator
    // over the weighted denominator (the dangerous mismatch) yields 2.0.
    const maxW = Number(((await testDb.execute(sql`
      SELECT COALESCE(MAX(${CENTRALITY_EXPR}), 0) AS m FROM public.entities e
    `)).rows[0] as { m: number }).m);
    const n = Math.floor(maxW / INFERRED_EDGE_WEIGHT) + 2;
    const hub = await insertTestMemory({ name: `${PREFIX}bound hub`, type: 'fact' });
    created.push(hub.id);
    // One leaf per edge: the unique (from, to, type) index rejects a repeat.
    for (let k = 0; k < n; k++) {
      const leaf = await insertTestMemory({ name: `${PREFIX}bound leaf ${k}`, type: 'fact' });
      created.push(leaf.id);
      await insertTestRelation(hub.id, leaf.id, 'related_to', 1.0, 'inferred');
    }

    const r = (await testDb.execute(sql`
      SELECT ${CENTRALITY_EXPR} / ${CENTRALITY_DENOM_EXPR} AS ratio,
             (SELECT COUNT(*)::float FROM public.memory_relations rel
              WHERE rel.from_id = e.id OR rel.to_id = e.id) / ${CENTRALITY_DENOM_EXPR} AS raw_ratio
      FROM public.entities e WHERE e.id = ${hub.id}
    `)).rows[0] as { ratio: number; raw_ratio: number };
    expect(Number(r.ratio)).toBeCloseTo(1.0, 10);
    // Non-vacuity: the mismatched formula really does break the bound here.
    expect(Number(r.raw_ratio)).toBeGreaterThan(1.0);
  });

  it('a single inferred edge normalizes to 1.0 — no 1.0 floor shrinks small graphs', async () => {
    // The uniform-provenance invariant at its sharpest: max weighted degree is
    // INFERRED_EDGE_WEIGHT (< 1), so a GREATEST(1.0, …) floor would report 0.5.
    const a = await insertTestMemory({ name: `${PREFIX}single a`, type: 'fact' });
    const b = await insertTestMemory({ name: `${PREFIX}single b`, type: 'fact' });
    created.push(a.id, b.id);
    const r = await withIsolatedGraph(async (tx) => {
      await tx.execute(sql`
        INSERT INTO public.memory_relations (from_id, to_id, relation_type, provenance)
        VALUES (${a.id}, ${b.id}, 'related_to', 'inferred')
      `);
      return (await tx.execute(sql`
        SELECT ${CENTRALITY_DENOM_EXPR} AS denom, ${CENTRALITY_EXPR} / ${CENTRALITY_DENOM_EXPR} AS ratio
        FROM public.entities e WHERE e.id = ${a.id}
      `)).rows[0] as { denom: number; ratio: number };
    });
    expect(Number(r.denom)).toBeCloseTo(INFERRED_EDGE_WEIGHT, 10);
    expect(Number(r.ratio)).toBeCloseTo(1.0, 10);
  });

  it('the denominator is 1.0 on a graph with no edges at all', async () => {
    const d = await withIsolatedGraph(async (tx) =>
      Number(((await tx.execute(sql`SELECT ${CENTRALITY_DENOM_EXPR} AS d`)).rows[0] as { d: number }).d));
    expect(d).toBe(1.0);
  });

  it('the DATABASE default is still inferred — earlier machines omit the column', async () => {
    // schema.ts deliberately has no .default(), so nothing in TypeScript pins
    // this. Old code inserting without provenance depends on it mid-rollout.
    const a = await insertTestMemory({ name: `${PREFIX}default a`, type: 'fact' });
    const b = await insertTestMemory({ name: `${PREFIX}default b`, type: 'fact' });
    created.push(a.id, b.id);
    await testDb.execute(sql`
      INSERT INTO public.memory_relations (from_id, to_id, relation_type) VALUES (${a.id}, ${b.id}, 'related_to')
    `);
    expect((await edges(a.id))[0].provenance).toBe('inferred');
  });

  it('health reports the asserted / inferred split', async () => {
    const a = await insertTestMemory({ name: `${PREFIX}health a`, type: 'fact' });
    const b = await insertTestMemory({ name: `${PREFIX}health b`, type: 'fact' });
    created.push(a.id, b.id);
    const before = (await getHealth()).edgeProvenance;
    await insertTestRelation(a.id, b.id, 'related_to', 1.0, 'asserted');
    await insertTestRelation(b.id, a.id, 'related_to', 1.0, 'inferred');
    await insertTestRelation(b.id, a.id, 'elaborates', 1.0, 'inferred');

    const after = (await getHealth()).edgeProvenance;
    expect(after.asserted - before.asserted).toBe(1);
    expect(after.inferred - before.inferred).toBe(2);
  });

  it('migration 0016 backfills ASSERTED from logged relate events, and only those', async () => {
    const a = await insertTestMemory({ name: `${PREFIX}backfill a`, type: 'fact' });
    const b = await insertTestMemory({ name: `${PREFIX}backfill b`, type: 'fact' });
    created.push(a.id, b.id);
    await insertTestRelation(a.id, b.id, 'supersedes', 1.0, 'inferred'); // has a relate event
    await insertTestRelation(a.id, b.id, 'related_to', 1.0, 'inferred'); // type differs from the event
    await insertTestRelation(b.id, a.id, 'supersedes', 1.0, 'inferred'); // direction differs
    // Upper-case toId: zod's .uuid() accepts it, uuid::text never produces it.
    await testDb.execute(sql`
      INSERT INTO public.events (event_type, memory_id, payload)
      VALUES ('relate', ${a.id}, ${JSON.stringify({ toId: b.id.toUpperCase(), relationType: 'supersedes', weight: 1 })}::jsonb)
    `);

    try {
      // Re-apply the whole migration: it must be idempotent AND perform the backfill.
      const migration = readFileSync(resolve(repoRoot, 'drizzle/0016_relation_provenance.sql'), 'utf-8');
      await testDb.execute(sql.raw(migration));

      const got = (await testDb.execute(sql`
        SELECT from_id::text, relation_type, provenance FROM public.memory_relations
        WHERE from_id IN (${a.id}, ${b.id}) ORDER BY from_id = ${a.id} DESC, relation_type
      `)).rows;
      expect(got).toEqual([
        { from_id: a.id, relation_type: 'related_to', provenance: 'inferred' },
        { from_id: a.id, relation_type: 'supersedes', provenance: 'asserted' },
        { from_id: b.id, relation_type: 'supersedes', provenance: 'inferred' },
      ]);
    } finally {
      await testDb.execute(sql`DELETE FROM public.events WHERE memory_id = ${a.id} AND event_type = 'relate'`);
    }
  });

  it('the CHECK constraint rejects an unknown provenance', async () => {
    const a = await insertTestMemory({ name: `${PREFIX}check a`, type: 'fact' });
    const b = await insertTestMemory({ name: `${PREFIX}check b`, type: 'fact' });
    created.push(a.id, b.id);
    // Pinned to the CHECK itself (SQLSTATE 23514 + its name), not "any error":
    // an FK or syntax failure must not satisfy this test.
    const err = await testDb.execute(sql`
      INSERT INTO public.memory_relations (from_id, to_id, relation_type, provenance)
      VALUES (${a.id}, ${b.id}, 'related_to', 'merged')
    `).then(() => null, (e: unknown) => e as { cause?: { code?: string; constraint?: string }; code?: string; constraint?: string });
    const pgErr = err?.cause ?? err;
    expect(pgErr?.code).toBe('23514');
    expect(pgErr?.constraint).toBe('memory_relations_provenance_check');
  });
});
