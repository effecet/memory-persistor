/**
 * `health`'s payload must not grow with the corpus.
 *
 * `applyResponseCap` is wired into retrieve.ts only, so RESPONSE_CAP_BYTES had
 * never governed `health` at all. `orphans` had no LIMIT, and
 * `dedupCandidates`' LIMIT 100 serializes to ~42 KB — 1.4x the cap it was
 * presumably chosen to respect. It read as safe only because
 * dedupCandidateCount is 0 today; a threshold change, an embedding backfill or
 * a burst of near-dupes takes that field from 0 to 42 KB with no code change.
 * Both fields grow in correlation with the pathology they report, so the
 * diagnostic degrades precisely in the incident it exists to diagnose.
 *
 * ⚠️ These assertions measure with RESPONSE_JSON_INDENT, because that is what
 * the MCP handler emits. The first cut of this change budgeted against COMPACT
 * JSON while the boundary emitted indented JSON — 26% larger — so every test
 * was green while the real response sat 1_881 B OVER the cap. A byte guard that
 * measures a string the system never produces is worse than no guard: it
 * reports the property as held.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enforceHealthCap,
  type DedupCandidatePair,
  type HealthResult,
} from '../src/observability.js';
import {
  RESPONSE_CAP_BYTES,
  RESPONSE_JSON_INDENT,
  HEALTH_ORPHAN_LIMIT,
  HEALTH_DEDUP_LIMIT,
} from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** Exactly how the MCP boundary serializes a tool response. */
const emitted = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value, null, RESPONSE_JSON_INDENT), 'utf8');

const orphan = (name: string) => ({ id: UUID, name });

const pair = (name: string): DedupCandidatePair => ({
  aId: UUID,
  aName: name,
  aObservationsLength: 2481,
  aCreatedAt: '2026-04-23T14:02:11.482Z',
  bId: UUID,
  bName: name,
  bObservationsLength: 1974,
  bCreatedAt: '2026-04-26T09:15:03.221Z',
  similarity: 0.9412345886230469,
  proposedCanonicalId: UUID,
});

function health(over: Partial<HealthResult> = {}): HealthResult {
  return {
    orphanCount: 0,
    orphans: [],
    orphansTruncated: false,
    staleCount: 665,
    dedupCandidateCount: 0,
    dedupCandidates: [],
    dedupCandidatesTruncated: false,
    contradictionCount: 0,
    typeCoverage: [{ type: 'feedback', count: 372 }],
    typeCoverageTruncated: false,
    totalMemories: 955,
    totalEdges: 1888,
    edgeProvenance: { asserted: 334, inferred: 1554 },
    graph: {
      degree: { min: 0, median: 2, p95: 8, max: 291, zeroCount: 22 },
      hubs: [{ id: UUID, name: 'API token scopes per account', degree: 291 }],
      communities: { count: 26, largest: 927, median: 1, singletons: 22 },
      centralityDenominator: 291,
      hubsTruncated: false,
    },
    thermalCutoffs: {
      hot: 0.0644672,
      warm: 0.0027634,
      source: 'measured',
      corpusSize: 955,
      computedAt: '2026-09-18T13:39:41.587Z',
    },
    ...over,
  };
}

describe('enforceHealthCap', () => {
  it('leaves a small payload untouched', () => {
    const input = health({ orphanCount: 1, orphans: [orphan('a lonely memory')] });
    const out = enforceHealthCap(input);
    expect(out.orphans).toHaveLength(1);
    // Negative controls for EVERY flag. Without them a flag hardcoded `true`
    // passes — every response would claim it was cut when it was not, which is
    // the mirror of the defect the flags exist to remove. hubsTruncated had no
    // such control and survived being hardcoded true (the health-cap change re-review).
    expect(out.orphansTruncated).toBe(false);
    expect(out.dedupCandidatesTruncated).toBe(false);
    expect(out.graph.hubsTruncated).toBe(false);
    expect(out.typeCoverageTruncated).toBe(false);
  });

  it('trims until the EMITTED payload fits, not the compact one', () => {
    // The regression this file exists for. 955 orphans is the degenerate shape:
    // auto-relate stops creating edges, so every row is an orphan.
    const out = enforceHealthCap(
      health({
        orphanCount: 955,
        orphans: Array.from({ length: 955 }, (_, i) => orphan(`a typical memory name ${i}`)),
      }),
    );
    expect(emitted(out)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(out.orphans.length).toBeLessThan(955);
    expect(out.orphansTruncated).toBe(true);
    // The count is the load-bearing part and must survive the trim intact.
    expect(out.orphanCount).toBe(955);
  });

  it('bounds BYTES, not rows — a few pathological names still fit the cap', () => {
    // The property a row cap cannot give you: entities.name is unbounded text,
    // so 20 rows can exceed a budget that 100 ordinary rows sit inside.
    const out = enforceHealthCap(
      health({
        orphanCount: 20,
        orphans: Array.from({ length: 20 }, () => orphan('x'.repeat(4_000))),
      }),
    );
    expect(emitted(out)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(out.orphansTruncated).toBe(true);
  });

  it('trims whichever list actually occupies the most bytes', () => {
    // NOT a fixed priority. A costliest-per-ROW order drained the 3 dedup pairs
    // to 1 before touching 100 fat orphans — sacrificing the scarcer diagnostic
    // to shrink a payload the orphans had bloated. Here orphans dominate, so
    // orphans are what gets cut.
    const input = health({
      orphanCount: 200,
      orphans: Array.from({ length: 200 }, (_, i) => orphan(`a reasonably typical name ${i}`)),
      dedupCandidateCount: 20,
      dedupCandidates: Array.from({ length: 20 }, (_, i) => pair(`a near duplicate name ${i}`)),
    });
    expect(emitted(input)).toBeGreaterThan(RESPONSE_CAP_BYTES);

    const out = enforceHealthCap(input);
    expect(emitted(out)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(out.orphans.length).toBeLessThan(200);
    expect(out.orphansTruncated).toBe(true);
    // The scarce, expensive-to-recompute diagnostic survives intact.
    expect(out.dedupCandidates).toHaveLength(20);
    expect(out.dedupCandidatesTruncated).toBe(false);
  });

  it('spreads the cut across lists instead of destroying one', () => {
    // Measured regressions this pins. An unbounded inner loop took
    // dedupCandidates 100 -> 1 and left orphans, hubs and typeCoverage
    // untouched at 100 — one diagnostic destroyed, three intact.
    const many = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
    const out = enforceHealthCap(
      health({
        orphanCount: 100,
        orphans: many(100, (i) => orphan(`orphan name ${i}`)),
        dedupCandidateCount: 100,
        dedupCandidates: many(100, (i) => pair(`pair ${i}`)),
        typeCoverage: many(100, (i) => ({ type: `type ${i}`, count: i })),
        graph: { ...health().graph, hubs: many(100, (i) => ({ id: UUID, name: `hub ${i}`, degree: i })) },
      }),
    );
    expect(emitted(out)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    // No list is wiped out to its floor while others stay whole.
    expect(out.dedupCandidates.length).toBeGreaterThan(1);
    expect(out.orphans.length).toBeGreaterThan(1);
    expect(out.graph.hubs.length).toBeGreaterThan(1);
  });

  it('drops only the row that caused the overflow, not a mean-sized guess', () => {
    // Dropping ceil(overshoot / MEAN row bytes) let one fat tail row inflate
    // the mean: 99 tiny rows plus one 100 KB row lost 73 rows and landed at
    // 1_441 B inside a 30 KB budget. Real per-row sizes drop just the fat one.
    const rows = [
      ...Array.from({ length: 99 }, (_, i) => orphan(`o${i}`)),
      orphan('x'.repeat(100_000)),
    ];
    const out = enforceHealthCap(health({ orphanCount: 100, orphans: rows }));
    expect(emitted(out)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(out.orphans.length).toBeGreaterThanOrEqual(90);
  });

  it('cuts the dedup list when IT is the bloat', () => {
    // The converse, so the previous test cannot pass by always cutting orphans.
    const input = health({
      orphanCount: 3,
      orphans: Array.from({ length: 3 }, (_, i) => orphan(`orphan ${i}`)),
      dedupCandidateCount: HEALTH_DEDUP_LIMIT,
      dedupCandidates: Array.from({ length: HEALTH_DEDUP_LIMIT }, () =>
        pair('a near duplicate memory name that is quite long indeed '.repeat(12)),
      ),
    });
    expect(emitted(input)).toBeGreaterThan(RESPONSE_CAP_BYTES);

    const out = enforceHealthCap(input);
    expect(emitted(out)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(out.dedupCandidates.length).toBeLessThan(HEALTH_DEDUP_LIMIT);
    expect(out.dedupCandidatesTruncated).toBe(true);
    expect(out.orphans).toHaveLength(3);
  });

  it('covers graph.hubs too, not just the two obvious lists', () => {
    // hubs holds 10 unbounded names and sat outside the first cut's per-field
    // accounting: one pathological hub name reopened the whole failure.
    const out = enforceHealthCap(
      health({
        graph: {
          ...health().graph,
          hubs: Array.from({ length: 10 }, () => ({
            id: UUID,
            name: 'h'.repeat(8_000),
            degree: 291,
          })),
        },
      }),
    );
    expect(emitted(out)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(out.graph.hubs.length).toBeLessThan(10);
    // …and SAYS it cut them. Without this a 3-hub list reads as a 3-hub corpus
    // — the defect orphansTruncated exists to remove, left open on list three.
    expect(out.graph.hubsTruncated).toBe(true);
  });

  it('trims typeCoverage rather than claiming it cannot grow', () => {
    // Leaving typeCoverage out was justified by MEMORY_TYPES clamping every
    // write path, and measured wrong: 50 oversized rows returned 103_236 B,
    // 3.44x the cap, with every other list already exhausted. `type` is `text`
    // in the schema; boundedness must not rest on a rule enforced elsewhere.
    const out = enforceHealthCap(
      health({
        typeCoverage: Array.from({ length: 50 }, (_, i) => ({
          type: `${'t'.repeat(2_000)}${i}`,
          count: 1,
        })),
      }),
    );
    expect(emitted(out)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    expect(out.typeCoverage.length).toBeLessThan(50);
    // A short census is a WRONG DISTRIBUTION, not just a short list, so this
    // flag matters more than the others.
    expect(out.typeCoverageTruncated).toBe(true);
  });

  it('never empties a list that had rows', () => {
    // `[]` during an incident reads as "no orphans" — indistinguishable from a
    // healthy brain, which is the confusion this whole issue is about. One
    // oversized row is strictly more informative.
    const out = enforceHealthCap(
      health({ orphanCount: 3, orphans: Array.from({ length: 3 }, () => orphan('y'.repeat(60_000))) }),
    );
    expect(out.orphans).toHaveLength(1);
    expect(out.orphansTruncated).toBe(true);
  });

  it('does not mutate its input', () => {
    const input = health({
      orphanCount: 955,
      orphans: Array.from({ length: 955 }, (_, i) => orphan(`memory ${i}`)),
    });
    enforceHealthCap(input);
    expect(input.orphans).toHaveLength(955);
  });
});

describe('the cap is measured in the units the boundary emits', () => {
  it('indented serialization is materially larger than compact', () => {
    // Pins the premise. If this ratio ever collapsed to 1.0 the distinction
    // would be academic — it is ~1.26 for these shapes, which is what made the
    // first cut ship a payload 1_881 B over the cap with green tests.
    const payload = health({
      orphanCount: 200,
      orphans: Array.from({ length: 200 }, (_, i) => orphan(`a typical memory name ${i}`)),
    });
    const compact = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    expect(emitted(payload)).toBeGreaterThan(compact * 1.15);
  });

  it('a payload that fits COMPACT can still bust the real cap', () => {
    // The exact trap, executable: sized to sit under the cap compact and over
    // it emitted. enforceHealthCap must judge it by the emitted size.
    // 300 rows: 26_064 B compact (under the cap) against 34_140 B emitted
    // (over it). Measured — this window is exactly where the first cut shipped.
    const rows = Array.from({ length: 300 }, (_, i) => orphan(`a reasonably typical name ${i}`));
    const payload = health({ orphanCount: rows.length, orphans: rows });
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(
      RESPONSE_CAP_BYTES,
    );
    expect(emitted(payload)).toBeGreaterThan(RESPONSE_CAP_BYTES);
    expect(emitted(enforceHealthCap(payload))).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
  });
});

describe('the row caps stay coherent with the payload cap', () => {
  it('the OLD dedup cap of 100 would not have fit (regression control)', () => {
    // The finding the health-cap change was opened on: 100 pairs at ~421 B serializes to ~42 KB
    // against a 30 KB cap. If someone restores it, this arithmetic refuses.
    // Measured from the fixture, not a hand-copied constant: a magic byte
    // number in the one file whose thesis is "measure in the units the
    // boundary emits" would repeat the lesson in miniature.
    const perPair = emitted(pair('example-repo Phase 0 — fanout merged 2026-04-23'));
    expect(100 * perPair).toBeGreaterThan(RESPONSE_CAP_BYTES);
    expect(HEALTH_DEDUP_LIMIT * perPair).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
  });

  it('a full orphan page at the row cap fits without trimming', () => {
    // The row cap should be the binding constraint in NORMAL operation, with
    // the payload cap as the backstop for pathological names. If this starts
    // failing, HEALTH_ORPHAN_LIMIT has outgrown the byte cap.
    const rows = Array.from({ length: HEALTH_ORPHAN_LIMIT }, (_, i) =>
      orphan(`a reasonably typical memory name ${i}`),
    );
    const out = enforceHealthCap(health({ orphanCount: rows.length, orphans: rows }));
    expect(out.orphans).toHaveLength(HEALTH_ORPHAN_LIMIT);
    expect(out.orphansTruncated).toBe(false);
  });
});

describe('the capped lists are a DETERMINISTIC prefix', () => {
  it('the orphan query orders before it limits', () => {
    // A LIMIT with no ORDER BY returns an arbitrary subset, so two calls can
    // disagree about WHICH orphans exist while both report the same count —
    // and "the list changed" is indistinguishable from "the corpus changed".
    //
    // Source-level because it cannot be shown behaviourally: an unordered
    // query is free to return the same rows every time, so a passing
    // round-trip would prove nothing.
    const src = readFileSync(resolve(HERE, '..', 'src', 'observability.ts'), 'utf-8');
    const orphanQuery = src.slice(
      src.indexOf('Orphan memories (0 edges)'),
      src.indexOf('// Stale count'),
    );
    expect(orphanQuery).toMatch(/ORDER BY[\s\S]*LIMIT/);
  });

  it('the detector fires when ORDER BY is absent (positive control)', () => {
    expect('SELECT e.id FROM entities\n LIMIT 100').not.toMatch(/ORDER BY[\s\S]*LIMIT/);
  });
});

describe('the handler and the budget cannot drift apart', () => {
  it('the health MCP handler serializes with RESPONSE_JSON_INDENT, not a literal', () => {
    // THE regression. `JSON.stringify(health, null, 2)` at the boundary and a
    // budget measured against compact JSON is how a green suite shipped a
    // response 1_881 B over the cap. Sharing one constant is what makes the two
    // impossible to separate — but only if the handler actually uses it, which
    // is a source fact no behavioural test can see.
    const src = readFileSync(resolve(HERE, '..', 'src', 'mcp-tools.ts'), 'utf-8');
    expect(src).toMatch(/JSON\.stringify\(health, null, RESPONSE_JSON_INDENT\)/);
    expect(src).not.toMatch(/JSON\.stringify\(health, null, \d/);
  });

  it('the detector fires on the literal form (positive control)', () => {
    const bad = 'text: JSON.stringify(health, null, 2),';
    expect(bad).toMatch(/JSON\.stringify\(health, null, \d/);
  });
});
