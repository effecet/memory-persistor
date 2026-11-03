/**
 * Probe for tests/env-load-order.test.ts — run as a CHILD PROCESS.
 *
 * Imports the REAL tool module rather than mirroring its import order: if
 * src/mcp-tools.ts ever imports config.ts (directly or transitively) before
 * ./db.js, config's module-scope env reads run before dotenv and this probe
 * reports embedOnWrite=false. (src/mcp-server.ts cannot be imported — it
 * starts the server — but its first project import is ./db.js, and it reaches
 * config only through mcp-tools.)
 */
import '../../src/mcp-tools.js';
import { EMBED_ON_WRITE_ENABLED } from '../../src/config.js';

console.log(
  JSON.stringify({
    envVar: process.env.MEMORY_EMBED_ENABLED ?? null,
    embedOnWrite: EMBED_ON_WRITE_ENABLED,
  }),
);
process.exit(0);
