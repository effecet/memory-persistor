/**
 * Tests for the ranking-regression guard's pure logic.
 *
 * These cover the two ways this guard would rot SILENTLY — still green, no
 * longer measuring anything:
 *   1. absolute timestamps making the recency signal drift as the fixture ages
 *   2. a comparison whose direction is wrong for one of the two roles
 *
 * Everything here is pure. The database-backed half lives in the CI job.
 */

import { describe, it, expect } from 'vitest';
import {
  timestampForOffset,
  corpusDigest,
  compareToBaseline,
  type GoldenCorpus,
  type BaselineQuery,
} from '../scripts/golden-corpus.js';

const QUERY = 'close an issue from a commit message';
const ROLES = {
  [QUERY]: {
    'Close an issue from a commit': 'expect_top',
    'Tracker closes one per line': 'expect_top',
    'API token scopes per account': 'expect_not_top',
  },
} as const;

const roles = ROLES as unknown as Record<
  string,
  Record<string, 'expect_top' | 'expect_not_top'>
>;

function baselineQuery(ranks: Record<string, number | null>): BaselineQuery[] {
  return [{ query: QUERY, ranks }];
}

describe('timestampForOffset', () => {
  it('produces the same AGE regardless of when the fixture is seeded', () => {
    // The property RECENCY_EXPR actually reads is NOW() - last_accessed_at.
    // Two seeds months apart must yield the same age for the same offset, or
    // the baseline drifts with the calendar rather than with the code.
    const early = new Date('2026-01-01T00:00:00Z');
    const late = new Date('2026-09-08T00:00:00Z');

    const ageAt = (seedNow: Date): number =>
      seedNow.getTime() - timestampForOffset(12.5, seedNow).getTime();

    expect(ageAt(early)).toBe(ageAt(late));
    expect(ageAt(early)).toBe(12.5 * 86_400_000);
  });

  it('an absolute timestamp would NOT have this property (control)', () => {
    // Proves the test above is not vacuous: pinning a fixed instant makes the
    // age depend on when you look, which is exactly the bug being avoided.
    const fixed = new Date('2026-01-01T00:00:00Z');
    const ageFrom = (seedNow: Date): number => seedNow.getTime() - fixed.getTime();
    expect(ageFrom(new Date('2026-02-01T00:00:00Z'))).not.toBe(
      ageFrom(new Date('2026-09-08T00:00:00Z')),
    );
  });
});

describe('corpusDigest', () => {
  const base: GoldenCorpus = {
    generatedAt: '2026-09-08T00:00:00Z',
    sourceCommit: 'aff7272',
    liveShape: { entities: 904, edges: 1794, maxDegree: 291 },
    entities: [
      {
        id: 'b1',
        name: 'B',
        entityType: 'reference',
        observations: 'second',
        tags: ['x'],
        tier: 'COLD',
        temperature: 0.03,
        importance: 0.5,
        accessCount: 1,
        lastAccessedDaysAgo: 10,
        createdDaysAgo: 100,
        embedding: [0.1, 0.2],
      },
      {
        id: 'a1',
        name: 'A',
        entityType: 'feedback',
        observations: 'first',
        tags: ['b', 'a'],
        tier: 'HOT',
        temperature: 1,
        importance: 0.9,
        accessCount: 7,
        lastAccessedDaysAgo: null,
        createdDaysAgo: 5,
        embedding: null,
      },
    ],
    relations: [{ fromId: 'a1', toId: 'b1', relationType: 'related_to' }],
    queryEmbeddings: { [QUERY]: [0.5, 0.5] },
  };

  it('is stable across entity order and tag order', () => {
    const shuffled: GoldenCorpus = {
      ...base,
      entities: [base.entities[1], base.entities[0]].map((e) => ({
        ...e,
        tags: [...e.tags].reverse(),
      })),
    };
    expect(corpusDigest(shuffled)).toBe(corpusDigest(base));
  });

  it('ignores generatedAt and sourceCommit', () => {
    // Re-snapshotting an unchanged corpus must not invalidate the baseline.
    const resnapshot: GoldenCorpus = {
      ...base,
      generatedAt: '2027-01-01T00:00:00Z',
      sourceCommit: 'deadbeef',
    };
    expect(corpusDigest(resnapshot)).toBe(corpusDigest(base));
  });

  it('changes when an embedding changes', () => {
    const drifted: GoldenCorpus = {
      ...base,
      entities: base.entities.map((e) =>
        e.id === 'b1' ? { ...e, embedding: [0.1, 0.9] } : e,
      ),
    };
    expect(corpusDigest(drifted)).not.toBe(corpusDigest(base));
  });

  it('changes when temperature changes', () => {
    // Temperature feeds the prior, so it is ranking-relevant material.
    const drifted: GoldenCorpus = {
      ...base,
      entities: base.entities.map((e) => (e.id === 'a1' ? { ...e, temperature: 0.4 } : e)),
    };
    expect(corpusDigest(drifted)).not.toBe(corpusDigest(base));
  });
});

describe('compareToBaseline', () => {
  it('flags an expect_top target sliding down', () => {
    const r = compareToBaseline(
      baselineQuery({ 'Close an issue from a commit': 3 }),
      baselineQuery({ 'Close an issue from a commit': 6 }),
      roles,
    );
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatchObject({ name: 'Close an issue from a commit', baseline: 3, current: 6 });
    expect(r.improvements).toHaveLength(0);
  });

  it('passes an expect_top target climbing, and calls it an improvement', () => {
    const r = compareToBaseline(
      baselineQuery({ 'Close an issue from a commit': 6 }),
      baselineQuery({ 'Close an issue from a commit': 2 }),
      roles,
    );
    expect(r.regressions).toHaveLength(0);
    expect(r.improvements).toHaveLength(1);
  });

  it('flags a distractor CLIMBING — the opposite direction', () => {
    // The the hub-ranking bug failure shape: the hub rising above the real targets. A guard
    // that used one direction for both roles would pass this.
    const r = compareToBaseline(
      baselineQuery({ 'API token scopes per account': 9 }),
      baselineQuery({ 'API token scopes per account': 1 }),
      roles,
    );
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0].role).toBe('expect_not_top');
  });

  it('treats a target dropping out of the top-N as the worst case, not unknown', () => {
    // null must rank WORSE than any number. Treating it as "no data" would let
    // total retrieval failure pass silently.
    const r = compareToBaseline(
      baselineQuery({ 'Close an issue from a commit': 4 }),
      baselineQuery({ 'Close an issue from a commit': null }),
      roles,
    );
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0].current).toBeNull();
  });

  it('treats a distractor dropping out entirely as an improvement', () => {
    const r = compareToBaseline(
      baselineQuery({ 'API token scopes per account': 2 }),
      baselineQuery({ 'API token scopes per account': null }),
      roles,
    );
    expect(r.regressions).toHaveLength(0);
    expect(r.improvements).toHaveLength(1);
  });

  it('counts an unchanged rank rather than reporting it', () => {
    const r = compareToBaseline(
      baselineQuery({ 'Close an issue from a commit': 3 }),
      baselineQuery({ 'Close an issue from a commit': 3 }),
      roles,
    );
    expect(r.unchanged).toBe(1);
    expect(r.regressions).toHaveLength(0);
    expect(r.improvements).toHaveLength(0);
  });

  it('reports a baselined name the golden set no longer mentions', () => {
    // the entity rename renamed nine entities. A renamed target must surface, not vanish —
    // silently dropping it is how a guard starts measuring nothing.
    const r = compareToBaseline(
      baselineQuery({ 'Some Renamed Memory': 2 }),
      baselineQuery({ 'Some Renamed Memory': 2 }),
      roles,
    );
    expect(r.missingFromCurrent).toContain(`${QUERY} :: Some Renamed Memory`);
    expect(r.unchanged).toBe(0);
  });

  it('reports a whole query missing from the current run', () => {
    const r = compareToBaseline(baselineQuery({ 'Close an issue from a commit': 1 }), [], roles);
    expect(r.missingFromCurrent).toContain(QUERY);
  });

  it('both-absent is unchanged, not a regression', () => {
    const r = compareToBaseline(
      baselineQuery({ 'Close an issue from a commit': null }),
      baselineQuery({ 'Close an issue from a commit': null }),
      roles,
    );
    expect(r.unchanged).toBe(1);
    expect(r.regressions).toHaveLength(0);
  });
});
