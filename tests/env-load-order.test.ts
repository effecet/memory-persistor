/**
 * Anything src/db.ts imports is evaluated BEFORE its own dotenv.config().
 *
 * ESM evaluates a module's imports before any statement in its body, so an
 * import that reads process.env at module scope reads an UNLOADED environment.
 * src/config.ts does exactly that (EMBED_ON_WRITE_ENABLED, CLAUDE_DIR,
 * MEMORY_PERSISTOR_DIR).
 *
 * Measured 2026-09-06, while adding the search_path pin: importing
 * SEARCH_PATH_OPTIONS from config.js into db.ts left
 * `MEMORY_EMBED_ENABLED="true"` in the environment while
 * `EMBED_ON_WRITE_ENABLED === false` — every remember/update/merge would store
 * a NULL embedding, silently, with no error and no failing test. The constant
 * now lives in the leaf module src/search-path.ts.
 *
 * This runs in a CHILD PROCESS on purpose: module evaluation order is a
 * one-shot, process-wide property, and vitest has already imported half the
 * tree by the time a test body runs.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');

describe('db.ts import graph vs dotenv order', () => {
  it('config.ts still sees env vars loaded by db.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-order-'));
    const envFile = join(dir, 'probe.env');
    // A local URL: db.ts builds a Pool from it but never connects at import.
    writeFileSync(
      envFile,
      'DATABASE_URL=postgresql://localhost:5432/memory_persistor\nMEMORY_EMBED_ENABLED=true\n',
    );

    const out = execFileSync(
      process.execPath,
      [
        '--import',
        `file://${join(repoRoot, 'node_modules/tsx/dist/loader.mjs')}`,
        join(repoRoot, 'tests/fixtures/env-load-order-probe.ts'),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        // Strip any inherited value so the .env file is the only source.
        env: { ...process.env, DOTENV_CONFIG_PATH: envFile, MEMORY_EMBED_ENABLED: '' },
      },
    );

    const result = JSON.parse(out.trim().split('\n').pop()!) as {
      envVar: string | null;
      embedOnWrite: boolean;
    };

    // Guard against a vacuous pass: if the env var never loaded at all, the
    // assertion below would be meaningless rather than wrong.
    expect(result.envVar).toBe('true');
    expect(result.embedOnWrite).toBe(true);
  });
});
