/**
 * The MCP error contract, exercised through a real Client over the SDK's
 * in-memory transport — registration, SDK input validation, the handler and
 * withErrorContract together. One test per row of the spec's failure table.
 */
import { closeTestDb, insertTestMemory, cleanupMemory, testDb } from './helpers.js';
import { connectHarness, parseErrorResult, parseOk, type Harness } from './mcp-harness.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { entities, events, pending } from '../../src/schema.js';
import { withErrorContract } from '../../src/mcp-tools.js';
import { CLAUDE_DIR } from '../../src/config.js';

// remember writes markdown under CLAUDE_DIR/projects/<encoded source>. forget
// removes the memory file but not the index or the directory, so the whole
// directory this suite creates is removed at the end.
const TEST_SOURCE = '/tmp/mem-contract';
const TEST_PROJECT_DIR = join(CLAUDE_DIR, 'projects', '-tmp-mem-contract');

const MISSING = '00000000-0000-4000-8000-00000000abcd';
const created: string[] = [];
// Created through the remember TOOL, which also writes markdown — cleaned up via
// forget so the file goes too (cleanupMemory only deletes the row).
const remembered: string[] = [];
let h: Harness;

beforeAll(async () => {
  h = await connectHarness((server) => {
    // Fixture tool: the only way to reach the transient branch without killing
    // the database. It exercises our wrapper, not a mock of our code.
    server.registerTool(
      'fixture_transient',
      { description: 'test-only: throws a pg 57P01', inputSchema: {} },
      withErrorContract('fixture_transient', async () => {
        throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      }),
    );
    // A bug, not a condition: an unclassified exception must surface as
    // internal and NOT retryable — the category that stops retry loops.
    server.registerTool(
      'fixture_internal',
      { description: 'test-only: throws a plain Error', inputSchema: {} },
      withErrorContract('fixture_internal', async () => {
        throw new Error('unexpected null in handler');
      }),
    );
  });
});

afterAll(async () => {
  try {
    for (const id of remembered) parseOk(await call('forget', { id }));
    for (const id of created) await cleanupMemory(id);
  } finally {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    await h.close();
    await closeTestDb();
  }
});

/** tool_error events for one tool + category. Counted, not searched by time: other tests make the same call. */
async function countToolErrors(tool: string, category: string): Promise<number> {
  const [row] = await testDb
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(
      and(
        eq(events.eventType, 'tool_error'),
        sql`${events.payload}->>'tool' = ${tool}`,
        sql`${events.payload}->>'errorCategory' = ${category}`,
      ),
    );
  return row.n;
}

const call = (name: string, args: Record<string, unknown>) => h.client.callTool({ name, arguments: args });

describe('failures that used to return as success', () => {
  it('forget on an unknown id → validation', async () => {
    const e = parseErrorResult(await call('forget', { id: MISSING }));
    expect(e.errorCategory).toBe('validation');
    expect(e.error).toContain(MISSING);
  });

  it('update on an unknown id → validation', async () => {
    const e = parseErrorResult(await call('update', { id: MISSING, tags: ['x'] }));
    expect(e.errorCategory).toBe('validation');
  });

  it('update with no fields → validation', async () => {
    const m = await insertTestMemory({ name: 'contract update no fields' });
    created.push(m.id);
    const e = parseErrorResult(await call('update', { id: m.id }));
    expect(e.errorCategory).toBe('validation');
  });

  it('merge on an unknown id → validation (no longer a success-shaped catch)', async () => {
    const m = await insertTestMemory({ name: 'contract merge target' });
    created.push(m.id);
    const e = parseErrorResult(await call('merge', { sourceId: MISSING, targetId: m.id }));
    expect(e.errorCategory).toBe('validation');
  });

  it('relate to an unknown id → validation, via the FK violation', async () => {
    const m = await insertTestMemory({ name: 'contract relate source' });
    created.push(m.id);
    const e = parseErrorResult(await call('relate', { fromId: m.id, toId: MISSING, relationType: 'related_to' }));
    expect(e.errorCategory).toBe('validation');
    expect(e.error).not.toContain('Failed query');
  });
});

describe('failures that already threw now carry a category', () => {
  it('remember with a filename-style name → validation', async () => {
    const e = parseErrorResult(
      await call('remember', {
        name: 'feedback_contract_stem',
        type: 'feedback',
        observations: 'x',
        tags: [],
        importance: 0.1,
      }),
    );
    expect(e.errorCategory).toBe('validation');
  });

  it('update renaming to a filename-style name → validation', async () => {
    const m = await insertTestMemory({ name: 'contract rename guard' });
    created.push(m.id);
    const e = parseErrorResult(await call('update', { id: m.id, name: 'fact_contract_stem' }));
    expect(e.errorCategory).toBe('validation');
  });

  it('pending_resolve on a missing item → business', async () => {
    const e = parseErrorResult(await call('pending_resolve', { id: MISSING }));
    expect(e.errorCategory).toBe('business');
  });

  it('pending_update on a closed item → business', async () => {
    const added = parseOk(
      await call('pending_add', { title: 'contract closed item', category: 'knowledge', priority: 'low' }),
    );
    const id = added.id as string;
    try {
      parseOk(await call('pending_resolve', { id }));
      const e = parseErrorResult(await call('pending_update', { id, title: 'renamed' }));
      expect(e.errorCategory).toBe('business');
    } finally {
      await testDb.delete(pending).where(eq(pending.id, id));
    }
  });

  it('pending_update with no fields → validation (from the library)', async () => {
    const e = parseErrorResult(await call('pending_update', { id: MISSING }));
    expect(e.errorCategory).toBe('validation');
  });

  it('remember with an unknown relatedTo → validation, and NOTHING is written', async () => {
    // The link used to be inserted AFTER the entity and its markdown: the call
    // failed with the memory already stored, so "fix the input and retry"
    // created a duplicate. The target is now checked before any write.
    const name = 'Contract remember unknown relatedTo';
    const e = parseErrorResult(
      await call('remember', {
        name, type: 'fact', observations: 'x', tags: [], importance: 0.1, source: TEST_SOURCE, relatedTo: MISSING,
      }),
    );
    expect(e.errorCategory).toBe('validation');
    expect(e.error).toContain(MISSING);
    const rows = await testDb.select({ id: entities.id }).from(entities).where(eq(entities.name, name));
    expect(rows).toEqual([]);
  });

  it('an unknown tool name → validation (SDK path, not a bug)', async () => {
    const e = parseErrorResult(await call('no_such_tool', {}));
    expect(e.errorCategory).toBe('validation');
  });

  it('a failed call records exactly one tool_error event with its category', async () => {
    const before = await countToolErrors('forget', 'validation');
    parseErrorResult(await call('forget', { id: MISSING }));
    // logEvent is fire-and-forget: poll briefly rather than race the insert.
    let after = before;
    for (let i = 0; i < 20 && after === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await countToolErrors('forget', 'validation');
    }
    // Settle, then re-count: the poll stops at the first change, so a duplicate
    // arriving later would otherwise slip past "exactly one".
    await new Promise((r) => setTimeout(r, 300));
    expect(await countToolErrors('forget', 'validation')).toBe(before + 1);
  });

  it('a Zod-invalid argument → validation (SDK path, createToolError override)', async () => {
    const e = parseErrorResult(await call('forget', { id: 'not-a-uuid' }));
    expect(e.errorCategory).toBe('validation');
  });

  it('a transient driver error → transient, retryable', async () => {
    const e = parseErrorResult(await call('fixture_transient', {}));
    expect(e).toEqual({
      error: 'terminating connection due to administrator command',
      errorCategory: 'transient',
      isRetryable: true,
    });
  });
});

describe('an unclassified exception', () => {
  it('→ internal, never retryable', async () => {
    expect(parseErrorResult(await call('fixture_internal', {}))).toEqual({
      error: 'unexpected null in handler',
      errorCategory: 'internal',
      isRetryable: false,
    });
  });
});

describe('successes are unchanged', () => {
  it('history on an unknown id is still an empty success', async () => {
    const body = parseOk(await call('history', { id: MISSING }));
    expect(body).toMatchObject({ memoryId: MISSING, count: 0 });
  });

  it('a clean remember has no isError and no warnings key', async () => {
    const body = parseOk(
      await call('remember', {
        name: 'Contract clean remember',
        type: 'fact',
        observations: 'a clean write',
        tags: ['contract'],
        importance: 0.1,
        source: TEST_SOURCE,
      }),
    );
    remembered.push(body.id as string);
    expect(body).not.toHaveProperty('warnings');
  });

  it('pending_list is a plain success', async () => {
    const body = parseOk(await call('pending_list', { limit: 1 }));
    expect(body).toHaveProperty('items');
  });
});
