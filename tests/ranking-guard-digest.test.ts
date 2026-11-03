/**
 * `seedProcedureDigest()` is the guard that protects the ranking guard.
 *
 * `corpusDigest()` only ever hashed the FIXTURE. The ranking gate for percentile tiering was
 * found vacuous because `seedCorpus()` never populated `entities.temperature_rank`
 * — the guard reported "0 regressed" while measuring nothing. Fixing the seeder
 * then silently redefined what the recorded baseline meant, with no mismatch
 * ever firing. Folding the seeding PROCEDURE into the digest closes that.
 *
 * Which makes this digest load-bearing and, until now, unpinned. Its mismatch
 * path was verified by hand once during the percentile tiering fix wave and never since. The
 * specific worry is that the extraction is string parsing over source text, and
 * its failure mode is returning *something* rather than throwing: if a refactor
 * made it return a constant, swallow its own error, or miss the `seedCorpus(`
 * marker and hash an empty string, every future run would pass and nothing
 * would say so.
 *
 * Point 4 below matters as much as the rest. If the digest silently degrades to
 * whole-file sensitivity, every unrelated edit invalidates the baseline, and the
 * pressure becomes to re-record it reflexively — which turns the guard into a
 * rubber stamp by a different route.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SEED_PROCEDURE_MARKER,
  assertDigestMatches,
  corpusDigest,
  extractSeedCorpusBody,
  seedProcedureDigest,
  type GoldenCorpus,
} from '../scripts/golden-corpus.js';
import { resolveBaselinePath, parseBaseline } from '../scripts/ranking-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The corpus is a snapshot of a real database and does not ship with this repo; see README § Ranking guard. */
const HAS_CORPUS = existsSync(resolve(HERE, 'fixtures', 'golden-corpus.json'));
const NO_CORPUS = '(skipped: no golden corpus — see README § Ranking guard)';

/** The real script's source, for the tests that assert against it. */
const readRankingGuardSource = (): string =>
  readFileSync(resolve(HERE, '..', 'scripts', 'ranking-guard.ts'), 'utf-8');

const readGoldenCorpus = (): GoldenCorpus =>
  JSON.parse(
    readFileSync(resolve(HERE, 'fixtures', 'golden-corpus.json'), 'utf-8'),
  ) as GoldenCorpus;

/**
 * Run the real CLI with a baseline file of our choosing, and no reachable
 * database.
 *
 * DOTENV_CONFIG_PATH is the load-bearing part, not DATABASE_URL: src/db.ts
 * calls dotenv.config({ override: true }), so an injected DATABASE_URL is
 * CLOBBERED by ./.env and the child runs against the real dev brain. Measured
 * — the first version of this helper's caller believed it was pointing at an
 * unreachable host while actually reaching localhost:5432/memory_persistor, and
 * was saved from truncating the dev database only by assertSafeToTruncate's
 * foreign-row guard. Pointing dotenv at an empty file is what makes the
 * injected DSN survive.
 */
function runGuard(baselineBody: unknown): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ranking-guard-baseline-'));
  try {
    const fake = join(dir, 'golden-baseline.json');
    const emptyEnv = join(dir, 'empty.env');
    writeFileSync(fake, JSON.stringify(baselineBody));
    writeFileSync(emptyEnv, '');
    // `node --import <file:// loader>`, never `npx tsx`: the tsx CLI form forks
    // a child that listens on a Unix socket under /tmp, which the Claude Code
    // sandbox refuses with EPERM — the trap CLAUDE.md records for the MCP
    // launcher. The in-process loader has no IPC.
    const loader = pathToFileURL(
      resolve(HERE, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs'),
    ).href;
    const run = spawnSync(
      process.execPath,
      ['--import', loader, resolve(HERE, '..', 'scripts', 'ranking-guard.ts'), '--baseline', fake],
      {
        cwd: resolve(HERE, '..'),
        encoding: 'utf-8',
        // spawnSync blocks the worker thread, so vitest.config.ts's 30s
        // testTimeout cannot interrupt it. Without this the unit suite could
        // hang unbounded on a slow CI runner if main() ever failed to exit.
        timeout: 30_000,
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: emptyEnv,
          DATABASE_URL: 'postgres://nobody@127.0.0.1:1/definitely-not-a-database',
        },
      },
    );
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The digest main() is expected to compute, rebuilt from the real inputs. */
const expectedDigest = (): string =>
  `${corpusDigest(readGoldenCorpus())}:${seedProcedureDigest(readRankingGuardSource())}`;

/**
 * A miniature stand-in for ranking-guard.ts: a `seedCorpus()` surrounded by the
 * unrelated functions whose edits must NOT invalidate the baseline. Synthetic
 * rather than the real file so a mutation can be applied to one region at a
 * time — the real file cannot be edited from a test.
 */
const SYNTHETIC = `
const HERE = dirname(fileURLToPath(import.meta.url));

function renderTable(rows: string[]): void {
  console.log('render-before');
}

${SEED_PROCEDURE_MARKER}corpus: GoldenCorpus): Promise<void> {
  await db.execute(sql\`TRUNCATE public.entities CASCADE\`);
  for (const e of corpus.entities) {
    await db.execute(sql\`INSERT INTO public.entities VALUES (\${e.id})\`);
  }
}

async function main(): Promise<void> {
  console.log('main-before');
}
`;

describe('the extraction actually finds a body (point 2)', () => {
  it('the real seedCorpus() body is non-empty and contains its actual statements', () => {
    // A digest over an empty string is the vacuous case: stable, healthy-looking
    // and meaningless. The content assertions below imply non-emptiness, so
    // there is no separate length check.
    // Tokens chosen to be load-bearing rather than incidental: the TRUNCATE is
    // what makes this a seeder, and the cume_dist UPDATE is the exact statement
    // whose absence made the percentile tiering gate vacuous in the first place.
    const digestInput = extractSeedCorpusBody(readRankingGuardSource());
    expect(digestInput).toContain('TRUNCATE public.memory_relations');
    expect(digestInput).toContain('temperature_rank');
    expect(digestInput).toContain('cume_dist()');
    // …and stops there: on the real file, not just on SYNTHETIC.
    expect(digestInput).not.toContain('async function main');
  });

  it('stops at the matching brace rather than swallowing the rest of the file', () => {
    // The whole point of scoping to seedCorpus() is that main() and
    // renderTable() are NOT covered. If the scan ran to end-of-file this would
    // still produce a plausible non-empty digest.
    const body = extractSeedCorpusBody(SYNTHETIC);
    expect(body).toContain('TRUNCATE public.entities');
    expect(body).not.toContain('main-before');
    expect(body).not.toContain('render-before');
  });
});

describe('the digest is sensitive to a seeder change (point 3)', () => {
  it('changing a statement inside seedCorpus() changes the digest', () => {
    // This is the property the entire mechanism claims. Without it, percentile tiering's
    // silent-redefinition of the baseline can happen again unnoticed.
    const before = seedProcedureDigest(SYNTHETIC);
    const after = seedProcedureDigest(
      SYNTHETIC.replace('TRUNCATE public.entities CASCADE', 'TRUNCATE public.entities'),
    );
    expect(after).not.toBe(before);
  });

  it('adding a statement inside seedCorpus() changes the digest', () => {
    const before = seedProcedureDigest(SYNTHETIC);
    const after = seedProcedureDigest(
      SYNTHETIC.replace(
        '  }\n}\n\nasync function main',
        '  }\n  await db.execute(sql`UPDATE public.entities SET temperature_rank = 0`);\n}\n\nasync function main',
      ),
    );
    expect(after).not.toBe(before);
  });
});

describe('the digest is NOT sensitive to unrelated edits (point 4)', () => {
  it('editing main() does not change the digest', () => {
    const before = seedProcedureDigest(SYNTHETIC);
    const after = seedProcedureDigest(SYNTHETIC.replace('main-before', 'main-after'));
    // Control: the mutation really was applied, so a no-op replace cannot make
    // this pass vacuously.
    expect(SYNTHETIC.replace('main-before', 'main-after')).not.toBe(SYNTHETIC);
    expect(after).toBe(before);
  });

  it('adding a whole new function elsewhere does not change the digest', () => {
    const before = seedProcedureDigest(SYNTHETIC);
    const mutated = `${SYNTHETIC}\nfunction addedLater(): number {\n  return 42;\n}\n`;
    expect(seedProcedureDigest(mutated)).toBe(before);
  });
});

describe('the extraction throws rather than returning something wrong', () => {
  it('throws when the marker is absent', () => {
    // The dangerous failure is a silent fallback to hashing nothing. `indexOf`
    // returning -1 would slice from the end of the string and yield '' — a
    // perfectly stable digest over no content.
    expect(() => extractSeedCorpusBody('const x = 1;\n')).toThrow(
      /could not locate the seedCorpus\(\) marker/,
    );
  });

  it('throws when the braces never balance', () => {
    // Cut INSIDE seedCorpus()'s body, not merely before main(): truncating at
    // main() leaves seedCorpus fully closed and balanced, so it proves nothing.
    // (First version of this test did exactly that and passed vacuously.)
    const truncated = SYNTHETIC.slice(0, SYNTHETIC.indexOf('  for (const e'));
    expect(truncated).toContain(SEED_PROCEDURE_MARKER);
    expect(() => extractSeedCorpusBody(truncated)).toThrow(
      /unbalanced braces/,
    );
  });

  it('throws a DISTINCT error when the marker is present but no brace follows', () => {
    // `indexOf('{')` returning -1 would make the scan loop start at index -1
    // and fall through to a slice from -1 — another silent wrong answer.
    //
    // Asserting the distinct wording is the whole point. Both arms previously
    // threw 'unbalanced braces', so deleting the guard let the loop produce the
    // same message and this test passed with the guard GONE — verified vacuous
    // by mutation, 2026-09-18, and caught by review rather than by the suite.
    expect(() => extractSeedCorpusBody(`${SEED_PROCEDURE_MARKER}`)).toThrow(
      /no opening brace after the seedCorpus\(\) marker/,
    );
  });
});

describe('a digest mismatch is a hard stop (point 1)', () => {
  it('assertDigestMatches throws, naming both digests', () => {
    expect(() => assertDigestMatches('recorded-abc', 'current-xyz')).toThrow(
      /fixture\/baseline mismatch/,
    );
    // The operator has to be able to tell WHICH side moved; an error that just
    // says "mismatch" invites re-recording without reading the diff, which is
    // the exact reflex this guard exists to prevent.
    expect(() => assertDigestMatches('recorded-abc', 'current-xyz')).toThrow(/recorded-abc/);
    expect(() => assertDigestMatches('recorded-abc', 'current-xyz')).toThrow(/current-xyz/);
  });

  it('passes silently when the digests agree', () => {
    expect(() => assertDigestMatches('same', 'same')).not.toThrow();
  });

  it.skipIf(!HAS_CORPUS)(`the CLI exits 1 on a mismatch, without reaching the database ${HAS_CORPUS ? '' : NO_CORPUS}`, () => {
    // End-to-end on purpose: the unit assertions above cannot see whether
    // main() actually calls this, nor whether a throw becomes exit 1.
    //
    // It needs no Postgres because the check now runs BEFORE
    // assertSafeToTruncate/seedCorpus. That is the property being pinned as
    // much as the exit code: if the check drifts back below the seeding calls,
    // this test fails on a connection error instead of exiting on the mismatch.
    const { status, output } = runGuard({
      recordedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'deadbee',
      alpha: 0.2,
      limit: 20,
      corpusDigest: 'deliberately-not-the-current-digest',
      queries: [],
    });
    expect(status).toBe(1);
    expect(output).toMatch(/fixture\/baseline mismatch/);
    expect(output).toMatch(/deliberately-not-the-current-digest/);
    // Proof it failed on the digest rather than on the unreachable database.
    expect(output).not.toMatch(/ECONNREFUSED|ENOTFOUND|password authentication/);
  });
});

/**
 * Everything above tests the digest MECHANISM. These test its WIRING, which is
 * a different thing and was entirely unpinned: `main()` composes
 * `corpusDigest(corpus) + ':' + seedProcedureDigest(selfSource())`, and both
 * halves could be deleted from that expression with the whole suite still
 * green. Dropping the seed half reinstates percentile tiering's exact vacuity — the seeder
 * changes freely and no mismatch ever fires — which is the thing the digest pin exists to
 * prevent. Found by review, not by the suite.
 *
 * The technique: rebuild the digest main() SHOULD compute from the real inputs,
 * hand it back as the recorded baseline, and assert the CLI does NOT report a
 * mismatch. Then perturb exactly one half and assert it does.
 */
describe.skipIf(!HAS_CORPUS)(`the production digest expression is what it claims to be ${HAS_CORPUS ? '' : NO_CORPUS}`, () => {
  const baselineWith = (digest: string) => ({
    recordedAt: '2026-01-01T00:00:00.000Z',
    sourceCommit: 'deadbee',
    alpha: 0.2,
    limit: 20,
    corpusDigest: digest,
    queries: [],
  });

  it('agrees with corpusDigest(fixture) + seedProcedureDigest(REAL ranking-guard.ts)', () => {
    const { output } = runGuard(baselineWith(expectedDigest()));
    // It proceeds past the check and dies on the unreachable database — which
    // is itself the proof that the digest matched.
    expect(output).not.toMatch(/fixture\/baseline mismatch/);
    // …and positively: it REACHED assertSafeToTruncate. Without this, any crash
    // before the digest check would satisfy the assertion above — the one test
    // in this block that could otherwise pass for the wrong reason.
    expect(output).toMatch(/FROM public\.entities/);
  });

  it('mismatches when ONLY the seed-procedure half is perturbed', () => {
    // Pins that seedProcedureDigest(selfSource()) is actually in the
    // expression, and that selfSource() reads the REAL ranking-guard.ts:
    // pointing it at any other file makes this digest disagree.
    const mutatedSource = readRankingGuardSource().replace(
      'TRUNCATE public.memory_relations',
      'TRUNCATE public.memory_relations /* perturbed */',
    );
    expect(mutatedSource).not.toBe(readRankingGuardSource());
    const digest = `${corpusDigest(readGoldenCorpus())}:${seedProcedureDigest(mutatedSource)}`;
    const { status, output } = runGuard(baselineWith(digest));
    expect(status).toBe(1);
    expect(output).toMatch(/fixture\/baseline mismatch/);
  });

  it('mismatches when ONLY the fixture half is perturbed', () => {
    const digest = `deadbeefdeadbeef:${seedProcedureDigest(readRankingGuardSource())}`;
    const { status, output } = runGuard(baselineWith(digest));
    expect(status).toBe(1);
    expect(output).toMatch(/fixture\/baseline mismatch/);
  });
});

describe('malformed --baseline and baseline files refuse rather than fall back', () => {
  // Each of these was a silent data-loss path under --update-baseline.
  it('rejects --baseline with no value', () => {
    expect(() => resolveBaselinePath(['--baseline'])).toThrow(/requires a path/);
  });

  it('rejects --baseline followed by another flag', () => {
    expect(() => resolveBaselinePath(['--baseline', '--force'])).toThrow(/requires a path/);
  });

  it('honours the --baseline=<path> form instead of silently ignoring it', () => {
    // indexOf('--baseline') misses this spelling entirely, so it fell back to
    // the TRACKED fixture — which --update-baseline would then overwrite.
    expect(resolveBaselinePath(['--baseline=/tmp/x.json'])).toBe(resolve('/tmp/x.json'));
    expect(() => resolveBaselinePath(['--baseline='])).toThrow(/requires a path/);
    // Both spellings reject a flag-shaped value, not just the space form.
    expect(() => resolveBaselinePath(['--baseline=--force'])).toThrow(/requires a path/);
  });

  it('falls back to the tracked fixture only when no flag is present', () => {
    expect(resolveBaselinePath(['--force'], '/default.json')).toBe('/default.json');
  });

  it('refuses a baseline file containing JSON null', () => {
    // main() branches the RE-RECORD path on `baseline === null`, so a file
    // containing `null` would skip the digest check, truncate, and overwrite
    // itself at exit 0.
    expect(() => parseBaseline('null')).toThrow(/not a JSON object/);
    expect(() => parseBaseline('[]')).toThrow(/not a JSON object/);
    expect(() => parseBaseline('42')).toThrow(/not a JSON object/);
    expect(parseBaseline('{"alpha":0.2}')).toEqual({ alpha: 0.2 });
  });
});
