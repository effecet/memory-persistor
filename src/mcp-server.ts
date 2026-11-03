/**
 * MCP Server entry point for memory-persistor: process startup only.
 * Tool registration lives in src/mcp-tools.ts (createServer / registerTools)
 * so handlers are importable and testable without starting a server.
 *
 * Note: env loading is handled exclusively by src/db.ts via an explicit
 * dotenv.config({ path, override: true }). Do NOT re-introduce
 * `import 'dotenv/config'` here — it ran before db.ts and shadowed
 * DOTENV_CONFIG_PATH, silently routing all writes to local Docker
 * for 6+ days (observed 2026-04-07 → 2026-04-13).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { sql } from 'drizzle-orm';
import { db, closeDb } from './db.js';
import { warmEmbed } from './embed.js';
import { createServer } from './mcp-tools.js';

const server = createServer();

// ── Start server ───────────────────────────────────────────────────────────

async function main() {
  // Verify database connectivity before accepting tool calls
  await db.execute(sql`SELECT 1`);

  // Fire-and-forget: warmEmbed() runs unconditionally (every machine embeds
  // recall queries regardless of EMBED_ON_WRITE_ENABLED) and is already
  // non-fatal internally; boot must not block on the ~1-2s first model load.
  warmEmbed();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Graceful shutdown — drain the connection pool
async function shutdown() {
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((error) => {
  console.error('[memory-persistor] Fatal error:', error);
  process.exit(1);
});
