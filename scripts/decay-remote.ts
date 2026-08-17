/**
 * CLI wrapper for a manual thermal decay pass. Exists because the `npx tsx -e`
 * CLI form specifically transpiles its eval string to CJS, where top-level
 * await is a hard error — so the old inline `make decay-remote` one-liner
 * could never run. (The `node --import .../tsx/dist/loader.mjs
 * --input-type=module -e` idiom used by cron-status-remote/cron-verify does
 * NOT have this problem; a file just reads better at this size.)
 *
 * The script itself is env-agnostic — DOTENV_CONFIG_PATH picks the target
 * (the Makefile target pins .env.supabase):
 *   DOTENV_CONFIG_PATH=.env.supabase npx tsx scripts/decay-remote.ts
 *
 * Runs the same versioned decay the nightly pg_cron job calls
 * (drizzle/0010_thermal_decay_function.sql) plus the file-sync half that
 * only a machine with the memory dirs can do — see decayAll() in
 * src/thermal.ts.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decayAll } from '../src/thermal.js';
import { closeDb } from '../src/db.js';

async function main(): Promise<void> {
  const result = await decayAll();
  console.log(`Decayed ${result.count} entities, synced ${result.synced}`);
  if (result.synced < result.count) {
    // Non-fatal by design (Postgres is the source of truth; thermal.ts swallows
    // syncToFile errors), but don't let a file-sync failure pass silently.
    console.warn(`[decay-remote] warning: only ${result.synced}/${result.count} decayed entities synced to markdown`);
  }
  await closeDb();
  process.exit(0);
}

/**
 * True when this module is the process entry point (not a test import).
 * pathToFileURL does NOT resolve symlinks but the ESM loader does, so argv[1]
 * must be realpath'd first or a symlinked invocation silently no-ops with
 * exit 0. argv[1] is undefined under `node --eval` / REPL imports, and
 * realpathSync throws on virtual entries — both mean "imported".
 */
function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
