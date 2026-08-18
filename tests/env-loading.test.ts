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

  it('db.ts must route console.log away from stdout around dotenv.config', () => {
    // `quiet: true` alone is NOT sufficient. dotenv resolves quiet as
    //   processEnv.DOTENV_CONFIG_QUIET || options.quiet
    // at lib/main.js:248, and RE-READS it after populate at :292 — so the env
    // var wins over the code option, and parseBoolean('false') === false. A
    // DOTENV_CONFIG_QUIET=false in the shell OR inside the .env file itself
    // puts the banner back on stdout, which is the MCP JSON-RPC transport.
    // The console.log swap makes that unreachable regardless of resolution.
    const src = readFileSync(join(repoRoot, 'src/db.ts'), 'utf8');
    expect(src).toMatch(/console\.log\s*=/);
  });

  it('the console.log swap survives DOTENV_CONFIG_QUIET=false', () => {
    // Behavioural proof of the technique, independent of db.ts. Guards against
    // a future dotenv release changing how quiet resolves.
    const tmp = mkdtempSync(join(tmpdir(), 'env-quiet-'));
    const envFile = join(tmp, 'noisy.env');
    writeFileSync(envFile, 'QUIET_PROBE=1\n');

    const prevVar = process.env.DOTENV_CONFIG_QUIET;
    process.env.DOTENV_CONFIG_QUIET = 'false'; // hostile: defeats { quiet: true }

    const realLog = console.log;
    const stdoutLines: string[] = [];
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.join(' '));
    };
    let banner: string[] = [];
    try {
      // Confirm the hostile env var really does re-enable logging...
      dotenv.config({ path: envFile, override: true, quiet: true });
      banner = [...stdoutLines];
    } finally {
      console.log = realLog;
      if (prevVar === undefined) delete process.env.DOTENV_CONFIG_QUIET;
      else process.env.DOTENV_CONFIG_QUIET = prevVar;
    }

    // ...so the swap is load-bearing, not redundant. If this ever goes empty,
    // dotenv changed its precedence and the swap may no longer be needed —
    // verify before removing it.
    expect(banner.length).toBeGreaterThan(0);
    expect(banner.join('\n')).toMatch(/injected env/i);
  });

  it('db.ts must pass { quiet: true } — stdout is the MCP transport', () => {
    // dotenv defaults quiet:false since 17.0.0 and logs its injection banner
    // with console.log — i.e. onto stdout, which for the MCP server IS the
    // JSON-RPC transport. A client that does not skip unparseable lines sees
    // a corrupt stream and registers no tools, with no error to read.
    const src = readFileSync(join(repoRoot, 'src/db.ts'), 'utf8');
    expect(src).toMatch(/dotenv\.config\([^)]*quiet:\s*true/);
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
