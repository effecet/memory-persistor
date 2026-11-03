/**
 * Graph centrality must be normalized by the SAME measure it counts.
 *
 * The numerator is total degree — edges where the node is either endpoint
 * (`r.from_id = e.id OR r.to_id = e.id`). The denominator used to be
 * `MAX(COUNT(*) GROUP BY from_id)` unioned with `MAX(COUNT(*) GROUP BY to_id)`,
 * i.e. the max OUT-degree or IN-degree. Those are different measures, so the
 * ratio was not bounded by 1.
 *
 * Measured against a production corpus 2026-09-06 (861 entities): max total degree
 * 287 against a denominator of 285, so the top hub scored 1.007 on a signal
 * weighted 0.15 and contributed 0.1511. Small in magnitude, but a normalized
 * signal that exceeds its own weight budget is a bug, and it overpaid precisely
 * the most-connected node — the direction that hurts.
 *
 * These are source-text assertions because `recall()` builds its scoring SQL
 * inline and only ever executes it against a live Postgres; there is no seam to
 * read the expression back from, and the integration suite needs a database.
 * Same idiom as `tests/name-guard-wiring.test.ts` and `tests/env-loading.test.ts`.
 *
 * Loose substring matching has a known failure mode here: it still passes when
 * the code is commented out. So comment lines are stripped before matching.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEVANCE_WEIGHTS, PRIOR_WEIGHTS } from '../src/config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Source with ALL comments removed, so commented-out code cannot satisfy a match.
 *
 * Line-prefix filtering is not enough: interior lines of a block comment do not
 * start with `*`, so wrapping the correct expression in a `/* … *\/` while a wrong
 * one runs live survived an earlier version of these tests. Block spans are
 * stripped first, then line comments.
 */
function activeSource(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Collapse whitespace so SQL formatting changes don't break the assertions. */
function normalized(s: string): string {
  return s.replace(/\s+/g, ' ');
}

describe('recall graph-centrality normalization', () => {
  const src = normalized(activeSource('src/retrieve.ts'));

  it('counts total degree in the numerator', () => {
    expect(src).toContain('WHERE r.from_id = e.id OR r.to_id = e.id');
  });

  it('weights numerator and denominator with the SAME edge-weight expression', () => {
    // A weighted numerator over an unweighted denominator (or the reverse)
    // unbounds the ratio exactly as the one-directional bug did.
    expect(src).toContain('SELECT SUM(${edgeWeightExpr(sql`r.provenance`)}) FROM public.memory_relations r');
    expect(src).toContain('SELECT from_id AS id, ${edgeWeightExpr(sql`provenance`)} AS w FROM public.memory_relations');
    expect(src).toContain('SELECT to_id AS id, ${edgeWeightExpr(sql`provenance`)} AS w FROM public.memory_relations');
    expect(src).not.toMatch(/SELECT COUNT\(\*\)::float FROM public\.memory_relations r WHERE r\.from_id = e\.id/);
  });

  it('normalizes by max TOTAL degree, not max one-directional degree', () => {
    // The endpoints are unioned into a single column and grouped once, so the
    // aggregate measures the same thing the numerator counts. Matched without
    // depending on the subquery aliases, which are incidental.
    expect(src).toMatch(/UNION ALL SELECT to_id AS id/);
    expect(src).toMatch(/GROUP BY id/);
  });

  it('does NOT reintroduce the one-directional denominator', () => {
    // The exact shape of the bug: grouping by from_id and to_id separately and
    // taking the max across both. Either half alone is the regression.
    expect(src).not.toMatch(
      /SELECT COUNT\(\*\)::float AS cnt FROM public\.memory_relations GROUP BY from_id/,
    );
    expect(src).not.toMatch(
      /SELECT COUNT\(\*\)::float FROM public\.memory_relations GROUP BY to_id/,
    );
  });

  it('guards the DENOMINATOR against divide-by-zero, not just something', () => {
    // Anchored to the denominator specifically. NOT a 1.0 floor: with inferred
    // edges weighing < 1 a small graph's max sits below 1.0, and GREATEST(1.0,…)
    // would shrink every ratio there.
    expect(src).toMatch(/COALESCE\(NULLIF\(\( SELECT MAX\(cnt\)/);
    expect(src).not.toMatch(/GREATEST\(1\.0, \( SELECT MAX\(cnt\)/);
  });

  it('divides the degree by the dedicated denominator expression', () => {
    // Pins the wiring: a correct denominator that nothing divides by is dead code.
    expect(src).toContain('${CENTRALITY_EXPR} / ${CENTRALITY_DENOM_EXPR}');
  });

  it('keeps every scoring weight a real share of a 1.0 budget', () => {
    // Deliberately NOT asserting the current 0.55 query-independent vs 0.45
    // relevance split. That imbalance was identified (2026-09-06) as the actual cause of the reported
    // failure, and freezing it here would turn the intended rebalance into a
    // red gate — a test that fails when the bug is fixed. What IS safe to pin
    // is that centrality remains a bounded share.
    const total = Object.values(PRIOR_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 10);
    expect(Object.values(RELEVANCE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 10);
    expect(PRIOR_WEIGHTS.graphCentrality).toBeGreaterThan(0);
    expect(PRIOR_WEIGHTS.graphCentrality).toBeLessThan(total);
  });
});
