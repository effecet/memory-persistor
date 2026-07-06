/**
 * One-time backfill: compute embeddings for all existing memories that don't
 * have one yet. Scans `entities WHERE embedding IS NULL`,
 * embeds `name + observations` (same text the write path uses), and writes the
 * 384-d vector back. Idempotent + resumable: the NULL filter means a crashed or
 * interrupted run picks up exactly where it left off — already-embedded rows are
 * never re-embedded. Hits the shared DB, so one run backfills the whole fleet.
 *
 * Usage:
 *   npx tsx scripts/backfill-embeddings.ts --dry-run   # count only, no writes
 *   npx tsx scripts/backfill-embeddings.ts             # embed + write
 *
 * Unlike the write path (embedForWrite), this calls embed() directly and is NOT
 * gated by EMBED_ON_WRITE_ENABLED — a backfill is a deliberate operator action
 * run from a primary machine that has the model. embedForWrite would return
 * null on a write-disabled machine and silently write embedding=NULL (reporting
 * "embedded" while storing nothing); embed() instead surfaces a model failure
 * loudly (the pre-loop probe aborts, or a per-row throw increments `failed`).
 * Delete this file after the fleet is backfilled.
 */
import { pathToFileURL } from 'node:url';
import { and, isNull, inArray, eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db.js';
import { entities } from '../src/schema.js';
import { embed, embedText } from '../src/embed.js';

export interface BackfillOptions {
  /** Count rows in scope but perform no embedding or writes. */
  dryRun?: boolean;
  /** Progress is logged once per this many processed rows (default 25). */
  logEvery?: number;
  /**
   * Restrict the backfill to these entity ids (still only touches the ones
   * whose embedding IS NULL). Omit for the normal fleet-wide run (every
   * NULL-embedding row). Not wired to a CLI flag — it exists to scope the
   * function programmatically (and to keep tests hermetic against the shared
   * dev DB's other un-embedded rows).
   */
  onlyIds?: string[];
}

export interface BackfillResult {
  /** NULL-embedding rows found in scope. */
  total: number;
  /** Rows successfully embedded and written (0 on a dry run). */
  embedded: number;
  /** Rows whose embed() call threw — left NULL, safe to re-run. */
  failed: number;
}

interface Row {
  id: string;
  name: string;
  observations: string | null;
}

/**
 * Backfill embeddings for NULL-embedding entities. Returns counts; never throws
 * on a per-row embed failure (those increment `failed` and leave the row NULL).
 */
export async function backfillEmbeddings(options: BackfillOptions = {}): Promise<BackfillResult> {
  const { dryRun = false, logEvery = 25, onlyIds } = options;

  if (onlyIds && onlyIds.length === 0) {
    return { total: 0, embedded: 0, failed: 0 };
  }

  const nullFilter = isNull(entities.embedding);
  const rows = (await db
    .select({ id: entities.id, name: entities.name, observations: entities.observations })
    .from(entities)
    .where(onlyIds ? and(nullFilter, inArray(entities.id, onlyIds)) : nullFilter)
    .orderBy(entities.createdAt)) as Row[];

  const total = rows.length;
  console.log(`Found ${total} row(s) with NULL embedding${dryRun ? ' (dry run — no writes)' : ''}`);

  if (dryRun || total === 0) {
    return { total, embedded: 0, failed: 0 };
  }

  // Fail fast: probe the model once before the loop. If it can't load at all,
  // abort before wasting one load attempt per row (getExtractor resets its
  // cached promise on rejection, so a dead model would otherwise re-attempt the
  // load N times). A successful probe also warms the singleton so the first
  // real row is fast. Returns failed=total (non-zero exit) rather than throwing,
  // keeping the "never throws, always returns counts" contract.
  try {
    await embed('warmup');
  } catch (err) {
    console.error(`  [error] embedding model unavailable — aborting, ${total} row(s) left NULL: ${err}`);
    return { total, embedded: 0, failed: total };
  }

  let embedded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const vec = await embed(embedText(row.name, row.observations));
      await db.update(entities).set({ embedding: vec }).where(eq(entities.id, row.id));
      embedded++;
    } catch (err) {
      // Covers both an embed() throw and an UPDATE failure — either way the row
      // stays NULL and is safe to pick up on a re-run.
      failed++;
      console.warn(`  [warn] embed/write failed for "${row.name}" (${row.id}), left NULL: ${err}`);
    }

    if ((embedded + failed) % logEvery === 0) {
      console.log(`  …${embedded + failed}/${total} processed (${embedded} embedded, ${failed} failed)`);
    }
  }

  console.log(`Done: ${embedded} embedded, ${failed} failed, ${total} in scope`);
  return { total, embedded, failed };
}

/** CLI entry point — not run when this module is imported (e.g. by tests). */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const result = await backfillEmbeddings({ dryRun });
  await closeDb();
  // Non-zero exit if any row failed to embed, so a CI/operator run surfaces it.
  process.exit(result.failed > 0 ? 1 : 0);
}

// Only run the CLI when invoked directly, not when imported by a test.
// pathToFileURL handles percent-encoding + symlink realpath so a repo path with
// spaces or a symlinked checkout doesn't make this comparison silently false
// (which would exit 0 having embedded nothing).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
