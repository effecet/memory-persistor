import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { recall } from '../../src/retrieve.js';
import { RESPONSE_CAP_BYTES } from '../../src/config.js';
import { insertTestMemory, cleanupMemories, closeTestDb } from './helpers.js';

describe('recall cap on realistic data', () => {
  const ids: string[] = [];
  afterEach(async () => { if (ids.length) { await cleanupMemories([...ids]); ids.length = 0; } });
  afterAll(async () => closeTestDb());

  it('summary mode stays under the cap on 30 mixed-size rows', async () => {
    for (let i = 0; i < 30; i++) {
      const size = i % 5 === 0 ? 5000 : 500;
      const body = `realistic-token-${i} ` + 'lorem ipsum dolor sit amet '.repeat(Math.floor(size / 27));
      const m = await insertTestMemory({ name: `realistic-${i}`, observations: body });
      ids.push(m.id);
    }
    const res = await recall({ query: 'realistic-token', limit: 50, output_mode: 'summary' });
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(RESPONSE_CAP_BYTES + 256); // wrapper overhead
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('full mode response stays under the cap', async () => {
    for (let i = 0; i < 12; i++) {
      const body = `fullcap-${i} ` + 'content '.repeat(400); // ~3 KB each
      const m = await insertTestMemory({ name: `fullcap-${i}`, observations: body });
      ids.push(m.id);
    }
    const res = await recall({ query: 'fullcap', limit: 50 });
    expect(JSON.stringify(res.results).length).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(res.truncated).toBe(true);
  });
});
