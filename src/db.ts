/**
 * Database connection setup using Drizzle ORM + pg.
 */
import * as dotenv from 'dotenv';
// Respect DOTENV_CONFIG_PATH so the MCP server can be pointed at .env.supabase
// (primary) vs .env (local Docker fallback) via ~/.claude/.mcp.json.
// `override: true` is load-bearing — if any entry point (or its transitive
// imports) already called `import 'dotenv/config'`, DATABASE_URL from ./.env
// would otherwise shadow the explicit path here, silently routing all writes
// to local Docker. Observed 2026-04-07 → 2026-04-13 (6 days of events drift).
//
// `quiet: true` is equally load-bearing: dotenv defaults it to FALSE since
// 17.0.0 and prints its injection banner via console.log — onto stdout, which
// for the MCP server is the JSON-RPC transport itself. The banner lands ahead
// of the initialize reply; clients that skip unparseable lines tolerate it,
// clients that don't see a corrupt stream and register zero tools with no
// error to read.
//
// The console.log swap is NOT belt-and-braces — `quiet: true` alone is
// defeatable. dotenv resolves it as
//     processEnv.DOTENV_CONFIG_QUIET || options.quiet          (lib/main.js:248)
// and RE-READS it from processEnv after populate                (lib/main.js:292),
// so the environment variable outranks the code option, and parseBoolean('false')
// is false. A stray DOTENV_CONFIG_QUIET=false — in the shell, in the MCP server's
// env block, or inside the .env file this very call is loading — silently puts the
// banner back on stdout. Routing console.log to stderr for the duration makes that
// unreachable however `quiet` resolves, and also catches anything else that decides
// to log during env loading. Restored in `finally` so nothing leaks past this line.
const __realLog = console.log;
console.log = (...args: unknown[]) => console.error(...args);
try {
  dotenv.config({ path: process.env.DOTENV_CONFIG_PATH, override: true, quiet: true });
} finally {
  console.log = __realLog;
}
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
// Deliberately NOT from './config.js' — config reads process.env at module
// scope, and ESM evaluates this import BEFORE the dotenv.config() above, which
// silently flips EMBED_ON_WRITE_ENABLED to false. See src/search-path.ts.
import { SEARCH_PATH_OPTIONS } from './search-path.js';

const { Pool } = pg;

const isRemote = !process.env.DATABASE_URL?.includes('localhost');

// pg 8.20+ treats sslmode=require as verify-full by default.
// Use uselibpqcompat=true for standard libpq behavior (encrypt without cert verification).
//
// If the caller explicitly set sslmode in the URL (e.g. sslmode=disable for a
// no-SSL Postgres service container in CI, or sslmode=require with their own
// tuning), respect it rather than clobbering. This matters for integration
// tests against the ephemeral postgres:17 service container which doesn't
// serve SSL — without this check, db.ts would force sslmode=require and every
// query would fail with "The server does not support SSL connections".
function buildConnectionString(): string {
  const base = process.env.DATABASE_URL ?? '';
  if (!isRemote) return base;
  if (/[?&]sslmode=/.test(base)) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}sslmode=require&uselibpqcompat=true`;
}

// `search_path` is pinned, NOT left to the server's defaults — without it every
// recall against Supabase aborts with `42883 function word_similarity(...) does
// not exist`, because Supavisor's pooled backends do not inherit the postgres
// role's search_path and pg_trgm lives in the `extensions` schema there.
// SEARCH_PATH_OPTIONS carries the full rationale, including why this
// deliberately short-circuits PGOPTIONS.
//
// An `options=` inside DATABASE_URL DOES still beat the code value: pg does
// `Object.assign({}, config, parse(connectionString))`, so the URL wins. That
// path silently restores the exact 42883 failure this fix exists to remove, so
// it is announced rather than left to be rediscovered from a wall of SQL.
// stderr, never stdout — stdout is the MCP's JSON-RPC transport.
if (/[?&]options=/.test(process.env.DATABASE_URL ?? '')) {
  console.error(
    '[db] WARNING: DATABASE_URL carries its own `options=`, which overrides ' +
      `${SEARCH_PATH_OPTIONS}. If it omits the \`extensions\` schema, every ` +
      'recall against Supabase will fail with 42883 (word_similarity not found).',
  );
}

const pool = new Pool({
  connectionString: buildConnectionString(),
  options: SEARCH_PATH_OPTIONS,
});

export const db = drizzle(pool, { schema });

export async function closeDb(): Promise<void> {
  await pool.end();
}
