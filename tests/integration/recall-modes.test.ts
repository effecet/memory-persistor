import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { recall } from '../../src/retrieve.js';
import { insertTestMemory, cleanupMemories, closeTestDb } from './helpers.js';

describe('recall output_mode + wrapper', () => {
  const ids: string[] = [];
  afterEach(async () => { if (ids.length) { await cleanupMemories([...ids]); ids.length = 0; } });
  afterAll(async () => closeTestDb());

  it('returns the wrapper shape', async () => {
    const m = await insertTestMemory({ name: 'wrap-shape', observations: 'unique-token-wrapshape' });
    ids.push(m.id);
    const res = await recall({ query: 'unique-token-wrapshape' });
    expect(res).toHaveProperty('results');
    expect(res).toHaveProperty('total_matches');
    expect(res).toHaveProperty('truncated');
    expect(res).toHaveProperty('degraded_to_summary');
    expect(Array.isArray(res.results)).toBe(true);
  });

  it('default mode is full (includes observations)', async () => {
    const m = await insertTestMemory({ name: 'mode-default', observations: 'unique-token-modedefault' });
    ids.push(m.id);
    const res = await recall({ query: 'unique-token-modedefault' });
    expect(res.results.length).toBeGreaterThan(0);
    expect((res.results[0] as Record<string, unknown>).observations).toBeDefined();
  });

  it('summary mode omits observations and includes a derived description', async () => {
    const m = await insertTestMemory({ name: 'mode-summary', observations: 'unique-token-modesummary ' + 'y'.repeat(400) });
    ids.push(m.id);
    const res = await recall({ query: 'unique-token-modesummary', output_mode: 'summary' });
    expect(res.results.length).toBeGreaterThan(0);
    const r = res.results[0] as Record<string, unknown>;
    expect(r.observations).toBeUndefined();
    expect(typeof r.description).toBe('string');
    expect((r.description as string).length).toBeLessThanOrEqual(200);
  });
});
