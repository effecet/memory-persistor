/**
 * Regression guard: DOTENV_CONFIG_PATH must win over any earlier .env load.
 *
 * Bug history (2026-04-07 → 2026-04-13): mcp-server.ts had
 * `import 'dotenv/config'` before `import { db } from './db.js'`. dotenv's
 * default mode doesn't override already-set vars, so DATABASE_URL from
 * ./.env (local Docker) shadowed the explicit .env.supabase path and six
 * days of events writes silently landed on the wrong DB.
 *
 * This suite enforces two structural invariants of the fix:
 *   1. src/mcp-server.ts does NOT contain `import 'dotenv/config'`.
 *   2. src/db.ts calls dotenv.config with { path, override: true }.
 *
 * It also exercises dotenv directly to confirm the `override: true` semantics
 * we depend on (defence against a future dotenv upgrade that silently
 * changes the default).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dotenv from 'dotenv';

const repoRoot = resolve(__dirname, '..');

describe('env loading invariants', () => {
  it('mcp-server.ts must not import dotenv/config (lets db.ts own env loading)', () => {
    const src = readFileSync(join(repoRoot, 'src/mcp-server.ts'), 'utf8');
    // Match actual import statement at line start — ignore docblock references.
    expect(src).not.toMatch(/^\s*import\s+['"]dotenv\/config['"]/m);
  });

  it('db.ts must pass { override: true } to dotenv.config', () => {
    const src = readFileSync(join(repoRoot, 'src/db.ts'), 'utf8');
    expect(src).toMatch(/dotenv\.config\([^)]*override:\s*true/);
  });

  it('dotenv { override: true } overrides a pre-set env var', () => {
    // Guard against dotenv upgrade silently changing override semantics.
    const tmp = mkdtempSync(join(tmpdir(), 'env-test-'));
    const envFile = join(tmp, 'custom.env');
    writeFileSync(envFile, 'DB_URL_PROBE=wins\n');

    process.env.DB_URL_PROBE = 'loses';
    dotenv.config({ path: envFile, override: true });
    try {
      expect(process.env.DB_URL_PROBE).toBe('wins');
    } finally {
      delete process.env.DB_URL_PROBE;
    }
  });

  it('dotenv without override does NOT overwrite — proves the bug we fixed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'env-test-'));
    const envFile = join(tmp, 'custom.env');
    writeFileSync(envFile, 'DB_URL_PROBE2=wins\n');

    process.env.DB_URL_PROBE2 = 'loses';
    dotenv.config({ path: envFile });
    try {
      expect(process.env.DB_URL_PROBE2).toBe('loses');
    } finally {
      delete process.env.DB_URL_PROBE2;
    }
  });
});
