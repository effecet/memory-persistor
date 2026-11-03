/**
 * Auto-relate must gate on RELEVANCE, not on the popularity-weighted score.
 *
 * An edge is a claim about content similarity. Gating on the full score granted
 * edges partly for being popular, which is self-reinforcing: more edges raise
 * graph centrality, centrality raises the query-independent prior, and a higher
 * prior wins more auto-relate slots. That loop is half of what made the reported issue's
 * hub unbeatable (287 edges, temperature pinned at 1.0).
 *
 * These tests exercise the same `recall` call `remember`'s auto-relate makes —
 * `skipSemantic: true`, `limit: AUTO_RELATE_LIMIT` — and apply the production
 * predicate, rather than reimplementing the comparison.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { recall, shouldAutoRelate, toSummary } from '../../src/retrieve.js';
import { AUTO_RELATE_THRESHOLD, AUTO_RELATE_LIMIT, PRIOR_ALPHA } from '../../src/config.js';
import { insertTestMemory, cleanupMemories, closeTestDb } from './helpers.js';

const PREFIX = 'auto-relate-threshold-';
const createdIds: string[] = [];

// NOTE: the predicate is IMPORTED, never reimplemented here. An earlier version
// of this file defined its own copy, and mutating the production call site to gate
// on `score` again left all four tests green — the test proved nothing. That is why
// `shouldAutoRelate` exists as a single exported function.
async function autoRelateCandidates(query: string) {
  const res = await recall({ query, limit: AUTO_RELATE_LIMIT, skipSemantic: true });
  return res.results as unknown as { id: string; name: string; relevance: number; score: number }[];
}

describe('auto-relate gates on relevance', () => {
  let hotUnrelatedId: string;
  let genuinelySimilarId: string;

  beforeAll(async () => {
    // Popular but off-topic: every prior maxed out.
    const hot = await insertTestMemory({
      name: `${PREFIX}unrelated hot memory about invoicing`,
      observations: 'monthly invoicing reconciliation and dunning schedules',
      temperature: 1.0,
      tier: 'HOT',
      importance: 0.9,
      accessCount: 500,
    });
    hotUnrelatedId = hot.id;
    createdIds.push(hot.id);

    // On-topic but cold and ignored.
    const similar = await insertTestMemory({
      name: `${PREFIX}quokka enclosure humidity targets`,
      observations: 'humidity targets for the quokka enclosure, measured nightly',
      temperature: 0.0,
      tier: 'COLD',
      importance: 0.1,
      accessCount: 0,
    });
    genuinelySimilarId = similar.id;
    createdIds.push(similar.id);
  });

  afterAll(async () => {
    await cleanupMemories(createdIds);
    await closeTestDb();
  });

  it('would create an edge to a genuinely similar memory', async () => {
    const candidates = await autoRelateCandidates('quokka enclosure humidity targets nightly');
    const similar = candidates.find((c) => c.id === genuinelySimilarId);
    expect(similar).toBeDefined();
    expect(shouldAutoRelate(similar!)).toBe(true);
  });

  it('would NOT create an edge to a popular but unrelated memory', async () => {
    const candidates = await autoRelateCandidates('quokka enclosure humidity targets nightly');
    const hot = candidates.find((c) => c.id === hotUnrelatedId);
    // Either it never surfaces, or it surfaces and fails the relevance gate.
    if (hot) expect(shouldAutoRelate(hot)).toBe(false);
  });

  it('is stricter than gating on score would have been', async () => {
    // The concrete regression this prevents: for a popular off-topic memory the
    // score clears the threshold while the relevance does not, so the OLD
    // predicate would have created the edge and the new one does not.
    const candidates = await autoRelateCandidates('quokka enclosure humidity targets nightly');
    const hot = candidates.find((c) => c.id === hotUnrelatedId);
    if (hot) {
      expect(hot.score).toBeGreaterThanOrEqual(hot.relevance);
      expect(hot.relevance).toBeLessThan(AUTO_RELATE_THRESHOLD);
    }
    // And score is on a different scale now, so reusing it would be wrong even
    // if it happened to agree here.
    for (const c of candidates) {
      expect(c.score).toBeLessThanOrEqual(1 + PRIOR_ALPHA + 1e-9);
      expect(c.relevance).toBeLessThanOrEqual(1);
    }
  });

  it('fails closed when relevance is missing or not finite', () => {
    // undefined/NaN must NOT create an edge. `undefined < threshold` is false, so a
    // naive `<` comparison would have slipped through and created one.
    expect(shouldAutoRelate({})).toBe(false);
    expect(shouldAutoRelate({ relevance: Number.NaN })).toBe(false);
    expect(shouldAutoRelate({ relevance: AUTO_RELATE_THRESHOLD })).toBe(true);
    expect(shouldAutoRelate({ relevance: AUTO_RELATE_THRESHOLD - 1e-9 })).toBe(false);
  });

  it('carries relevance through summary mode as well', async () => {
    // RecallSummary omitting `relevance` would make `undefined >= threshold`
    // false at the call site — which reads as "skip", but only by luck. The
    // production predicate uses >= for exactly that reason; this pins the field.
    const candidates = await autoRelateCandidates('quokka enclosure humidity targets nightly');
    expect(candidates.length).toBeGreaterThan(0);
    const summary = toSummary({
      ...(candidates[0] as unknown as Parameters<typeof toSummary>[0]),
      observations: 'body',
      tags: [],
    });
    expect(summary.relevance).toBe(candidates[0].relevance);
  });
});
