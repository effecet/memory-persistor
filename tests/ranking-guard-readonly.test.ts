/**
 * The measuring path must never call `recall` (the ranking guard, trap 1).
 *
 * `recall` BUMPS what it returns, and temperature is a prior — so measuring
 * ranking through `recall` would change the thing being measured, and the
 * baseline would drift every time the guard ran. `score-benchmark.ts` is
 * read-only by design; this pins that property instead of trusting the comment
 * that asserts it.
 *
 * Deliberately source-level rather than behavioural: a behavioural test would
 * need a database, and the property worth guarding is "this code path cannot
 * reach the writer", which is a static fact.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repo = (p: string): string => readFileSync(resolve(HERE, '..', p), 'utf-8');

/** Strip line and block comments so prose about `recall` is not a finding. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Names whose use would make the path a writer rather than a reader. */
const WRITER_SYMBOLS = ['recall', 'bump', 'bumpTemperature', 'logEvent'];

function writerReferences(src: string): string[] {
  const code = stripComments(src);
  // Any bare occurrence of the identifier in CODE — a call, an import binding,
  // or a re-export. Deliberately not an enumeration of syntactic forms: the
  // first version tried to match `import {`, `(` and `,` separately and missed
  // `import { recall }` outright, because `\b{` cannot match between a space
  // and a brace. Its own positive control caught that.
  //
  // The lookbehind excludes property access (`obj.recall`) so an unrelated
  // method never trips it; the lookahead keeps `recallByIds` from matching.
  return WRITER_SYMBOLS.filter((sym) =>
    new RegExp(`(?<![.\\w])${sym}(?![\\w])`).test(code),
  );
}

describe('the scoring path is read-only', () => {
  it('score-benchmark.ts never calls recall or bump', () => {
    expect(writerReferences(repo('scripts/score-benchmark.ts'))).toEqual([]);
  });

  it('score-benchmark.ts issues no write statement', () => {
    const code = stripComments(repo('scripts/score-benchmark.ts'));
    for (const verb of ['UPDATE ', 'INSERT ', 'DELETE ', 'TRUNCATE ']) {
      expect(code.toUpperCase()).not.toContain(verb);
    }
  });

  it('the detector actually fires (positive control)', () => {
    // Without this, the two assertions above would pass just as happily if the
    // matcher were broken — which is how a guard starts guarding nothing.
    expect(writerReferences('const rows = await recall(query);')).toContain('recall');
    expect(writerReferences("import { recall } from '../src/retrieve.js';")).toContain('recall');
  });

  it('comments mentioning recall are not findings (negative control)', () => {
    // The real files discuss `recall` at length in prose. A matcher that
    // flagged that would be untenable and would be disabled within a week.
    expect(writerReferences('// this deliberately avoids recall(...)')).toEqual([]);
    expect(writerReferences('/* recall(x) would reheat the corpus */')).toEqual([]);
  });
});

describe('the guard writes only through its seeder', () => {
  it('ranking-guard.ts never calls recall either', () => {
    // It DOES write — seeding truncates and inserts — so only the recall/bump
    // prohibition applies here, not the no-write-statement one.
    expect(writerReferences(repo('scripts/ranking-guard.ts'))).toEqual([]);
  });

  it('every write it makes is against the fixture source sentinel', () => {
    const code = stripComments(repo('scripts/ranking-guard.ts'));
    // The truncate-safety check keys on rows NOT stamped with SEED_SOURCE. If
    // an insert ever stopped stamping it, the guard would refuse to re-run
    // against its own output — and the tempting fix would be to weaken the
    // safety check rather than restore the stamp.
    expect(code).toContain('const SEED_SOURCE');
    expect(code).toMatch(/INSERT INTO public\.entities[\s\S]*\$\{SEED_SOURCE\}/);
  });
});

describe('golden-corpus.ts stays import-free', () => {
  it('has no import or require statements', () => {
    // Not a style rule. ranking-guard.ts imports ../src/db.js, which builds a
    // pg Pool and loads dotenv at module scope; the digest machinery lives in
    // golden-corpus.ts precisely so the unit suite can test it without dragging
    // a database client in. That property was asserted only in prose, so a
    // future `import { db }` would have re-added the Pool with nothing going
    // red (the digest pin review).
    const code = stripComments(repo('scripts/golden-corpus.ts'));
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it('the detector fires on a real import line (positive control)', () => {
    expect(stripComments("import { db } from '../src/db.js';\n")).toMatch(/^\s*import\s/m);
  });
});
