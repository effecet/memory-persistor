/**
 * The two weight groups are the contract behind `score = relevance × (1 + α·prior)`.
 *
 * Each must sum to exactly 1.0, or the product is not bounded the way the model
 * assumes. The tolerance below is deliberately tight: rounded literals
 * (0.2727 × 5 = 1.3635/1.0 off by 1e-4) sail through a loose check while leaving
 * the score subtly unbounded.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEVANCE_WEIGHTS, PRIOR_WEIGHTS, PRIOR_ALPHA } from '../src/config.js';

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Source with ALL comments removed, so commented-out code cannot satisfy a match.
 * Same idiom as tests/centrality-normalization.test.ts and
 * tests/name-guard-wiring.test.ts — recall() builds its scoring SQL inline and
 * only ever executes it against a live Postgres, so there is no seam to read
 * the expression back from at runtime; asserting on stripped source text is
 * the idiom this repo uses instead of a `.queryChunks.join('')` check, which
 * still passes with the code commented out.
 */
function activeSource(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('scoring weight groups', () => {
  it('relevance weights sum to exactly 1.0', () => {
    expect(sum(RELEVANCE_WEIGHTS)).toBeCloseTo(1.0, 10);
  });

  it('prior weights sum to exactly 1.0', () => {
    expect(sum(PRIOR_WEIGHTS)).toBeCloseTo(1.0, 10);
  });

  it('preserves the pre-rebalance within-group ratios exactly', () => {
    // This change is structural, not a re-tune: multiplying each normalized weight
    // back by its old group total must reproduce the original SCORING_WEIGHTS
    // (relevance 0.13/0.10/0.12/0.10 summing to 0.45; prior 0.15/0.15/0.10/0.10/0.05
    // summing to 0.55). If a future commit re-tunes within a group, this test should
    // be updated deliberately — it is here so that cannot happen by accident while
    // the rebalance benchmark is attributing its effect to the model.
    expect(RELEVANCE_WEIGHTS.textRank * 0.45).toBeCloseTo(0.13, 10);
    expect(RELEVANCE_WEIGHTS.trigramSimilarity * 0.45).toBeCloseTo(0.10, 10);
    expect(RELEVANCE_WEIGHTS.semanticSimilarity * 0.45).toBeCloseTo(0.12, 10);
    expect(RELEVANCE_WEIGHTS.tagMatch * 0.45).toBeCloseTo(0.10, 10);
    expect(PRIOR_WEIGHTS.temperature * 0.55).toBeCloseTo(0.15, 10);
    expect(PRIOR_WEIGHTS.graphCentrality * 0.55).toBeCloseTo(0.15, 10);
    expect(PRIOR_WEIGHTS.importance * 0.55).toBeCloseTo(0.10, 10);
    expect(PRIOR_WEIGHTS.recencyBoost * 0.55).toBeCloseTo(0.10, 10);
    expect(PRIOR_WEIGHTS.accessFrequency * 0.55).toBeCloseTo(0.05, 10);
  });

  it('exposes an alpha in the range the benchmark explores', () => {
    expect(PRIOR_ALPHA).toBeGreaterThanOrEqual(0);
    expect(PRIOR_ALPHA).toBeLessThanOrEqual(1);
  });

  it('keeps every weight a positive share of its group', () => {
    for (const [name, w] of Object.entries({ ...RELEVANCE_WEIGHTS, ...PRIOR_WEIGHTS })) {
      expect(w, name).toBeGreaterThan(0);
      expect(w, name).toBeLessThan(1);
    }
  });

  it('temperature prior reads temperature_rank, falling back to raw temperature', () => {
    const src = activeSource('src/retrieve.ts');
    // The full fallback chain, not just 'COALESCE' in isolation — src/retrieve.ts
    // has 14 other COALESCEs, so a bare substring check passes even with the
    // e.temperature fallback removed entirely. Rows written between nightly
    // decay runs have a NULL rank and must still fall through to raw
    // temperature, never straight to 0 (which would rank a brand-new memory
    // below every ranked one) — this pins the exact three-argument chain.
    expect(src).toContain('COALESCE(e.temperature_rank, e.temperature, 0)');
  });
});
