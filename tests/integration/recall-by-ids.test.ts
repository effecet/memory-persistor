import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { recallByIds } from '../../src/retrieve.js';
import { insertTestMemory, cleanupMemories, closeTestDb } from './helpers.js';

describe('recallByIds', () => {
  const ids: string[] = [];
  afterEach(async () => { if (ids.length) { await cleanupMemories([...ids]); ids.length = 0; } });
  afterAll(async () => closeTestDb());

  it('fetches the given ids and preserves input order', async () => {
    const a = await insertTestMemory({ name: 'byid-a', observations: 'alpha body' });
    const b = await insertTestMemory({ name: 'byid-b', observations: 'beta body' });
    ids.push(a.id, b.id);
    const res = await recallByIds({ ids: [b.id, a.id] });
    expect(res.results.map((r) => r.id)).toEqual([b.id, a.id]);
    expect((res.results[0] as Record<string, unknown>).observations).toBe('beta body');
    expect(res.total_matches).toBe(2);
  });

  it('omits unknown ids silently', async () => {
    const a = await insertTestMemory({ name: 'byid-known', observations: 'known body' });
    ids.push(a.id);
    const res = await recallByIds({ ids: [a.id, '00000000-0000-0000-0000-000000000000'] });
    expect(res.results.map((r) => r.id)).toEqual([a.id]);
    expect(res.total_matches).toBe(1);
  });

  it('honors summary output_mode', async () => {
    const a = await insertTestMemory({ name: 'byid-sum', observations: 'z'.repeat(400) });
    ids.push(a.id);
    const res = await recallByIds({ ids: [a.id], output_mode: 'summary' });
    const r = res.results[0] as Record<string, unknown>;
    expect(r.observations).toBeUndefined();
    expect((r.description as string).length).toBeLessThanOrEqual(200);
  });

  it('returns an empty wrapper for an empty id list (no DB hit)', async () => {
    const res = await recallByIds({ ids: [] });
    expect(res.results).toEqual([]);
    expect(res.total_matches).toBe(0);
    expect(res.truncated).toBe(false);
    expect(res.degraded_to_summary).toBe(false);
  });
});
