/**
 * Snapshot a shape-preserving slice of a production corpus into a CI fixture.
 *
 * DEV-ONLY, run by hand on a machine pointed at the real database. It never
 * writes to the database it reads — the only writes are the fixture file.
 *
 *   npx tsx scripts/snapshot-golden-corpus.ts [--size 150] [--out <path>]
 *
 * WHY A SUBSET AND NOT A HANDFUL OF SEEDED ROWS
 *
 * Measured 2026-09-08, the golden set's discriminating power is entirely
 * structural: the distractor is the corpus's max-degree hub (291 edges, HOT,
 * temperature 1.0) and the targets are cold leaves (degree 1-3, temp ~0.03).
 * A fresh database reproduces none of that, so every query would pass
 * trivially. See scripts/golden-corpus.ts for the full rationale.
 *
 * SELECTION, in priority order:
 *   1. every entity named by tests/fixtures/golden-queries.json — without
 *      these the fixture cannot answer the golden questions at all;
 *   2. the top HUB_COUNT entities by total degree — the hubs ARE the
 *      adversarial condition the hub-ranking bug documented;
 *   3. every direct neighbour of (1), so the targets keep their local graph;
 *   4. a tier-stratified fill to `size`, ordered by md5(id) so the choice is
 *      reproducible rather than whatever the planner returned today.
 *
 * Edges are kept only when BOTH endpoints survive selection, so centrality is
 * computed over a closed subgraph rather than one with dangling references.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { db } from '../src/db.js';
import { embedForQuery } from '../src/embed.js';
import { loadGoldenQueries } from './score-benchmark.js';
import type { CorpusEntity, CorpusRelation, GoldenCorpus } from './golden-corpus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '..', 'tests', 'fixtures', 'golden-corpus.json');
const HUB_COUNT = 12;

/**
 * Decimal places kept for stored vectors.
 *
 * bge-small vectors are L2-normalized, so components sit around ±0.1 and six
 * places is a relative error near 1e-5 — far below any margin that decides a
 * rank. Full precision cost 3.3 MB of mostly-noise digits in git. The fixture
 * is self-consistent either way: the baseline is recorded FROM these values,
 * not from a production corpus, so rounding shifts nothing it is compared against.
 */
const EMBED_DP = 6;

const roundVector = (v: number[]): number[] =>
  v.map((x) => Number(x.toFixed(EMBED_DP)));

/**
 * Bind a JS array as a real Postgres array.
 *
 * drizzle's sql template FLATTENS a JS array into separate placeholders, so
 * `= ANY(${names}::text[])` emits `ANY(($1, $2, $3)::text[])` and fails at
 * execution — the same trap documented at src/file-sync.ts:450. Each element
 * stays its own bound parameter here, so a name containing a comma or quote is
 * safe, which `string_to_array` on a joined string would not be.
 */
const pgArray = (vals: string[], type: 'text' | 'uuid') =>
  sql`ARRAY[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::${sql.raw(type)}[]`;

function parseArgs(argv: string[]): { size: number; out: string } {
  let size = 150;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--size') size = Number(argv[++i]);
    else if (argv[i] === '--out') out = resolve(argv[++i]);
  }
  if (!Number.isFinite(size) || size < 10) {
    throw new Error(`--size must be an integer >= 10, got ${argv.join(' ')}`);
  }
  return { size, out };
}

function currentCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: resolve(HERE, '..') })
      .toString()
      .trim();
  } catch {
    return null; // not a checkout, or git unavailable — not worth failing over
  }
}

async function main(): Promise<void> {
  const { size, out } = parseArgs(process.argv.slice(2));
  const golden = loadGoldenQueries();
  const requiredNames = [
    ...new Set(golden.flatMap((g) => [...g.expect_top, ...g.expect_not_top])),
  ];

  // Fail loudly on a golden name that no longer exists. the entity rename renamed nine
  // entities; a snapshot that silently omitted a renamed target would produce
  // a fixture whose queries can never pass, and the baseline would enshrine it.
  const found = await db.execute(sql`
    SELECT name FROM public.entities WHERE name = ANY(${pgArray(requiredNames, 'text')})
  `);
  const foundNames = new Set((found.rows as { name: string }[]).map((r) => r.name));
  const absent = requiredNames.filter((n) => !foundNames.has(n));
  if (absent.length > 0) {
    throw new Error(
      `golden-queries.json names ${absent.length} entities that do not exist: ` +
        `${absent.join(', ')}. Rename them in the golden set, or the fixture ` +
        `will guard a question the corpus can no longer answer.`,
    );
  }

  const shape = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM public.entities) AS entities,
      (SELECT count(*)::int FROM public.memory_relations) AS edges,
      (SELECT COALESCE(max(d),0)::int FROM (
         SELECT count(*) d FROM (
           SELECT from_id id FROM public.memory_relations
           UNION ALL SELECT to_id FROM public.memory_relations) x
         GROUP BY id) y) AS max_degree
  `);
  const live = (shape.rows as { entities: number; edges: number; max_degree: number }[])[0];

  const selected = await db.execute(sql`
    WITH degree AS (
      SELECT id, count(*)::int AS d FROM (
        SELECT from_id id FROM public.memory_relations
        UNION ALL SELECT to_id FROM public.memory_relations) x
      GROUP BY id
    ),
    required AS (
      SELECT id FROM public.entities WHERE name = ANY(${pgArray(requiredNames, 'text')})
    ),
    hubs AS (
      SELECT id FROM degree ORDER BY d DESC, id LIMIT ${HUB_COUNT}
    ),
    neighbours AS (
      SELECT r.to_id AS id FROM public.memory_relations r JOIN required q ON r.from_id = q.id
      UNION
      SELECT r.from_id AS id FROM public.memory_relations r JOIN required q ON r.to_id = q.id
    ),
    core AS (
      SELECT id FROM required
      UNION SELECT id FROM hubs
      UNION SELECT id FROM neighbours
    ),
    -- Stratified fill, ordered by md5(id) so re-running picks the same rows.
    fill AS (
      SELECT e.id
      FROM public.entities e
      WHERE e.id NOT IN (SELECT id FROM core)
      ORDER BY e.tier, md5(e.id::text)
      LIMIT GREATEST(0, ${size} - (SELECT count(*) FROM core))
    )
    SELECT
      e.id::text                       AS id,
      e.name                           AS name,
      e.type                           AS entity_type,
      COALESCE(e.observations, '')     AS observations,
      COALESCE(e.tags, '{}')           AS tags,
      COALESCE(e.tier, 'HOT')          AS tier,
      COALESCE(e.temperature, 0)::float8   AS temperature,
      COALESCE(e.importance, 0.5)::float8  AS importance,
      COALESCE(e.access_count, 0)::int     AS access_count,
      CASE WHEN e.last_accessed_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (NOW() - e.last_accessed_at)) / 86400.0 END::float8
                                       AS last_accessed_days_ago,
      (EXTRACT(EPOCH FROM (NOW() - COALESCE(e.created_at, NOW()))) / 86400.0)::float8
                                       AS created_days_ago,
      e.embedding::text                AS embedding
    FROM public.entities e
    WHERE e.id IN (SELECT id FROM core UNION SELECT id FROM fill)
    ORDER BY e.id
  `);

  const entities: CorpusEntity[] = (selected.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    entityType: String(r.entity_type),
    observations: String(r.observations ?? ''),
    tags: (r.tags as string[]) ?? [],
    tier: String(r.tier),
    temperature: Number(r.temperature),
    importance: Number(r.importance),
    accessCount: Number(r.access_count),
    lastAccessedDaysAgo:
      r.last_accessed_days_ago === null ? null : Number(r.last_accessed_days_ago),
    createdDaysAgo: Number(r.created_days_ago),
    // pgvector renders as '[0.1,0.2,...]'; keep it as numbers in the fixture so
    // the file is diffable and the digest sees values, not formatting.
    embedding:
      r.embedding === null ? null : roundVector(JSON.parse(String(r.embedding)) as number[]),
  }));

  const ids = entities.map((e) => e.id);
  const rels = await db.execute(sql`
    SELECT from_id::text AS from_id, to_id::text AS to_id, relation_type, provenance
    FROM public.memory_relations
    WHERE from_id = ANY(${pgArray(ids, 'uuid')}) AND to_id = ANY(${pgArray(ids, 'uuid')})
    ORDER BY from_id, to_id, relation_type
  `);
  const relations: CorpusRelation[] = (rels.rows as Record<string, string>[]).map((r) => ({
    fromId: r.from_id,
    toId: r.to_id,
    relationType: r.relation_type,
    provenance: r.provenance as CorpusRelation['provenance'],
  }));

  // Freeze query embeddings. Computed here on the snapshotting machine and
  // never recomputed in CI — see determinism note 2 in golden-corpus.ts.
  const queryEmbeddings: Record<string, number[]> = {};
  for (const g of golden) {
    const vec = await embedForQuery(g.query);
    if (vec === null) {
      // embedForQuery returns null rather than throwing — by design, so a
      // failed embed degrades recall to lexical-only instead of breaking it.
      // That is the wrong trade HERE: a fixture missing a frozen embedding is
      // unusable, and the guard would only discover it later at measure time
      // with a less obvious message. Fail at the point of production.
      throw new Error(
        `could not embed golden query ${JSON.stringify(g.query)}. The snapshot ` +
          `needs a frozen vector for every query — check the bge-small model is ` +
          `cached (scripts/precache-embed-model.ts) and re-run.`,
      );
    }
    queryEmbeddings[g.query] = roundVector(Array.from(vec));
  }

  const corpus: GoldenCorpus = {
    generatedAt: new Date().toISOString(),
    sourceCommit: currentCommit(),
    liveShape: { entities: live.entities, edges: live.edges, maxDegree: live.max_degree },
    entities,
    relations,
    queryEmbeddings,
  };

  // Compact, NOT pretty-printed: indent-2 puts all 384 vector components on
  // separate lines, which was the entire difference between 3.0 MB and 700 KB.
  // A generated fixture of this size is not hand-diffable regardless, and the
  // digest — not review of the JSON — is what detects unintended change.
  writeFileSync(out, `${JSON.stringify(corpus)}\n`);

  const embedded = entities.filter((e) => e.embedding !== null).length;
  const maxDeg = relations.length
    ? Math.max(
        ...ids.map(
          (id) => relations.filter((r) => r.fromId === id || r.toId === id).length,
        ),
      )
    : 0;
  console.log(`wrote ${out}`);
  console.log(`  entities ${entities.length} (${embedded} embedded)`);
  console.log(`  relations ${relations.length}  max degree in fixture ${maxDeg}`);
  console.log(`  live corpus: ${live.entities} entities / ${live.edges} edges / max degree ${live.max_degree}`);
  console.log(`  required golden names present: ${requiredNames.length}/${requiredNames.length}`);
  console.log('\nNext: recreate the baseline against a scratch database:');
  console.log('  npx tsx scripts/ranking-guard.ts --update-baseline');
}

// Only run when invoked directly; realpath so a symlinked bin still matches.
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

export { main as snapshotGoldenCorpus };
