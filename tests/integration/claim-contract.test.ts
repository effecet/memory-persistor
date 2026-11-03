/**
 * the claim contract — the claim contract on the write paths, through a real MCP client so a
 * handler that forgets to call the contract fails here even though the pure
 * functions are tested separately.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { connectHarness, parseOk, parseErrorResult, type Harness } from './mcp-harness.js';
import { VOLATILE_TAG } from '../../src/claim-contract.js';
import { testDb, getMemory, cleanupMemories, closeTestDb } from './helpers.js';

const PREFIX = 'claim-contract-115-';
const UNDATED = 'Result: cold-cache CI ~5min, warm-cache ~3min.';
const DATED = 'Measured 2026-10-15: cold-cache CI ~5min, warm-cache ~3min.';
const TRANSCRIPT = 'User: why is CI red\nAssistant: jq is missing\nUser: fix it\nAssistant: done';
const VOLATILE_FLAGS = [expect.objectContaining({ rule: 'undated-volatile' })];

const tagsOf = async (id: string): Promise<string[] | null | undefined> => (await getMemory(id))?.tags;

async function countByName(name: string): Promise<number> {
  const r = await testDb.execute(sql`SELECT count(*)::int AS n FROM public.entities WHERE name = ${name}`);
  return (r.rows[0] as { n: number }).n;
}

describe('claim contract on write paths', () => {
  let h: Harness;
  const created: string[] = [];

  beforeAll(async () => { h = await connectHarness(); });
  afterEach(async () => { if (created.length) { await cleanupMemories([...created]); created.length = 0; } });
  afterAll(async () => { await h.close(); await closeTestDb(); });

  const call = (name: string, args: Record<string, unknown>) => h.client.callTool({ name, arguments: args });
  const remember = (name: string, observations: string, tags: string[] = ['ci']) =>
    call('remember', { name: `${PREFIX}${name}`, type: 'fact', observations, tags, importance: 0.5 });

  /** remember that must succeed; returns the parsed result and registers the row for cleanup. */
  async function rememberOk(name: string, observations: string, tags?: string[]) {
    const res = parseOk(await remember(name, observations, tags));
    created.push(res.id as string);
    return res as Record<string, unknown> & { id: string };
  }

  it('remember rejects a transcript and writes nothing', async () => {
    const err = parseErrorResult(await remember('transcript rejected', TRANSCRIPT));
    expect(err.errorCategory).toBe('validation');
    expect(err.error).toMatch(/conclusion, not the log/);
    expect(await countByName(`${PREFIX}transcript rejected`)).toBe(0);
  });

  it('remember tags an undated volatile body and flags it — in flags, never in warnings', async () => {
    const res = await rememberOk('undated figure', UNDATED);
    expect(await tagsOf(res.id)).toEqual(['ci', VOLATILE_TAG]);
    expect(res.flags).toEqual(VOLATILE_FLAGS);
    // warnings means a step FAILED; a flag is not a failure (and would count as one in analytics).
    expect(res.warnings).toBeUndefined();
  });

  it('remember leaves a dated body untagged and unflagged', async () => {
    const res = await rememberOk('dated figure', DATED);
    expect(await tagsOf(res.id)).toEqual(['ci']);
    expect(res.flags).toBeUndefined();
  });

  it('update recomputes the flag: dating the body clears it, keeping other tags', async () => {
    const { id } = await rememberOk('update clears', UNDATED, ['ci', 'pi']);
    expect(await tagsOf(id)).toEqual(['ci', 'pi', VOLATILE_TAG]);

    const cleared = parseOk(await call('update', { id, observations: DATED }));
    expect(await tagsOf(id)).toEqual(['ci', 'pi']);
    expect(cleared.flags).toBeUndefined();
    expect(cleared.updated_fields).toEqual(['observations', 'tags']);

    const back = parseOk(await call('update', { id, observations: UNDATED }));
    expect(await tagsOf(id)).toEqual(['ci', 'pi', VOLATILE_TAG]);
    expect(back.flags).toEqual(VOLATILE_FLAGS);
  });

  it('an update that leaves the flag where it was does not report tags as changed', async () => {
    const { id } = await rememberOk('flag unchanged', DATED);
    const res = parseOk(await call('update', { id, observations: `${DATED} Still true.` }));
    expect(res.updated_fields).toEqual(['observations']);
  });

  it('update with caller tags and a volatile body keeps the caller tags plus the flag', async () => {
    const { id } = await rememberOk('update with tags', DATED);
    parseOk(await call('update', { id, observations: UNDATED, tags: ['new'] }));
    expect(await tagsOf(id)).toEqual(['new', VOLATILE_TAG]);
  });

  it('update rejects a transcript and leaves the row unchanged', async () => {
    const { id } = await rememberOk('update rejected', DATED);
    const err = parseErrorResult(await call('update', { id, observations: TRANSCRIPT }));
    expect(err.errorCategory).toBe('validation');
    expect((await getMemory(id))?.observations).toBe(DATED);
  });

  it('a tags-only update cannot drop the flag from a body that is still undated', async () => {
    const { id } = await rememberOk('tags only keeps flag', UNDATED);
    const res = parseOk(await call('update', { id, tags: ['other'] }));
    expect(await tagsOf(id)).toEqual(['other', VOLATILE_TAG]);
    // The flag was re-derived here, so the caller is told why it is still set.
    expect(res.flags).toEqual(VOLATILE_FLAGS);
  });

  it('a tags-only update cannot pin the flag on a dated body', async () => {
    const { id } = await rememberOk('tags only no pin', DATED);
    parseOk(await call('update', { id, tags: ['other', VOLATILE_TAG] }));
    expect(await tagsOf(id)).toEqual(['other']);
  });

  it('a name-only update leaves tags alone', async () => {
    const { id } = await rememberOk('name only', UNDATED);
    const res = parseOk(await call('update', { id, name: `${PREFIX}name only renamed` }));
    expect(res.updated_fields).toEqual(['name']);
    expect(await tagsOf(id)).toEqual(['ci', VOLATILE_TAG]);
  });

  it('merge recomputes the flag over the combined body', async () => {
    // The target alone is flagged (an undated figure); the source carries no
    // figure but an "as of" anchor. The anchor dates the WHOLE merged body, so
    // the merged target must lose the flag — which only a recompute can see.
    const target = await rememberOk('merge target', UNDATED);
    const source = await rememberOk('merge source', 'As of the last audit nothing else changed.');
    expect(await tagsOf(target.id)).toEqual(['ci', VOLATILE_TAG]);

    parseOk(await call('merge', { targetId: target.id, sourceId: source.id }));
    created.splice(created.indexOf(source.id), 1); // merge deleted the source
    expect(await tagsOf(target.id)).toEqual(['ci']);
  });
});
