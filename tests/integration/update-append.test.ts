/**
 * update(append_observations) — grows a body server-side without resending it.
 * Through a real MCP client, so the handler's wiring is what is tested.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectHarness, parseOk, parseErrorResult, type Harness } from './mcp-harness.js';
import { VOLATILE_TAG } from '../../src/claim-contract.js';
import { EMBED_DIMS } from '../../src/config.js';
import { entities } from '../../src/schema.js';
import { testDb, insertTestMemory, getMemory, cleanupMemories, closeTestDb } from './helpers.js';

const PREFIX = 'update-append-';
const DATED = 'Measured 2026-10-23: cold-cache CI ~5min.';
const UNDATED = 'Cold-cache CI ~5min.';
const TWO_TURNS = 'User: why is CI red\nAssistant: jq is missing';
const TWO_MORE_TURNS = 'User: fix it\nAssistant: done';
const VOLATILE_FLAGS = [expect.objectContaining({ rule: 'undated-volatile' })];

describe('update append_observations', () => {
  let h: Harness;
  const created: string[] = [];

  beforeAll(async () => { h = await connectHarness(); });
  afterEach(async () => { if (created.length) { await cleanupMemories([...created]); created.length = 0; } });
  afterAll(async () => { await h.close(); await closeTestDb(); });

  const call = (name: string, args: Record<string, unknown>) => h.client.callTool({ name, arguments: args });

  async function rememberOk(name: string, observations: string): Promise<string> {
    const res = parseOk(await call('remember', {
      name: `${PREFIX}${name}`, type: 'fact', observations, tags: ['ci'], importance: 0.5,
    }));
    created.push(res.id as string);
    return res.id as string;
  }

  async function seeded(name: string, observations: string | null): Promise<string> {
    const { id } = await insertTestMemory({ name: `${PREFIX}${name}`, type: 'fact', observations: observations ?? '' });
    created.push(id);
    // insertTestMemory turns null into its default text, so a NULL body is set directly.
    if (observations === null) await testDb.update(entities).set({ observations: null }).where(eq(entities.id, id));
    return id;
  }

  it('appends after a blank line and reports observations as updated', async () => {
    const id = await rememberOk('basic', 'First entry.');
    const res = parseOk(await call('update', { id, append_observations: 'Second entry.' }));
    expect(res.updated_fields).toEqual(['observations']);
    expect((await getMemory(id))?.observations).toBe('First entry.\n\nSecond entry.');
  });

  it('stores the appended text verbatim, and joins after the stored trailing whitespace', async () => {
    const id = await seeded('verbatim', 'Head.\n\n\n');
    parseOk(await call('update', { id, append_observations: '  indented\n' }));
    expect((await getMemory(id))?.observations).toBe('Head.\n\n  indented\n');
  });

  it.each([['empty', ''], ['null', null], ['blank', '  \n']])('a %s stored body takes the appended text alone', async (_label, stored) => {
    const id = await seeded(`stored ${_label}`, stored);
    parseOk(await call('update', { id, append_observations: 'Only entry.' }));
    expect((await getMemory(id))?.observations).toBe('Only entry.');
  });

  it('rejects observations and append_observations together, writing nothing', async () => {
    const id = await rememberOk('both', 'Original.');
    const err = parseErrorResult(await call('update', { id, observations: 'x', append_observations: 'y' }));
    expect(err.errorCategory).toBe('validation');
    expect((await getMemory(id))?.observations).toBe('Original.');
  });

  it('rejects a whitespace-only append', async () => {
    const id = await rememberOk('blank', 'Original.');
    const err = parseErrorResult(await call('update', { id, append_observations: '   ' }));
    expect(err.errorCategory).toBe('validation');
    expect((await getMemory(id))?.observations).toBe('Original.');
  });

  it('judges the combined body: two turns stored plus two appended make a transcript', async () => {
    const id = await seeded('transcript', TWO_TURNS);
    const err = parseErrorResult(await call('update', { id, append_observations: TWO_MORE_TURNS }));
    expect(err.errorCategory).toBe('validation');
    expect((await getMemory(id))?.observations).toBe(TWO_TURNS);
  });

  it('judges the appended text on its own too: an unclosed fence in the body cannot hide a transcript', async () => {
    const stored = 'Notes.\n```\nsome code';
    const id = await seeded('fence', stored);
    const err = parseErrorResult(await call('update', { id, append_observations: `${TWO_TURNS}\n${TWO_MORE_TURNS}` }));
    expect(err.errorCategory).toBe('validation');
    expect((await getMemory(id))?.observations).toBe(stored);
  });

  it('volatile follows the combined body: an undated figure on a dated body stays unflagged', async () => {
    const id = await rememberOk('volatile dated', DATED);
    const res = parseOk(await call('update', { id, append_observations: 'Warm cache ~3min.' }));
    expect(res.flags).toBeUndefined();
    expect((await getMemory(id))?.tags).not.toContain(VOLATILE_TAG);
  });

  it('volatile follows the combined body: an undated body gaining its first figure is flagged', async () => {
    const id = await seeded('volatile undated', 'Notes, no figures yet.');
    const res = parseOk(await call('update', { id, append_observations: UNDATED }));
    expect(res.flags).toEqual(VOLATILE_FLAGS);
    expect(res.updated_fields).toEqual(['observations', 'tags']);
    expect((await getMemory(id))?.tags).toContain(VOLATILE_TAG);
  });

  it('with caller tags, keeps them plus the flag the combined body earns', async () => {
    const id = await rememberOk('with tags', 'Notes.');
    const res = parseOk(await call('update', { id, append_observations: UNDATED, tags: ['new'] }));
    expect(res.updated_fields).toEqual(['observations', 'tags']);
    expect((await getMemory(id))?.tags).toEqual(['new', VOLATILE_TAG]);
  });

  it('a rename and an append in one call both land', async () => {
    const id = await rememberOk('rename', 'First.');
    const res = parseOk(await call('update', { id, name: `${PREFIX}renamed`, append_observations: 'Second.' }));
    expect(res.updated_fields).toEqual(['name', 'observations']);
    const stored = await getMemory(id);
    expect(stored?.name).toBe(`${PREFIX}renamed`);
    expect(stored?.observations).toBe('First.\n\nSecond.');
  });

  it('refreshes the embedding and snapshots the previous body', async () => {
    const id = await seeded('embedding', 'First.');
    const stale = Array(EMBED_DIMS).fill(0.01);
    await testDb.update(entities).set({ embedding: stale }).where(eq(entities.id, id));

    parseOk(await call('update', { id, append_observations: 'Second.' }));

    const [row] = await testDb.select({ embedding: entities.embedding }).from(entities).where(eq(entities.id, id));
    // Invalidated (gate off) or recomputed (gate on) — never the stale vector.
    expect(row.embedding).not.toEqual(stale);

    const history = parseOk(await call('history', { id }));
    expect((history.versions as Array<{ observations: string }>)[0].observations).toBe('First.');
  });
});
