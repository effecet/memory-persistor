/**
 * The ranking guard and the scoring benchmark run against a golden corpus
 * snapshotted from a real memory database. This repository does not ship one
 * (it would publish someone's memories), so without it both scripts must say
 * so and exit 0 instead of crashing on ENOENT. They must also get there
 * without touching a database.
 *
 * Only meaningful when the fixtures are absent; a checkout that snapshotted its
 * own corpus (README § Ranking guard) skips this file.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO, 'tests', 'fixtures');
const NO_CORPUS = !existsSync(join(FIXTURES, 'golden-corpus.json'));
const NO_QUERIES = !existsSync(join(FIXTURES, 'golden-queries.json'));

function run(script: string): { status: number | null; stdout: string; stderr: string } {
  const emptyEnv = join(mkdtempSync(join(tmpdir(), 'mp-guard-absent-')), 'empty.env');
  writeFileSync(emptyEnv, '');
  const loader = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const r = spawnSync(process.execPath, ['--import', loader, join(REPO, 'scripts', script)], {
    cwd: REPO,
    // Unreachable on purpose: reaching for the database before the skip would fail.
    env: { ...process.env, DOTENV_CONFIG_PATH: emptyEnv, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none' },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('without golden fixtures (none ship with this repo)', () => {
  it.skipIf(!NO_CORPUS)('ranking-guard exits 0 with a skip line when the corpus is absent', () => {
    const r = run('ranking-guard.ts');
    expect(r.stderr).not.toMatch(/ENOENT/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('golden corpus not present — skipping (see README § Ranking guard)');
  });

  it.skipIf(!NO_QUERIES)('score-benchmark exits 0 with a skip line when the queries are absent', () => {
    const r = run('score-benchmark.ts');
    expect(r.stderr).not.toMatch(/ENOENT/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('golden queries not present — skipping (see README § Ranking guard)');
  });
});
