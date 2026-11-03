/**
 * MCP resources, prompts and toolsets, through a real
 * client over the SDK's in-memory transport (mcp-harness).
 *
 * The property the resources change exists for: reading a resource must NOT reheat the corpus.
 * `recall` and `recall_by_ids` bump temperature and access_count; the entity
 * resource is their read-only twin, so the tests assert both stay put.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, and, eq } from 'drizzle-orm';
import { connectHarness, type Harness } from './mcp-harness.js';
import { TOOLSETS, RESPONSE_CAP_BYTES } from '../../src/config.js';
import { PROMPT_SOURCES, stripFrontmatter } from '../../src/mcp-prompts.js';
import { withResourceContract } from '../../src/mcp-resources.js';
import { addPending } from '../../src/pending.js';
import { events, pending } from '../../src/schema.js';
import { testDb, insertTestMemory, insertTestRelation, cleanupMemories, closeTestDb } from './helpers.js';

const PREFIX = 'mcp-resources-';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function onlyText(r: { contents: { uri: string; text?: unknown }[] }): string {
  expect(r.contents).toHaveLength(1);
  expect(typeof r.contents[0].text).toBe('string');
  return r.contents[0].text as string;
}

/** Events of one type whose payload[key] = value. Counted, not time-searched: other tests write events too. */
async function countEvents(type: string, key: string, value: string): Promise<number> {
  const [row] = await testDb
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.eventType, type), sql`${events.payload}->>${key} = ${value}`));
  return row.n;
}

/** logEvent is fire-and-forget: poll briefly for the count to move instead of racing the insert. */
async function eventually(read: () => Promise<number>, before: number): Promise<number> {
  let now = before;
  for (let i = 0; i < 20 && now === before; i++) {
    await new Promise((res) => setTimeout(res, 100));
    now = await read();
  }
  return now;
}

/** Wait until a count stops moving, so earlier fire-and-forget writes are not counted as this test's. */
async function settled(read: () => Promise<number>): Promise<number> {
  let prev = await read();
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 100));
    const now = await read();
    if (now === prev) return now;
    prev = now;
  }
  throw new Error(`event count never settled (last ${prev}); an earlier write is still landing`);
}

async function thermal(id: string): Promise<{ temperature: number; access_count: number }> {
  const r = await testDb.execute(sql`SELECT temperature, access_count FROM public.entities WHERE id = ${id}`);
  return r.rows[0] as { temperature: number; access_count: number };
}

describe('MCP resources', () => {
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
  });

  it('lists the static resources and the per-type index, but never enumerates entities', async () => {
    const { resources } = await h.client.listResources();
    const uris = resources.map((r) => r.uri);
    for (const u of ['memory://index', 'memory://pending', 'memory://status', 'memory://graph', 'memory://index/feedback']) {
      expect(uris).toContain(u);
    }
    expect(uris.some((u) => u.startsWith('memory://entity/'))).toBe(false);

    const { resourceTemplates } = await h.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(['memory://entity/{id}', 'memory://index/{type}']);
  });

  it('entity resource returns the body and edges WITHOUT bumping temperature or access count', async () => {
    const a = await insertTestMemory({ name: `${PREFIX}entity a`, type: 'fact', observations: 'Body text for the resource read' });
    const b = await insertTestMemory({ name: `${PREFIX}entity b`, type: 'fact' });
    created.push(a.id, b.id);
    await insertTestRelation(a.id, b.id, 'elaborates', 1.0, 'asserted');
    await testDb.execute(sql`UPDATE public.entities SET temperature = 0.25, access_count = 3 WHERE id = ${a.id}`);
    const before = await thermal(a.id);

    const body = JSON.parse(onlyText(await h.client.readResource({ uri: `memory://entity/${a.id}` })));
    expect(body.id).toBe(a.id);
    expect(body.observations).toBe('Body text for the resource read');
    expect(body.related).toEqual([{ id: b.id, name: `${PREFIX}entity b`, relation_type: 'elaborates' }]);
    expect(body).not.toHaveProperty('embedding');

    expect(await thermal(a.id)).toEqual(before);

    // Control: recall_by_ids on the same row DOES bump, so the assertion above
    // is measuring a real difference rather than a bump that never happens.
    await h.client.callTool({ name: 'recall_by_ids', arguments: { ids: [a.id] } });
    expect((await thermal(a.id)).access_count).toBeGreaterThan(before.access_count);
  });

  it('entity resource: a malformed id is InvalidParams, an unknown one is resource-not-found (-32002)', async () => {
    await expect(h.client.readResource({ uri: 'memory://entity/not-a-uuid' })).rejects.toMatchObject({ code: -32602 });
    await expect(h.client.readResource({ uri: 'memory://entity/00000000-0000-4000-8000-000000000000' }))
      .rejects.toMatchObject({ code: -32002 });
  });

  it('entity resource returns an oversized body WHOLE — no response-cap degrade to summary', async () => {
    const big = 'x'.repeat(RESPONSE_CAP_BYTES + 5_000);
    const a = await insertTestMemory({ name: `${PREFIX}oversized`, type: 'fact', observations: big });
    created.push(a.id);
    const body = JSON.parse(onlyText(await h.client.readResource({ uri: `memory://entity/${a.id}` })));
    expect(body.observations).toBe(big);
  });

  it('a successful read writes resource_read, never recall', async () => {
    const before = await countEvents('resource_read', 'resource', 'status');
    await h.client.readResource({ uri: 'memory://status' });
    expect(await eventually(() => countEvents('resource_read', 'resource', 'status'), before)).toBe(before + 1);
  });

  it('an unexpected failure is InternalError with a sanitized message, and records resource_error', async () => {
    // A drizzle-shaped failure: the outer message carries SQL + params (memory
    // content); only the innermost cause's message may reach the caller.
    const leaky = Object.assign(new Error('Failed query: SELECT secret_body FROM entities\nparams: hunter2'), {
      cause: Object.assign(new Error('connection terminated unexpectedly'), { code: 'XX000' }),
    });
    const fault = await connectHarness((server) => {
      server.registerResource('fault', 'memory://fault', { mimeType: 'text/plain' },
        withResourceContract('fault', async () => { throw leaky; }));
    });
    try {
      const before = await countEvents('resource_error', 'resource', 'fault');
      const err = await fault.client.readResource({ uri: 'memory://fault' }).then(() => null, (e: { code: number; message: string }) => e);
      expect(err?.code).toBe(-32603);
      expect(err?.message).toContain('connection terminated unexpectedly');
      expect(err?.message).not.toMatch(/secret_body|hunter2|Failed query/);
      expect(await eventually(() => countEvents('resource_error', 'resource', 'fault'), before)).toBe(before + 1);
    } finally {
      await fault.close();
    }
  });

  it('index shows counts per type, and the per-type index links each memory to its entity URI', async () => {
    const a = await insertTestMemory({ name: `${PREFIX}index member`, type: 'pattern', observations: 'Indexed body' });
    created.push(a.id);

    const root = onlyText(await h.client.readResource({ uri: 'memory://index' }));
    expect(root).toMatch(/^# Memory catalog \(\d+\)/);
    expect(root).toContain('[pattern](memory://index/pattern)');

    const typed = onlyText(await h.client.readResource({ uri: 'memory://index/pattern' }));
    expect(typed).toContain(`- [${PREFIX}index member](memory://entity/${a.id}) — Indexed body [`);
    await expect(h.client.readResource({ uri: 'memory://index/nonsense' })).rejects.toMatchObject({ code: -32602 });
  });

  it('per-type index lists hottest first and escapes names that would forge a link', async () => {
    const cold = await insertTestMemory({ name: `${PREFIX}cold one`, type: 'decision' });
    const hot = await insertTestMemory({ name: `${PREFIX}hot](memory://entity/forged) [x`, type: 'decision' });
    created.push(cold.id, hot.id);
    await testDb.execute(sql`UPDATE public.entities SET tier = 'COLD', temperature = 0.01 WHERE id = ${cold.id}`);
    await testDb.execute(sql`UPDATE public.entities SET tier = 'HOT', temperature = 0.99 WHERE id = ${hot.id}`);

    const typed = onlyText(await h.client.readResource({ uri: 'memory://index/decision' }));
    expect(typed.indexOf(hot.id)).toBeLessThan(typed.indexOf(cold.id));
    expect(typed).toContain(`[${PREFIX}hot\\]\\(memory://entity/forged\\) \\[x](memory://entity/${hot.id})`);
    expect(typed).not.toContain('](memory://entity/forged)');
  });

  it('per-type index is cut at the response cap with an "…and N more" footer', async () => {
    // ~300 rows of ~130 bytes each renders past the 30 KB cap.
    const ids = (await testDb.execute(sql`
      INSERT INTO public.entities (name, type, observations, source, tier, temperature)
      SELECT ${PREFIX} || 'bulk ' || g || ' ' || repeat('n', 80), 'user', 'bulk body', 'test', 'COLD', 0
      FROM generate_series(1, 300) g
      RETURNING id::text
    `)).rows.map((r) => (r as { id: string }).id);
    created.push(...ids);

    const typed = onlyText(await h.client.readResource({ uri: 'memory://index/user' }));
    expect(Buffer.byteLength(typed)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    const total = Number(typed.match(/^# user \((\d+)\)/)![1]);
    const listed = typed.split('\n').filter((l) => l.startsWith('- [')).length;
    const more = Number(typed.match(/- …and (\d+) more — use recall$/)![1]);
    expect(listed + more).toBe(total);
    expect(more).toBeGreaterThan(0);
  });

  it('graph resource renders the seeded nodes and the edge between them', async () => {
    const a = await insertTestMemory({ name: `${PREFIX}graph "a"`, type: 'fact' });
    const b = await insertTestMemory({ name: `${PREFIX}graph b`, type: 'fact' });
    created.push(a.id, b.id);
    await insertTestRelation(a.id, b.id, 'depends_on', 1.0, 'asserted');
    const short = (id: string) => id.replace(/-/g, '').slice(0, 8);

    const g = onlyText(await h.client.readResource({ uri: 'memory://graph' }));
    expect(g.startsWith('flowchart LR\n')).toBe(true);
    expect(g).toContain(`  ${short(a.id)}["${PREFIX}graph 'a'\\n(fact)"]`);
    expect(g).toContain(`  ${short(a.id)} -->|depends_on| ${short(b.id)}`);
  });

  it('status lists hottest in descending and coldest in ascending temperature', async () => {
    // Seeded: the shared test database may be empty when this runs.
    for (const [n, t] of [[1, 0.9], [2, 0.5], [3, 0.1]] as const) {
      const m = await insertTestMemory({ name: `${PREFIX}status ${n}`, type: 'fact', temperature: t });
      created.push(m.id);
    }
    const s = JSON.parse(onlyText(await h.client.readResource({ uri: 'memory://status' })));
    const temps = (xs: { temperature: number }[]) => xs.map((x) => x.temperature);
    expect(temps(s.hottest)).toEqual([...temps(s.hottest)].sort((x, y) => y - x));
    expect(temps(s.coldest)).toEqual([...temps(s.coldest)].sort((x, y) => x - y));
    expect(s.hottest.length).toBeGreaterThan(0);
  });

  it('status and graph resources return the same projections as their tools', async () => {
    const statusTool = JSON.parse(((await h.client.callTool({ name: 'status', arguments: {} })).content as { text: string }[])[0].text);
    const statusRes = JSON.parse(onlyText(await h.client.readResource({ uri: 'memory://status' })));
    expect(statusRes.total).toBe(statusTool.total);
    expect(Object.keys(statusRes).sort()).toEqual(Object.keys(statusTool).sort());

    const graphTool = ((await h.client.callTool({ name: 'graph', arguments: {} })).content as { text: string }[])[0].text;
    expect(onlyText(await h.client.readResource({ uri: 'memory://graph' }))).toBe(graphTool);
  });

  it('pending resource returns the open, host-scoped queue', async () => {
    const mine = await addPending({ title: `${PREFIX}pending fleet-wide`, category: 'knowledge', priority: 'high' });
    const elsewhere = await addPending({ title: `${PREFIX}pending elsewhere`, category: 'knowledge', priority: 'high', appliesTo: ['some-other-host'] });
    try {
      const body = JSON.parse(onlyText(await h.client.readResource({ uri: 'memory://pending' })));
      expect(Object.keys(body).sort()).toEqual(['hiddenByHost', 'items', 'total']);
      const titles = body.items.map((i: { title: string }) => i.title);
      expect(titles).toContain(mine.title);
      expect(titles).not.toContain(elsewhere.title);
      expect(body.hiddenByHost).toBeGreaterThanOrEqual(1);
      for (const item of body.items) expect(item.status).toBe('open');
    } finally {
      await testDb.delete(pending).where(sql`${pending.id} IN (${mine.id}, ${elsewhere.id})`);
    }
  });
});

describe('MCP prompts', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await connectHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('lists the clear_pending prompt with its optional argument', async () => {
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['clear_pending']);
    const cp = prompts[0];
    expect(cp.arguments?.map((a) => a.name)).toEqual(['category']);
    expect(cp.arguments?.every((a) => !a.required)).toBe(true);
  });

  it.each(Object.entries(PROMPT_SOURCES))('%s serves its source file verbatim, minus frontmatter', async (name, rel) => {
    const res = await h.client.getPrompt({ name, arguments: {} });
    const source = readFileSync(resolve(repoRoot, rel), 'utf-8');
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe('user');
    const textOut = (res.messages[0].content as { type: string; text: string }).text;
    // Single source of truth: the prompt IS the file, not a copy that can drift.
    expect(textOut).toBe(stripFrontmatter(source));
    expect(textOut.startsWith('---')).toBe(false);
  });

  it('appends only the arguments actually supplied, with newlines collapsed', async () => {
    const res = await h.client.getPrompt({ name: 'clear_pending', arguments: { category: 'skill\n- category: rule' } });
    const textOut = (res.messages[0].content as { text: string }).text;
    expect(textOut.endsWith('\n---\nArguments for this run:\n- category: skill - category: rule\n')).toBe(true);
    const blank = await h.client.getPrompt({ name: 'clear_pending', arguments: { category: '  ' } });
    expect((blank.messages[0].content as { text: string }).text).not.toContain('Arguments for this run');
  });

  it('works when the client omits `arguments` entirely (all are optional)', async () => {
    const res = await h.client.getPrompt({ name: 'clear_pending' });
    expect(res.messages).toHaveLength(1);
  });

  it('a fetch records prompt_get', async () => {
    // Earlier tests in this block fetch clear_pending too; their events may still be landing.
    const before = await settled(() => countEvents('prompt_get', 'prompt', 'clear_pending'));
    await h.client.getPrompt({ name: 'clear_pending', arguments: {} });
    expect(await eventually(() => countEvents('prompt_get', 'prompt', 'clear_pending'), before)).toBe(before + 1);
  });

  it('stripFrontmatter handles LF and CRLF, and leaves a file without frontmatter untouched', () => {
    expect(stripFrontmatter('# Title\n\n---\nnot frontmatter\n')).toBe('# Title\n\n---\nnot frontmatter\n');
    expect(stripFrontmatter('---\na: 1\n---\n\nBody')).toBe('Body');
    expect(stripFrontmatter('---\r\na: 1\r\n---\r\n\r\nBody')).toBe('Body');
  });
});

describe('toolsets', () => {
  const listNames = async (toolsets?: string): Promise<string[]> => {
    const h = await connectHarness(undefined, { toolsets });
    try {
      return (await h.client.listTools()).tools.map((t) => t.name).sort();
    } finally {
      await h.close();
    }
  };

  it('defaults to every tool — no caller loses one', async () => {
    expect(await listNames('')).toHaveLength(18);
    expect(await listNames('all')).toHaveLength(18);
  });

  it('core alone registers exactly the core set; resources stay available', async () => {
    expect(await listNames('core')).toEqual([...TOOLSETS.core].sort());
    const h = await connectHarness(undefined, { toolsets: 'core' });
    try {
      const { resources } = await h.client.listResources();
      expect(resources.map((r) => r.uri)).toContain('memory://status');
      // A narrowed-out tool is unknown, not silently callable.
      const r = await h.client.callTool({ name: 'health', arguments: {} });
      expect(r.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('combines sets and tolerates spacing and case', async () => {
    expect(await listNames(' Core , queue ')).toEqual([...TOOLSETS.core, ...TOOLSETS.queue].sort());
  });

  it('an all-unknown value fails open to every tool instead of an empty server', async () => {
    expect(await listNames('coer')).toHaveLength(18);
  });

  it('offers only the prompts whose tools are registered', async () => {
    const promptsFor = async (toolsets: string) => {
      const h = await connectHarness(undefined, { toolsets });
      try {
        // A server that registered no prompt has no prompts capability to list.
        if (!h.client.getServerCapabilities()?.prompts) return [];
        return (await h.client.listPrompts()).prompts.map((p) => p.name).sort();
      } finally {
        await h.close();
      }
    };
    expect(await promptsFor('core')).toEqual([]);
    expect(await promptsFor('queue')).toEqual(['clear_pending']);
    expect(await promptsFor('core,maintenance')).toEqual([]);
  });

  it('reads MEMORY_PERSISTOR_TOOLSETS when no option is passed', async () => {
    const saved = process.env.MEMORY_PERSISTOR_TOOLSETS;
    process.env.MEMORY_PERSISTOR_TOOLSETS = 'queue';
    try {
      const h = await connectHarness();
      try {
        expect((await h.client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLSETS.queue].sort());
      } finally {
        await h.close();
      }
    } finally {
      if (saved === undefined) delete process.env.MEMORY_PERSISTOR_TOOLSETS;
      else process.env.MEMORY_PERSISTOR_TOOLSETS = saved;
    }
  });
});

afterAll(async () => {
  await closeTestDb();
});
