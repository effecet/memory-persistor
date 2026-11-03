/**
 * decayAll() must forward origin_host into syncToFile.
 *
 * The SQL half — memory_thermal_decay() returning the column — is pinned in
 * tests/integration/isolated/decay-origin-host.test.ts. This is the other half: the
 * function can return origin_host perfectly while decayAll drops it on the
 * floor, which is exactly the state that shipped. buildMarkdown then writes
 * `origin_host: unknown` and the file's machine attribution is gone.
 *
 * Source-text assertion for the same reason tests/centrality-normalization.ts
 * uses one: decayAll's only observable effect is a file write into a real
 * memory directory, and exercising it end-to-end means running the whole
 * corpus-wide decay against the shared integration database and writing live
 * markdown — the side effect an earlier issue exists to remove. Comments are stripped
 * first so a commented-out line cannot satisfy the match.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function activeSource(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function normalized(s: string): string {
  return s.replace(/\s+/g, ' ');
}

describe('decayAll forwards origin_host to the file sync', () => {
  const src = normalized(activeSource('src/thermal.ts'));

  it('passes originHost from the returned row', () => {
    expect(src).toContain('originHost: row.origin_host');
  });

  it('does not substitute a literal for a missing host', () => {
    // `originHost: row.origin_host ?? 'unknown'` would look like a fix and be
    // the bug: buildMarkdown already renders the `unknown` placeholder, so
    // baking one in here would make a NULL host indistinguishable from a
    // dropped one at every layer above.
    expect(src).not.toMatch(/originHost: row\.origin_host \?\?/);
  });
});
