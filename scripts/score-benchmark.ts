/**
 * Read-only scoring benchmark for the recall rebalance (the hub-ranking bug and percentile tiering).
 *
 * Chooses PRIOR_ALPHA from evidence instead of taste, and stays afterwards as a
 * ranking-regression guard.
 *
 * ⚠️ This script MUST NOT import or call `recall()`. `recall` calls `bump()` on
 * every row it returns, which increments access_count and raises temperature —
 * two of the five signals under measurement. Benchmarking through it would move
 * the thing being measured, and the effect compounds over runs (see the memory
 * `recall() reheats the corpus it reads`). Everything here is a plain SELECT
 * built from the expressions retrieve.ts exports, so the harness cannot drift
 * from production scoring either.
 *
 * Usage:
 *   npx tsx scripts/score-benchmark.ts
 *   npx tsx scripts/score-benchmark.ts --alphas 0,0.25,0.5,0.75,1.0
 *   npx tsx scripts/score-benchmark.ts --limit 20 --skip-semantic
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../src/db.js';
import {
  buildRelevanceSql,
  PRIOR_SQL,
  RECALL_ORDER_SQL,
  TEXT_COL,
  trigramExpr,
  semanticExpr,
} from '../src/retrieve.js';
import { TRIGRAM_THRESHOLD, SEMANTIC_WHERE_THRESHOLD } from '../src/config.js';
import { embedForQuery, toPgVector } from '../src/embed.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface GoldenQuery {
  query: string;
  expect_top: string[];
  expect_not_top: string[];
  source?: string;
}

export type Verdict = 'pass' | 'fail' | 'missing';

/**
 * Judge one ranked name list against a golden expectation.
 *
 * `missing` is deliberately distinct from `fail`: an absent memory means the
 * WHERE clause never admitted it, which is a retrieval bug of a different kind
 * from mis-ranking, and no value of alpha can fix it.
 */
export function verdictFor(rankedNames: string[], g: GoldenQuery): Verdict {
  const idx = (n: string): number => rankedNames.indexOf(n);
  // An empty expect_top would make Math.max() below -Infinity, so every unwanted name
  // would compare as "not above" and the row would always pass. A golden query with
  // nothing to expect is a fixture bug, not a pass.
  if (g.expect_top.length === 0) {
    throw new Error(`golden query has empty expect_top: ${g.query}`);
  }
  for (const want of g.expect_top) {
    if (idx(want) === -1) return 'missing';
  }
  const worstWanted = Math.max(...g.expect_top.map(idx));
  for (const unwanted of g.expect_not_top) {
    const at = idx(unwanted);
    if (at !== -1 && at < worstWanted) return 'fail';
  }
  return 'pass';
}

export function loadGoldenQueries(
  path = resolve(HERE, '..', 'tests', 'fixtures', 'golden-queries.json'),
): GoldenQuery[] {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as GoldenQuery[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`golden query set at ${path} is empty`);
  }
  return parsed;
}

export interface ScoredRow {
  name: string;
  relevance: number;
  prior: number;
  score: number;
}

/**
 * Score the corpus for one query at one alpha. Read-only: a single SELECT, no
 * bump, no UPDATE.
 */
export async function scoreQuery(
  query: string,
  alpha: number,
  opts: { limit?: number; skipSemantic?: boolean; frozenEmbedding?: number[] } = {},
): Promise<ScoredRow[]> {
  const limit = opts.limit ?? 20;
  const sanitized = query.replace(/[^\w\s]/g, ' ').trim();
  const tsqueryTerms = sanitized.split(/\s+/).filter(Boolean).join(' & ');
  if (!tsqueryTerms) return [];

  // `frozenEmbedding` lets the ranking guard supply a vector recorded at
  // snapshot time instead of embedding here. bge-small fp32 is pinned, but
  // cross-platform float agreement between a laptop and the CI runner is not
  // guaranteed, and a near-tie only needs one ulp to flip a rank. Ad-hoc
  // benchmark runs pass nothing and still embed live.
  const vector = opts.skipSemantic ? null : (opts.frozenEmbedding ?? (await embedForQuery(query)));
  const vectorParam = vector ? toPgVector(vector) : null;

  const relevance = buildRelevanceSql({
    tsqueryTerms,
    rawQueryText: sanitized,
    vectorParam,
    tags: undefined,
  });
  const tsvec = sql`to_tsvector('english', ${TEXT_COL})`;
  const tsq = sql`to_tsquery('english', ${tsqueryTerms})`;

  // Same hybrid WHERE arm recall uses, so the candidate set matches production.
  const result = await db.execute(sql`
    SELECT
      e.name AS name,
      (${relevance}) AS relevance,
      (${PRIOR_SQL}) AS prior,
      (${relevance}) * (1.0 + ${alpha}::double precision * (${PRIOR_SQL})) AS score
    FROM public.entities e
    WHERE (
      ${tsvec} @@ ${tsq}
      OR ${trigramExpr(sanitized)} > ${TRIGRAM_THRESHOLD}
      OR (${semanticExpr(vectorParam)}) > ${SEMANTIC_WHERE_THRESHOLD}
    )
    -- Production's two-group ordering: live rows before superseded ones.
    ORDER BY ${RECALL_ORDER_SQL}
    LIMIT ${limit}
  `);

  return (result.rows as unknown as Record<string, string | number>[]).map((r) => ({
    name: String(r.name),
    relevance: Number(r.relevance),
    prior: Number(r.prior),
    score: Number(r.score),
  }));
}

function parseArgs(argv: string[]): { alphas: number[]; limit: number; skipSemantic: boolean } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const alphasRaw = get('--alphas') ?? '0,0.25,0.5,0.75,1.0';
  const alphas = alphasRaw.split(',').map((s) => Number(s.trim()));
  // Fail loudly rather than silently. Filtering out non-numbers would turn
  // `--alphas foo` into an empty list, and an empty list prints "NO alpha passes every
  // golden query" — indistinguishable from a real, alarming conclusion.
  const bad = alphas.filter((n) => !Number.isFinite(n));
  if (bad.length > 0 || alphas.length === 0) {
    throw new Error(`--alphas must be a comma-separated list of numbers, got: ${alphasRaw}`);
  }
  // `--limit --skip-semantic` would otherwise yield NaN and a `LIMIT NaN` syntax error.
  const limit = Number(get('--limit') ?? 20);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got: ${String(get('--limit'))}`);
  }
  return { alphas, limit, skipSemantic: argv.includes('--skip-semantic') };
}

async function main(): Promise<void> {
  // The golden queries name memories in a real corpus and are not shipped with
  // this repository. Without them there is nothing to benchmark.
  if (!existsSync(resolve(HERE, '..', 'tests', 'fixtures', 'golden-queries.json'))) {
    console.log('golden queries not present — skipping (see README § Ranking guard)');
    return;
  }
  const { alphas, limit, skipSemantic } = parseArgs(process.argv.slice(2));
  const golden = loadGoldenQueries();

  console.log(`golden queries: ${golden.length} | alphas: ${alphas.join(', ')}`);
  console.log(`semantic: ${skipSemantic ? 'SKIPPED' : 'enabled'} | limit: ${limit}\n`);

  const tally = new Map<number, Record<Verdict, number>>();

  for (const alpha of alphas) {
    const counts: Record<Verdict, number> = { pass: 0, fail: 0, missing: 0 };
    console.log(`── alpha = ${alpha} ${'─'.repeat(40)}`);

    for (const g of golden) {
      const rows = await scoreQuery(g.query, alpha, { limit, skipSemantic });
      const names = rows.map((r) => r.name);
      const verdict = verdictFor(names, g);
      counts[verdict] += 1;

      console.log(`  [${verdict.toUpperCase()}] ${g.query.slice(0, 62)}`);
      for (const want of g.expect_top) {
        const at = names.indexOf(want);
        console.log(`      want@${at === -1 ? 'ABSENT' : at + 1}: ${want}`);
      }
      for (const unwanted of g.expect_not_top) {
        const at = names.indexOf(unwanted);
        if (at !== -1) console.log(`      not @${at + 1}: ${unwanted}`);
      }
    }

    tally.set(alpha, counts);
    console.log(`  => pass ${counts.pass} | fail ${counts.fail} | missing ${counts.missing}\n`);
  }

  console.log('── summary ' + '─'.repeat(44));
  for (const [alpha, c] of tally) {
    console.log(`  alpha ${String(alpha).padEnd(5)} pass ${c.pass} | fail ${c.fail} | missing ${c.missing}`);
  }
  const best = [...tally.entries()]
    .filter(([, c]) => c.fail === 0 && c.missing === 0)
    .map(([a]) => a);
  console.log(
    best.length
      ? `\n  alphas passing every golden query: ${best.join(', ')}`
      : '\n  NO alpha passes every golden query — relevance alone does not separate ' +
        'these queries, so revisit the model rather than picking a value.',
  );
}

// realpathSync on both sides: argv[1] may be a symlink (npm bin shims), and a
// raw string compare would silently skip main(). See the ESM main-guard memory.
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      // Print the message chain only. A pg error from this query carries the full
      // 384-dimension embedding in `params`, which buries the actual cause under
      // thousands of floats.
      for (let err = e as Error | undefined; err; err = err.cause as Error | undefined) {
        console.error(err.message);
      }
      process.exit(1);
    });
}
