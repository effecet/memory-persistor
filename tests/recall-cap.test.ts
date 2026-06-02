import { describe, it, expect } from 'vitest';
import { toSummary, applyResponseCap, type RecallResult } from '../src/retrieve.js';
import { RESPONSE_CAP_BYTES } from '../src/config.js';

function makeRow(id: string, obsLen: number): RecallResult {
  return {
    id,
    name: `mem-${id}`,
    type: 'fact',
    observations: 'x'.repeat(obsLen),
    tags: ['t'],
    source: '/tmp/test',
    importance: 0.5,
    temperature: 1,
    tier: 'HOT',
    origin_host: null,
    score: 0.5,
  };
}

describe('toSummary', () => {
  it('omits observations and derives a <=200 char description', () => {
    const row = makeRow('a', 500);
    const s = toSummary(row);
    expect((s as Record<string, unknown>).observations).toBeUndefined();
    expect(s.description.length).toBeLessThanOrEqual(200);
    expect(s.description).toBe('x'.repeat(200));
    expect(s.id).toBe('a');
    expect(s.score).toBe(0.5);
  });

  it('carries related[] through when present', () => {
    const row = makeRow('a', 10);
    row.related = [{ id: 'b', name: 'n', relation_type: 'related_to' }];
    expect(toSummary(row).related).toHaveLength(1);
  });
});

describe('applyResponseCap', () => {
  it('keeps everything when under the cap (truncated=false)', () => {
    const rows = [makeRow('a', 10), makeRow('b', 10)];
    const r = applyResponseCap(rows, 'full');
    expect(r.kept).toHaveLength(2);
    expect(r.total_matches).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.degraded_to_summary).toBe(false);
  });

  it('trims rows that exceed the cap (truncated=true)', () => {
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(String(i), 5000));
    const r = applyResponseCap(rows, 'full');
    expect(JSON.stringify(r.kept).length).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(r.total_matches).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.kept.length).toBeLessThan(10);
  });

  it('degrades full->summary when the first row alone exceeds the cap', () => {
    const rows = [makeRow('big', 40000)];
    const r = applyResponseCap(rows, 'full');
    expect(r.degraded_to_summary).toBe(true);
    expect(r.kept).toHaveLength(1);
    expect((r.kept[0] as Record<string, unknown>).observations).toBeUndefined();
    expect((r.kept[0] as Record<string, unknown>).description).toBeDefined();
  });

  it('summary mode never sets degraded_to_summary', () => {
    const rows = [makeRow('big', 40000)];
    const r = applyResponseCap(rows, 'summary');
    expect(r.degraded_to_summary).toBe(false);
  });
});
