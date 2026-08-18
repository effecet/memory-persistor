import { describe, it, expect } from 'vitest';
import { toSummary, applyResponseCap, type RecallResult } from '../src/retrieve.js';
import { RESPONSE_CAP_BYTES, SUMMARY_RELATED_CAP } from '../src/config.js';

/** N distinct neighbour stubs, in stable order, for cap assertions. */
function makeRelated(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `rel-${i}`,
    name: `neighbour-${i}`,
    relation_type: 'related_to',
  }));
}

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

  it('leaves an under-cap related[] untouched and sets no related_total', () => {
    const row = makeRow('a', 10);
    row.related = makeRelated(SUMMARY_RELATED_CAP);
    const s = toSummary(row);
    expect(s.related).toHaveLength(SUMMARY_RELATED_CAP);
    expect(s.related_total).toBeUndefined();
  });

  it('caps an over-cap related[] and reports the true total', () => {
    // A hub with 218 edges against a ~4 average: summary mode
    // previously copied all 218, so the "lean" projection cost nearly as much
    // as full mode on exactly the rows that surface most often.
    const row = makeRow('a', 10);
    row.related = makeRelated(218);
    const s = toSummary(row);
    expect(s.related).toHaveLength(SUMMARY_RELATED_CAP);
    expect(s.related_total).toBe(218);
    expect(s.related?.[0].id).toBe('rel-0'); // keeps the first N, stable order
  });

  it('omits related and related_total entirely when there are no edges', () => {
    const row = makeRow('a', 10);
    const s = toSummary(row);
    expect(s.related).toBeUndefined();
    expect(s.related_total).toBeUndefined();
  });

  it('treats an empty related[] as absent, not as a truncation', () => {
    const row = makeRow('a', 10);
    row.related = [];
    const s = toSummary(row);
    expect(s.related).toBeUndefined();
    expect(s.related_total).toBeUndefined();
  });

  it('materially shrinks a hub row versus the uncapped projection', () => {
    const row = makeRow('a', 10);
    row.related = makeRelated(218);
    const capped = Buffer.byteLength(JSON.stringify(toSummary(row)), 'utf8');
    const uncapped = Buffer.byteLength(
      JSON.stringify({ ...toSummary(row), related: row.related }),
      'utf8',
    );
    expect(capped).toBeLessThan(uncapped * 0.15);
  });
});

describe('full mode is unaffected by the summary cap', () => {
  it('keeps every related entry when output_mode is full', () => {
    const row = makeRow('a', 10);
    row.related = makeRelated(218);
    const r = applyResponseCap([row], 'full');
    expect(r.kept).toHaveLength(1);
    expect((r.kept[0] as RecallResult).related).toHaveLength(218);
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
