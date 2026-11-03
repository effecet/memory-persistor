/**
 * Ranking-regression guard. Seeds the frozen corpus, scores the golden
 * queries, and fails when a rank moves the wrong way against the baseline.
 *
 *   npx tsx scripts/ranking-guard.ts                  # compare, exit 1 on regression
 *   npx tsx scripts/ranking-guard.ts --update-baseline
 *   npx tsx scripts/ranking-guard.ts --baseline <path>   # compare against another file
 *
 * THIS IS A REGRESSION GUARD, NOT A QUALITY BAR. It answers "did this change
 * move ranking against a fixed reference". It says nothing about whether
 * retrieval is good, and it is NOT outage detection — brain_canary.py's
 * recall_surface check owns that, because an environmental failure like
 * the 2026-09-06 Supavisor search_path leak opens no PR and is structurally
 * unreproducible against a fresh local Postgres.
 *
 * ⚠️ IT TRUNCATES `entities` AND `memory_relations`. Guarded three ways: the
 * table must already be empty, the DSN must not look like the production
 * pooler, and --force is required to override the first. Losing the real brain
 * to a benchmark would be an absurd way to lose it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { db } from '../src/db.js';
import { PRIOR_ALPHA } from '../src/config.js';
import { loadGoldenQueries, scoreQuery, type GoldenQuery } from './score-benchmark.js';
import {
  corpusDigest,
  compareToBaseline,
  seedProcedureDigest,
  assertDigestMatches,
  timestampForOffset,
  type Baseline,
  type BaselineQuery,
  type GoldenCorpus,
} from './golden-corpus.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This script's own source text — the material seedProcedureDigest() hashes. */
const selfSource = (): string => readFileSync(fileURLToPath(import.meta.url), 'utf-8');
const FIXTURES = resolve(HERE, '..', 'tests', 'fixtures');
const CORPUS_PATH = resolve(FIXTURES, 'golden-corpus.json');
const DEFAULT_BASELINE_PATH = resolve(FIXTURES, 'golden-baseline.json');
const LIMIT = 20;

/** Stamped on every seeded row; the re-run safety check keys on it. */
const SEED_SOURCE = 'golden-corpus';

/** See scripts/snapshot-golden-corpus.ts — drizzle flattens JS arrays. */
const pgTextArray = (vals: string[]) =>
  sql`ARRAY[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::text[]`;

/** Hosts that must never be truncated, however the flags are set. */
const FORBIDDEN_DSN_MARKERS = ['pooler.supabase.com', 'supabase.co'];

export function rolesFor(
  golden: GoldenQuery[],
): Record<string, Record<string, 'expect_top' | 'expect_not_top'>> {
  const roles: Record<string, Record<string, 'expect_top' | 'expect_not_top'>> = {};
  for (const g of golden) {
    roles[g.query] = {};
    for (const n of g.expect_top) roles[g.query][n] = 'expect_top';
    for (const n of g.expect_not_top) roles[g.query][n] = 'expect_not_top';
  }
  return roles;
}

/** 1-based rank of each interesting name, or null when outside the top-N. */
export function ranksFrom(rankedNames: string[], interesting: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const name of interesting) {
    const i = rankedNames.indexOf(name);
    out[name] = i === -1 ? null : i + 1;
  }
  return out;
}

function loadCorpus(): GoldenCorpus {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf-8')) as GoldenCorpus;
}

async function assertSafeToTruncate(force: boolean): Promise<void> {
  const dsn = process.env.DATABASE_URL ?? '';
  for (const marker of FORBIDDEN_DSN_MARKERS) {
    if (dsn.includes(marker)) {
      throw new Error(
        `refusing to run: DATABASE_URL points at ${marker}. This script truncates ` +
          `entities and memory_relations. Point it at a scratch database.`,
      );
    }
  }
  // Refuse on FOREIGN rows, not on any rows. The seeder stamps every row it
  // writes with source='golden-corpus', so a database holding only those is a
  // scratch database being re-run — the normal case while iterating, and
  // blocking it made the guard unusable locally after its first run. A single
  // row from anywhere else means this is somebody's real corpus.
  const counted = await db.execute(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE source IS DISTINCT FROM ${SEED_SOURCE})::int AS foreign_rows
    FROM public.entities
  `);
  const { total, foreign_rows: foreignRows } = (
    counted.rows as { total: number; foreign_rows: number }[]
  )[0];
  if (Number(foreignRows) > 0 && !force) {
    throw new Error(
      `refusing to run: public.entities holds ${foreignRows} row(s) not written ` +
        `by this script (${total} total). It truncates the table. Point ` +
        `DATABASE_URL at a scratch database, or pass --force if you are certain.`,
    );
  }
}

/**
 * Seed the fixture. Timestamps are rebuilt from day-offsets relative to NOW(),
 * because RECENCY_EXPR reads NOW() - last_accessed_at: absolute timestamps
 * would make the recency signal — and therefore the baseline — drift with the
 * calendar rather than with the code.
 */
export async function seedCorpus(corpus: GoldenCorpus, seedNow = new Date()): Promise<void> {
  await db.execute(sql`TRUNCATE public.memory_relations, public.entities CASCADE`);

  for (const e of corpus.entities) {
    const lastAccessed =
      e.lastAccessedDaysAgo === null ? null : timestampForOffset(e.lastAccessedDaysAgo, seedNow);
    const created = timestampForOffset(e.createdDaysAgo, seedNow);
    const embedding = e.embedding === null ? null : JSON.stringify(e.embedding);
    await db.execute(sql`
      INSERT INTO public.entities
        (id, name, type, observations, tags, source, importance, temperature, tier,
         access_count, last_accessed_at, created_at, embedding)
      VALUES (
        ${e.id}::uuid, ${e.name}, ${e.entityType}, ${e.observations}, ${pgTextArray(e.tags)},
        ${SEED_SOURCE}, ${e.importance}, ${e.temperature}, ${e.tier},
        ${e.accessCount}, ${lastAccessed}, ${created},
        ${embedding}::vector
      )
    `);
  }
  for (const r of corpus.relations) {
    await db.execute(sql`
      INSERT INTO public.memory_relations (from_id, to_id, relation_type, provenance)
      VALUES (${r.fromId}::uuid, ${r.toId}::uuid, ${r.relationType}, ${r.provenance ?? 'inferred'})
      ON CONFLICT DO NOTHING
    `);
  }

  // Populate temperature_rank so a guard reading actually exercises TEMPERATURE_EXPR's
  // temperature_rank branch. Deliberately NOT memory_thermal_decay(): that floors
  // temperatures and re-tiers every row, which would mutate the exact structural
  // properties this corpus was snapshotted to preserve (max degree, the HOT distractor
  // at temperature 1.0). cume_dist() OVER (ORDER BY temperature) is the same window
  // expression pass 2 of drizzle/0015_thermal_decay_floor_is_cold.sql computes, so this
  // stays faithful to production ranking without touching anything else about the
  // corpus. It MUST track that migration: pass 2 moved from percent_rank to cume_dist
  // (a tie takes the HIGHEST fraction, not the lowest), and the two differ in VALUE on
  // every corpus, tied or not — percent_rank is (k-1)/(N-1), cume_dist is k/N. Leaving
  // this on percent_rank would have the guard measure a prior production never produces.
  //
  // The POPULATION must track it too, not only the window function. Since the cold-pole fix
  // (drizzle/0015_thermal_decay_floor_is_cold.sql) pass 2 ranks only rows with
  // temperature > 0 and gives every floored row a rank of exactly 0; ranking
  // the whole table here would hand a dead row group/N where production hands
  // it 0 — the same "prior production never produces" failure as the
  // percent_rank case above, one level down. It is a no-op on today's fixture
  // (tests/fixtures/golden-corpus.json: 297 entities, none at or below 0,
  // min temperature 0.0129) and becomes load-bearing the moment
  // `make ranking-snapshot` pulls floored rows in from the production corpus.
  await db.execute(sql`
    WITH live AS (
      SELECT id, cume_dist() OVER (ORDER BY temperature) AS pr
      FROM public.entities
      WHERE temperature > 0
    )
    UPDATE public.entities e
    SET temperature_rank = COALESCE(live.pr, 0)
    FROM (SELECT id FROM public.entities) AS all_rows
    LEFT JOIN live ON live.id = all_rows.id
    WHERE e.id = all_rows.id
  `);
}

async function measure(golden: GoldenQuery[], corpus: GoldenCorpus): Promise<BaselineQuery[]> {
  const out: BaselineQuery[] = [];
  for (const g of golden) {
    const frozen = corpus.queryEmbeddings[g.query];
    if (!frozen) {
      // Recomputing here would silently reintroduce cross-platform float drift.
      throw new Error(
        `no frozen embedding for golden query ${JSON.stringify(g.query)}. ` +
          `Re-run scripts/snapshot-golden-corpus.ts after changing the golden set.`,
      );
    }
    const rows = await scoreQuery(g.query, PRIOR_ALPHA, {
      limit: LIMIT,
      frozenEmbedding: frozen,
    });
    out.push({
      query: g.query,
      ranks: ranksFrom(
        rows.map((r) => r.name),
        [...g.expect_top, ...g.expect_not_top],
      ),
    });
  }
  return out;
}

function currentCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: resolve(HERE, '..') }).toString().trim();
  } catch {
    return null;
  }
}

function renderTable(golden: GoldenQuery[], measured: BaselineQuery[], base: Baseline | null): void {
  const roles = rolesFor(golden);
  console.log('\n  query / name                                          role      base   now');
  console.log('  ' + '─'.repeat(78));
  for (const m of measured) {
    console.log(`  ${m.query.slice(0, 70)}`);
    const baseRanks = base?.queries.find((q) => q.query === m.query)?.ranks ?? {};
    for (const [name, rank] of Object.entries(m.ranks)) {
      const role = roles[m.query]?.[name] ?? '?';
      const b = name in baseRanks ? baseRanks[name] : undefined;
      const fmt = (v: number | null | undefined): string =>
        v === undefined ? '  —' : v === null ? 'OUT' : String(v).padStart(3);
      console.log(`    ${name.slice(0, 48).padEnd(50)} ${role.padEnd(9)} ${fmt(b)}   ${fmt(rank)}`);
    }
  }
}

/**
 * `--baseline <path>` or `--baseline=<path>`, defaulting to the tracked fixture.
 *
 * Every malformed spelling THROWS rather than falling back, because each silent
 * fallback here is a data-loss bug under `--update-baseline`:
 *   `--baseline=/tmp/x.json`  bare indexOf misses the `=` form entirely and
 *                             overwrites the TRACKED baseline while the
 *                             operator believes they wrote a throwaway;
 *   `--baseline --force`      consumes the next flag as the path and writes a
 *                             stray `<cwd>/--force`, leaving the real baseline
 *                             stale while the run prints success;
 *   `--baseline` (last arg)   resolve('') is the cwd — a writeFileSync against
 *                             a directory.
 * All three were live; found by review, not by the suite.
 */
export function resolveBaselinePath(argv: string[], fallback = DEFAULT_BASELINE_PATH): string {
  const inline = argv.find((a) => a.startsWith('--baseline='));
  if (inline !== undefined) {
    const value = inline.slice('--baseline='.length);
    // Same rejection as the space form below. The `=` spelling attaches its
    // value unambiguously, so `--baseline=--force` is not the accidental case
    // the space form guards against — but accepting it in one spelling and
    // refusing it in the other is the kind of asymmetry that gets discovered
    // by writing a junk file, so both are strict.
    if (value === '' || value.startsWith('--')) {
      throw new Error(`--baseline= requires a path, got ${value === '' ? 'nothing' : value}`);
    }
    return resolve(value);
  }
  const at = argv.indexOf('--baseline');
  if (at === -1) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--baseline requires a path, got ${value === undefined ? 'nothing' : value}`);
  }
  return resolve(value);
}

/**
 * Parse a recorded baseline, rejecting anything that is not an object.
 *
 * `JSON.parse('null')` is `null`, and main() branches the RE-RECORD path on
 * `baseline === null`. So a truncated or badly-merged baseline file containing
 * `null` would skip the digest check, truncate the database, and overwrite the
 * file with freshly measured ranks at exit 0 — turning a corrupt baseline into
 * a silent re-record. Throwing here keeps `baseline === null` equivalent to
 * "--update-baseline was passed", which is what lets main() branch on it.
 */
export function parseBaseline(text: string): Baseline {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `baseline file is not a JSON object (got ${parsed === null ? 'null' : typeof parsed}). ` +
        `Re-record it with --update-baseline.`,
    );
  }
  return parsed as Baseline;
}

async function main(): Promise<void> {
  // The corpus is a snapshot of a real memory database and is not shipped with
  // this repository. Without one there is nothing to guard; say so and pass.
  if (!existsSync(CORPUS_PATH)) {
    console.log('golden corpus not present — skipping (see README § Ranking guard)');
    return;
  }
  const argv = process.argv.slice(2);
  const update = argv.includes('--update-baseline');
  const force = argv.includes('--force');
  // `--baseline <path>` rather than an env var: an exported variable would
  // silently redirect the --update-baseline WRITE below to a throwaway file,
  // leaving the tracked baseline stale while the run prints success. A flag is
  // visible in CI logs and shell history, and reuses the argv parsing already
  // here instead of adding a second configuration mechanism.
  const baselinePath = resolveBaselinePath(argv);

  const corpus = loadCorpus();
  const golden = loadGoldenQueries();
  // Combined: fixture content + the procedure that turns it into database
  // rows. Either changing independently must invalidate the baseline — see
  // seedProcedureDigest()'s docstring (ruling R12, percentile tiering) for why the seeding
  // procedure is covered too, not just the fixture.
  const digest = `${corpusDigest(corpus)}:${seedProcedureDigest(selfSource())}`;

  // Read and verify the baseline BEFORE touching the database. A digest
  // mismatch is a hard stop, so checking it first means the guard refuses
  // without truncating and re-seeding — and the refusal is then observable
  // with no Postgres at all, which is what makes the exit code testable.
  const baseline = update ? null : parseBaseline(readFileSync(baselinePath, 'utf-8'));
  if (baseline !== null) {
    assertDigestMatches(baseline.corpusDigest, digest);
  }

  await assertSafeToTruncate(force);
  await seedCorpus(corpus);

  const measured = await measure(golden, corpus);

  // Branching on `baseline` rather than `update` is what lets TypeScript narrow
  // the tail of this function to a non-null Baseline. The two are equivalent
  // ONLY because parseBaseline() refuses to return null — without that, a
  // baseline file containing `null` would take this re-record path and
  // overwrite itself silently (found by review; see parseBaseline).
  if (baseline === null) {
    // Named `recorded`, not `baseline`: the outer `baseline` is the one read
    // from disk, and shadowing it here made the two impossible to tell apart.
    const recorded: Baseline = {
      recordedAt: new Date().toISOString(),
      sourceCommit: currentCommit(),
      alpha: PRIOR_ALPHA,
      limit: LIMIT,
      corpusDigest: digest,
      queries: measured,
    };
    writeFileSync(baselinePath, `${JSON.stringify(recorded, null, 2)}\n`);
    renderTable(golden, measured, null);
    console.log(`\nwrote ${baselinePath} (alpha ${PRIOR_ALPHA}, digest ${digest})`);
    return;
  }

  if (baseline.alpha !== PRIOR_ALPHA) {
    // Not fatal: changing alpha is exactly the kind of change worth measuring.
    console.log(
      `note: PRIOR_ALPHA is ${PRIOR_ALPHA}, baseline recorded at ${baseline.alpha} — ` +
        `rank movement below is expected and should be reviewed, not assumed safe.`,
    );
  }

  const result = compareToBaseline(baseline.queries, measured, rolesFor(golden));
  renderTable(golden, measured, baseline);

  console.log(
    `\n  unchanged ${result.unchanged} | improved ${result.improvements.length} | ` +
      `regressed ${result.regressions.length}`,
  );
  for (const i of result.improvements) {
    console.log(`  ✅ improved  ${i.name} (${i.role}) ${i.baseline ?? 'OUT'} -> ${i.current ?? 'OUT'}`);
  }
  for (const m of result.missingFromCurrent) {
    console.log(`  ⚠️  no longer measured: ${m}`);
  }
  for (const r of result.regressions) {
    console.log(`  ❌ REGRESSED ${r.name} (${r.role}) ${r.baseline ?? 'OUT'} -> ${r.current ?? 'OUT'}`);
  }

  if (result.regressions.length > 0) {
    throw new Error(
      `${result.regressions.length} ranking regression(s) against the baseline. ` +
        `This is a regression guard, not a quality bar: if the new ranking is ` +
        `intended, re-record with --update-baseline and explain the movement.`,
    );
  }
  console.log('\n  no ranking regressions.');
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

export { main as rankingGuard };
