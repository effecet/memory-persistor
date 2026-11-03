/**
 * Unit tests for the benchmark's own judgement logic.
 *
 * The harness picks PRIOR_ALPHA, so a bug in `verdictFor` would silently choose
 * the wrong value — the verdict function needs to be right before its output is
 * trusted. No database here: only the pure logic.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verdictFor, loadGoldenQueries, type GoldenQuery } from '../scripts/score-benchmark.js';

const g = (over: Partial<GoldenQuery> = {}): GoldenQuery => ({
  query: 'q',
  expect_top: ['wanted'],
  expect_not_top: ['hub'],
  ...over,
});

describe('verdictFor', () => {
  it('passes when the wanted memory outranks the unwanted one', () => {
    expect(verdictFor(['wanted', 'hub'], g())).toBe('pass');
  });

  it('fails when the unwanted memory outranks the wanted one', () => {
    expect(verdictFor(['hub', 'wanted'], g())).toBe('fail');
  });

  it('passes when the unwanted memory is absent entirely', () => {
    expect(verdictFor(['wanted', 'other'], g())).toBe('pass');
  });

  it('reports missing — not fail — when a wanted memory never surfaces', () => {
    // Absent means the WHERE clause excluded it, which no alpha can fix. Calling
    // that "fail" would let a tuning run look like it had a tuning problem.
    expect(verdictFor(['hub', 'other'], g())).toBe('missing');
  });

  it('requires ALL wanted memories to outrank the unwanted one', () => {
    // The second target ranks below the hub, so this is a fail even though the
    // first target is on top.
    const two = g({ expect_top: ['wanted', 'alsoWanted'] });
    expect(verdictFor(['wanted', 'hub', 'alsoWanted'], two)).toBe('fail');
    expect(verdictFor(['wanted', 'alsoWanted', 'hub'], two)).toBe('pass');
  });

  it('reports missing when only one of several wanted memories is absent', () => {
    const two = g({ expect_top: ['wanted', 'alsoWanted'] });
    expect(verdictFor(['wanted', 'hub'], two)).toBe('missing');
  });

  it('treats an empty expect_not_top as satisfiable', () => {
    expect(verdictFor(['wanted'], g({ expect_not_top: [] }))).toBe('pass');
  });
});

/** The queries name memories in a real corpus and do not ship with this repo; see README § Ranking guard. */
const HAS_QUERIES = existsSync(resolve(__dirname, 'fixtures', 'golden-queries.json'));
const NO_QUERIES = '(skipped: no golden queries — see README § Ranking guard)';

describe('golden query set', () => {
  it.skipIf(!HAS_QUERIES)(`loads the checked-in fixture ${HAS_QUERIES ? '' : NO_QUERIES}`, () => {
    const qs = loadGoldenQueries();
    expect(qs.length).toBeGreaterThanOrEqual(2);
    for (const q of qs) {
      expect(q.query.length).toBeGreaterThan(0);
      expect(Array.isArray(q.expect_top)).toBe(true);
      expect(q.expect_top.length).toBeGreaterThan(0);
    }
  });

  it.skipIf(!HAS_QUERIES)(`records where each query came from, so a stale row can be retired ${HAS_QUERIES ? '' : NO_QUERIES}`, () => {
    for (const q of loadGoldenQueries()) expect(q.source).toBeTruthy();
  });

  it('throws on an EMPTY set rather than reporting a vacuous pass', () => {
    // The fixture exists and contains []. Pointing at a missing path instead
    // would make this pass on ENOENT and prove nothing about the empty case.
    const empty = resolve(__dirname, 'fixtures', 'golden-queries.empty.json');
    expect(readFileSync(empty, 'utf-8').trim()).toBe('[]');
    expect(() => loadGoldenQueries(empty)).toThrow(/empty/i);
  });

  it.skipIf(!HAS_QUERIES)(`is valid JSON on disk ${HAS_QUERIES ? '' : NO_QUERIES}`, () => {
    const raw = readFileSync(
      resolve(__dirname, 'fixtures', 'golden-queries.json'),
      'utf-8',
    );
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
