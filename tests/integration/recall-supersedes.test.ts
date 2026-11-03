/**
 * the supersedes fix — recall respects `supersedes`: a corrected-away memory can never
 * outrank its correction.
 *
 * Each case seeds the inversion the issue describes: the OLD memory is hot,
 * central-ish and the exact textual match; the NEW memory that supersedes it
 * is cold and a weaker match. Without the ordering term the old one wins on
 * score — the control case below asserts exactly that, so the fixture cannot
 * quietly decay into passing vacuously.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { recall, recallByIds } from '../../src/retrieve.js';
import type { RecallResponse, RecallResult, RecallSummary } from '../../src/retrieve.js';
import { insertTestMemory, insertTestRelation, cleanupMemories, closeTestDb } from './helpers.js';

const PREFIX = 'supersedes-114-';
const ids: string[] = [];

/** Every prior at the floor: anything this row wins, it wins on relevance or ordering. */
async function seedCold(name: string, observations: string): Promise<{ id: string; name: string }> {
  const m = await insertTestMemory({ name, observations, importance: 0.1, temperature: 0.0, tier: 'COLD', accessCount: 0 });
  ids.push(m.id);
  return { id: m.id, name };
}

async function seedPair(token: string) {
  const query = `${token} wombat burrow depth rule`;
  const old = await insertTestMemory({
    name: `${PREFIX}${query}`,
    observations: `${query}: dig to two metres. ${query}.`,
    importance: 0.9,
    temperature: 1.0,
    tier: 'HOT',
    accessCount: 300,
  });
  ids.push(old.id);
  const newer = await seedCold(`${PREFIX}${token} corrected guidance`, `${token} wombat depth is one metre, not two (corrected).`);
  return { query, oldId: old.id, newId: newer.id, newName: newer.name };
}

/** Position of `id` in the results; fails loudly rather than returning -1, which would make a `<` check pass. */
function pos(res: RecallResponse, id: string): number {
  const i = res.results.findIndex((r) => r.id === id);
  expect(i, `row ${id} missing from results`).toBeGreaterThanOrEqual(0);
  return i;
}

const row = (res: RecallResponse, id: string): RecallResult | RecallSummary =>
  res.results[pos(res, id)];

describe('recall orders superseded memories below live ones', () => {
  afterEach(async () => { if (ids.length) { await cleanupMemories([...ids]); ids.length = 0; } });
  afterAll(async () => closeTestDb());

  it('control: with no edge, the old memory outranks the new one', async () => {
    const p = await seedPair('ctrlnoedge');
    const res = await recall({ query: p.query });
    expect(pos(res, p.oldId)).toBeLessThan(pos(res, p.newId));
  });

  it('an asserted supersedes edge sinks the old memory below its correction', async () => {
    const p = await seedPair('assertededge');
    await insertTestRelation(p.newId, p.oldId, 'supersedes', 1.0, 'asserted');

    const res = await recall({ query: p.query });
    expect(pos(res, p.oldId)).toBeGreaterThan(pos(res, p.newId));
    // The history stays visible, and says why it sank.
    expect(row(res, p.oldId).superseded_by).toEqual([{ id: p.newId, name: p.newName }]);
    expect(row(res, p.newId).superseded_by).toBeUndefined();
  });

  it('an inferred supersedes edge does not reorder (asserted only)', async () => {
    const p = await seedPair('inferrededge');
    await insertTestRelation(p.newId, p.oldId, 'supersedes', 1.0, 'inferred');

    const res = await recall({ query: p.query });
    expect(pos(res, p.oldId)).toBeLessThan(pos(res, p.newId));
    expect(row(res, p.oldId).superseded_by).toBeUndefined();
  });

  it('a chain A <- B <- C leaves only C live', async () => {
    const p = await seedPair('chainabc');
    const c = await seedCold(`${PREFIX}chainabc final word`, `${p.query}, final word: one metre.`);
    await insertTestRelation(p.newId, p.oldId, 'supersedes', 1.0, 'asserted');
    await insertTestRelation(c.id, p.newId, 'supersedes', 1.0, 'asserted');

    const res = await recall({ query: p.query });
    expect(pos(res, c.id)).toBe(0);
    expect(pos(res, p.newId)).toBeGreaterThan(0);
    expect(pos(res, p.oldId)).toBeGreaterThan(0);
  });

  it('a supersedes self-loop neither sinks the row nor explains it', async () => {
    // The schema permits a self-loop (relate rejects one; legacy or direct-SQL rows may not); both copies of the predicate must skip it.
    const p = await seedPair('selfloop');
    await insertTestRelation(p.oldId, p.oldId, 'supersedes', 1.0, 'asserted');

    const res = await recall({ query: p.query });
    expect(pos(res, p.oldId)).toBeLessThan(pos(res, p.newId));
    expect(row(res, p.oldId).superseded_by).toBeUndefined();
  });

  it('summary mode and recall_by_ids carry superseded_by', async () => {
    const p = await seedPair('summarymode');
    await insertTestRelation(p.newId, p.oldId, 'supersedes', 1.0, 'asserted');
    const expected = [{ id: p.newId, name: p.newName }];

    const summary = await recall({ query: p.query, output_mode: 'summary' });
    expect(row(summary, p.oldId).superseded_by).toEqual(expected);
    expect(row(summary, p.newId).superseded_by).toBeUndefined();

    const byIds = await recallByIds({ ids: [p.oldId, p.newId] });
    expect(row(byIds, p.oldId).superseded_by).toEqual(expected);
    // recall_by_ids does no ranking: caller order is preserved.
    expect(byIds.results.map((r) => r.id)).toEqual([p.oldId, p.newId]);
  });
});
