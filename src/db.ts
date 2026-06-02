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
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH, override: true });
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

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

const pool = new Pool({
  connectionString: buildConnectionString(),
});

export const db = drizzle(pool, { schema });

export async function closeDb(): Promise<void> {
  await pool.end();
}
