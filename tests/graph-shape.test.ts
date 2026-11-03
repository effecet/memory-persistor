/**
 * Tests for the GraphShape aggregation added to `health`.
 *
 * Pure-function half. The point of the graph-shape work is that DISTRIBUTION bugs — a signal
 * correct on the median row and pathological at the tail — are invisible to
 * ordinary tests, so these assert exact numbers against a known shape rather
 * than "is a number".
 */

import { describe, it, expect } from 'vitest';
import { buildGraphShape } from '../src/observability.js';
import { HEALTH_HUB_LIMIT } from '../src/config.js';

const community = (n: number): { members: string[] } => ({
  members: Array.from({ length: n }, (_, i) => `m${i}`),
});

const DEGREE_ROW = {
  min: 0,
  median: 2,
  p95: 11,
  max: 291,
  zero_count: 16,
  centrality_denominator: 291,
};

describe('buildGraphShape — degree', () => {
  it('carries every degree statistic through', () => {
    const g = buildGraphShape(DEGREE_ROW, [], []);
    expect(g.degree).toEqual({ min: 0, median: 2, p95: 11, max: 291, zeroCount: 16 });
  });

  it('reports the centrality denominator recall actually uses', () => {
    expect(buildGraphShape(DEGREE_ROW, [], []).centralityDenominator).toBe(291);
  });

  it('does not invent values when the row is empty', () => {
    // An empty corpus must read as zeros, not NaN — a NaN here would render as
    // null in JSON and be indistinguishable from "not measured".
    const g = buildGraphShape({}, [], []);
    expect(g.degree).toEqual({ min: 0, median: 0, p95: 0, max: 0, zeroCount: 0 });
    expect(Number.isNaN(g.centralityDenominator)).toBe(false);
    expect(g.centralityDenominator).toBe(1);
  });
});

describe('buildGraphShape — communities', () => {
  it('aggregates sizes and never returns members', () => {
    const g = buildGraphShape(DEGREE_ROW, [], [community(5), community(1), community(3)]);
    expect(g.communities).toEqual({ count: 3, largest: 5, median: 3, singletons: 1 });
    // The payload is uncapped, so member lists must not leak into it.
    expect(JSON.stringify(g)).not.toContain('m0');
  });

  it('takes the median of an even count without picking a member value', () => {
    const g = buildGraphShape(DEGREE_ROW, [], [community(1), community(2), community(4), community(9)]);
    expect(g.communities.median).toBe(3); // (2 + 4) / 2 — not 2, not 4
  });

  it('counts singletons, which are the isolated nodes', () => {
    const g = buildGraphShape(DEGREE_ROW, [], [community(1), community(1), community(7)]);
    expect(g.communities.singletons).toBe(2);
    expect(g.communities.largest).toBe(7);
  });

  it('an empty graph is zeros, not a crash', () => {
    expect(buildGraphShape(DEGREE_ROW, [], []).communities).toEqual({
      count: 0,
      largest: 0,
      median: 0,
      singletons: 0,
    });
  });

  it('is order-independent — the query does not promise sorted communities', () => {
    const a = buildGraphShape(DEGREE_ROW, [], [community(9), community(1), community(4)]);
    const b = buildGraphShape(DEGREE_ROW, [], [community(1), community(4), community(9)]);
    expect(a.communities).toEqual(b.communities);
  });
});

describe('buildGraphShape — hubs', () => {
  it('maps hub rows and coerces degree to a number', () => {
    const g = buildGraphShape(DEGREE_ROW, [{ id: 'a', name: 'Hub', degree: '291' }], []);
    expect(g.hubs).toEqual([{ id: 'a', name: 'Hub', degree: 291 }]);
  });

  it('the hub limit is a bounded constant', () => {
    // health is NOT run through applyResponseCap (that is wired only into
    // retrieve.ts), so an unbounded hub list would grow with the corpus.
    expect(HEALTH_HUB_LIMIT).toBeGreaterThan(0);
    expect(HEALTH_HUB_LIMIT).toBeLessThanOrEqual(25);
  });
});
