/**
 * Observability: analytics and health metrics.
 * All queries are read-only and use the shared connection pool.
 */
import { db } from './db.js';
import { sql, count, desc, asc, eq } from 'drizzle-orm';
import { entities } from './schema.js';
import {
  DEDUP_COSINE_THRESHOLD,
  RESPONSE_CAP_BYTES,
  RESPONSE_JSON_INDENT,
  HEALTH_ORPHAN_LIMIT,
  HEALTH_DEDUP_LIMIT,
  HEALTH_HUB_LIMIT,
  STATUS_TOP_N,
} from './config.js';
import { CENTRALITY_DENOM_EXPR } from './retrieve.js';
import { detectCommunities } from './graph.js';
import { resolveCutoffs } from './thermal-cutoffs.js';

/** How many hubs `health` names. Bounded on purpose — see GraphShape. */


/**
 * Every list `enforceHealthCap` may trim, each paired with the total it should
 * be compared against and the flag that reports the cut.
 *
 * A RECORD rather than a list of keys, so a trimmable list cannot be added
 * without a truncation signal. That was not hypothetical: the flag was added to
 * `orphans`, then `dedupCandidates`, then `hubs`, then `typeCoverage` — four
 * times, each time only after a reviewer pointed at the list that lacked it.
 * A short list that cannot say it is short is the whole defect the health-cap change is about,
 * and the shape of the code now enforces it.
 *
 * `orphans` and `dedupCandidates` compare against exact corpus counts.
 * `hubs` and `typeCoverage` have no corpus total — they are a top-N and a
 * census — so they compare against what was assembled, and `false` means
 * "everything we built", not "everything that exists".
 */
const TRIMMABLE: Record<
  string,
  {
    get: (h: HealthResult) => unknown[];
    total: (h: HealthResult, original: HealthResult) => number;
    setTruncated: (h: HealthResult, cut: boolean) => void;
  }
> = {
  dedupCandidates: {
    get: (h) => h.dedupCandidates,
    total: (h) => h.dedupCandidateCount,
    setTruncated: (h, cut) => {
      h.dedupCandidatesTruncated = cut;
    },
  },
  orphans: {
    get: (h) => h.orphans,
    total: (h) => h.orphanCount,
    setTruncated: (h, cut) => {
      h.orphansTruncated = cut;
    },
  },
  hubs: {
    get: (h) => h.graph.hubs,
    total: (_h, original) => original.graph.hubs.length,
    setTruncated: (h, cut) => {
      h.graph.hubsTruncated = cut;
    },
  },
  typeCoverage: {
    get: (h) => h.typeCoverage,
    total: (_h, original) => original.typeCoverage.length,
    setTruncated: (h, cut) => {
      h.typeCoverageTruncated = cut;
    },
  },
};

/**
 * Trim `health` until its SERIALIZED payload fits RESPONSE_CAP_BYTES.
 *
 * Payload-level rather than per-field, and measured with the SAME serializer
 * the MCP boundary uses (RESPONSE_JSON_INDENT). Per-field budgets were sized
 * against compact JSON while the handler emitted indented JSON — 26% larger —
 * so the guard passed while the response went over: 25_292 B compact against
 * 31_881 B emitted, on a 30_000 B cap.
 *
 * Each pass trims the list currently occupying the most bytes, dropping rows
 * from its tail using each row's ACTUAL serialized size. Two earlier shapes
 * were measured and rejected:
 *
 *   - one pop per full re-serialization: 147 passes, 84 ms at 10 KB names and
 *     8.0 s at 1 MB names, blocking a single-threaded server during the very
 *     incident `health` is used to diagnose;
 *   - dropping `ceil(overshoot / meanRowBytes)` in one go: the mean is
 *     inflated by a single fat row, so 99 tiny orphans plus one 100 KB row
 *     dropped 73 rows and landed at 1_441 B inside a 30 KB budget — and
 *     charging the whole overshoot to one list drained the scarcer diagnostics
 *     to a single row each.
 *
 * Real per-row sizes cost one small serialization per dropped row and give the
 * minimum cut that clears the overshoot.
 *
 * Never empties a list that had rows: `[]` during an incident reads as "no
 * orphans", indistinguishable from a healthy brain. Counts are never trimmed,
 * and every list reports whether it was cut.
 *
 * It CAN return over cap — when every list is down to one enormous row. That is
 * the never-empty floor doing its job; the caller still gets exact counts and
 * truncation flags.
 */
export function enforceHealthCap(
  result: HealthResult,
  cap: number = RESPONSE_CAP_BYTES,
  indent: number = RESPONSE_JSON_INDENT,
): HealthResult {
  const size = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value, null, indent), 'utf8');

  const out: HealthResult = {
    ...result,
    orphans: [...result.orphans],
    dedupCandidates: [...result.dedupCandidates],
    typeCoverage: [...result.typeCoverage],
    graph: { ...result.graph, hubs: [...result.graph.hubs] },
  };

  const keys = Object.keys(TRIMMABLE);

  // Each row's serialized size, measured ONCE. The loop below then picks and
  // drops rows without re-serializing the whole payload per row — the shape
  // that measured 8.0 s on 1 MB names — and without averaging, which over-cut
  // by 72 rows when one fat row inflated the mean.
  const rowSizes: Record<string, number[]> = {};
  const remaining: Record<string, number> = {};
  for (const k of keys) {
    rowSizes[k] = TRIMMABLE[k].get(out).map((row) => size(row));
    remaining[k] = rowSizes[k].reduce((a, b) => a + b, 0);
  }

  let total = size(out);
  while (total > cap) {
    const need = total - cap;
    let freed = 0;

    // One row at a time from whichever list currently holds the most bytes, so
    // the cut spreads instead of destroying one diagnostic. Draining a single
    // list is the failure this replaced: four 100-row lists took
    // dedupCandidates to 1 and left the other three untouched at 100.
    while (freed < need) {
      const candidates = keys.filter((k) => TRIMMABLE[k].get(out).length > 1);
      if (candidates.length === 0) break;
      const victim = candidates.reduce((a, b) => (remaining[b] > remaining[a] ? b : a));
      const list = TRIMMABLE[victim].get(out);
      const dropped = rowSizes[victim][list.length - 1];
      list.pop();
      remaining[victim] -= dropped;
      freed += dropped;
    }

    if (freed === 0) break; // every list is down to its last row
    total = size(out);
  }

  for (const k of keys) {
    const spec = TRIMMABLE[k];
    spec.setTruncated(out, spec.get(out).length < spec.total(out, result));
  }
  return out;
}

// ── Analytics ───────────────────────────────────────────────────────────────

export interface AnalyticsResult {
  recallHitRate: number;
  totalRecalls: number;
  topAccessed: { id: string; name: string; accessCount: number }[];
  avgRecallScore: number | null;
  temperatureDistribution: { bucket: string; count: number }[];
  eventsPerDay: { date: string; count: number }[];
  graphDensity: number;
}

/**
 * Compute analytics from the events table and entity data.
 */
export async function getAnalytics(): Promise<AnalyticsResult> {
  // Recall hit rate: recalls with results / total recalls
  const recallStats = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'recall') AS total_recalls,
      COUNT(*) FILTER (
        WHERE event_type = 'recall'
        AND (payload->>'resultCount')::int > 0
      ) AS recalls_with_results
    FROM public.events
  `);
  const row = recallStats.rows[0] as any;
  const totalRecalls = parseInt(row.total_recalls) || 0;
  const recallsWithResults = parseInt(row.recalls_with_results) || 0;
  const recallHitRate = totalRecalls > 0 ? recallsWithResults / totalRecalls : 0;

  // Top 10 most-accessed memories
  const topAccessed = await db.execute(sql`
    SELECT id, name, COALESCE(access_count, 0) AS "accessCount"
    FROM public.entities
    ORDER BY access_count DESC NULLS LAST
    LIMIT 10
  `);

  // Average recall score (from events payload)
  const avgScore = await db.execute(sql`
    SELECT AVG((payload->>'avgScore')::real) AS avg_score
    FROM public.events
    WHERE event_type = 'recall'
      AND payload->>'avgScore' IS NOT NULL
  `);
  const avgRecallScore = (avgScore.rows[0] as any)?.avg_score ?? null;

  // Temperature distribution (3 buckets: HOT/WARM/COLD)
  const tempDist = await db.execute(sql`
    SELECT tier AS bucket, COUNT(*)::int AS count
    FROM public.entities
    GROUP BY tier
    ORDER BY tier
  `);

  // Events per day (last 30 days)
  const eventsPerDay = await db.execute(sql`
    SELECT
      TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS count
    FROM public.events
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY created_at::date
    ORDER BY date DESC
  `);

  // Graph density: edges / (nodes * (nodes-1) / 2) for undirected graph
  const graphStats = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM public.entities) AS node_count,
      (SELECT COUNT(*) FROM public.memory_relations) AS edge_count
  `);
  const gs = graphStats.rows[0] as any;
  const nodeCount = parseInt(gs.node_count) || 0;
  const edgeCount = parseInt(gs.edge_count) || 0;
  const maxEdges = nodeCount > 1 ? (nodeCount * (nodeCount - 1)) / 2 : 1;
  const graphDensity = edgeCount / maxEdges;

  return {
    recallHitRate,
    totalRecalls,
    topAccessed: topAccessed.rows as any[],
    avgRecallScore: avgRecallScore !== null ? parseFloat(avgRecallScore) || null : null,
    temperatureDistribution: tempDist.rows as any[],
    eventsPerDay: eventsPerDay.rows as any[],
    graphDensity: Math.min(1, graphDensity),
  };
}

// ── Health ───────────────────────────────────────────────────────────────────

export interface DedupCandidatePair {
  aId: string;
  aName: string;
  aObservationsLength: number;
  aCreatedAt: string;
  bId: string;
  bName: string;
  bObservationsLength: number;
  bCreatedAt: string;
  /** Cosine similarity (0–1) over bge-small embeddings; gated by DEDUP_COSINE_THRESHOLD. */
  similarity: number;
  proposedCanonicalId: string;
}

/**
 * Graph shape. The corpus is a power law and nothing reported it.
 *
 * Two of the last three retrieval bugs were DISTRIBUTION bugs — a signal
 * behaving correctly on the median row and pathologically at the tail (the hub-ranking bug,
 * the centrality overflow). That class is invisible to unit tests, because a fresh database has no
 * power law, and it was invisible here: three separate sessions
 * hand-wrote the same degree query during incident triage.
 *
 * No field here may grow with the corpus. `communities` is therefore an
 * aggregate, never the member lists: returning those would add one id per
 * entity and dwarf the rest of the payload.
 *
 * That invariant held for `graph` and for nothing else until the health-cap change: `orphans`
 * had no LIMIT at all, and `dedupCandidates`' LIMIT 100 serialized to ~42 KB
 * against a 30 KB cap. Row caps now bound the queries, and `enforceHealthCap`
 * bounds the assembled payload — including `hubs`, which is why `hubsTruncated`
 * exists. `health` still does not use `applyResponseCap` (that is typed to
 * recall's rows); it has its own enforcement, so RESPONSE_CAP_BYTES now has two
 * implementations and they must stay in agreement about units.
 */
export interface GraphShape {
  /** Degree over ENTITIES, so nodes with no edges are counted, not skipped. */
  degree: {
    min: number;
    median: number;
    p95: number;
    max: number;
    /** Entities with no edges at all. Equals orphanCount; see the note below. */
    zeroCount: number;
  };
  hubs: { id: string; name: string; degree: number }[];
  /**
   * `hubs` was cut by the response cap and is shorter than the top-N this
   * brain actually has. Without it a trimmed list reads as "few hubs".
   */
  hubsTruncated: boolean;
  communities: {
    count: number;
    largest: number;
    median: number;
    /** Components of exactly one member — isolated nodes. */
    singletons: number;
  };
  /**
   * The denominator `recall` divides centrality by. Read from the SAME
   * exported expression, never a copy: this is the value whose re-derivation
   * caused the centrality overflow (normalized centrality reaching 1.007), so a second
   * implementation here would drift and the report would confirm the bug
   * instead of catching it.
   *
   * PROVENANCE-WEIGHTED since then (an inferred edge counts INFERRED_EDGE_WEIGHT),
   * so it is NOT comparable to `degree.max`, which stays a raw edge count. The
   * degree fields and `hubs` describe topology; this describes what recall pays.
   */
  centralityDenominator: number;
}

export interface HealthResult {
  orphanCount: number;
  /** May be a PREFIX of `orphanCount` — see `orphansTruncated`. */
  orphans: { id: string; name: string }[];
  /**
   * `orphans` holds only a prefix of `orphanCount`. Without this a capped list
   * is indistinguishable from a complete one — "17 orphans" vs "17 of 900
   * shown" — which is the defect this field exists to remove.
   */
  orphansTruncated: boolean;
  staleCount: number;
  dedupCandidateCount: number;
  /** May be a PREFIX of `dedupCandidateCount` — see `dedupCandidatesTruncated`. */
  dedupCandidates: DedupCandidatePair[];
  /** `dedupCandidates` holds only a prefix of `dedupCandidateCount`. */
  dedupCandidatesTruncated: boolean;
  contradictionCount: number;
  /**
   * May be a PREFIX — see `typeCoverageTruncated`. A short census is a WRONG
   * DISTRIBUTION, not merely a short list, so this flag matters more than the
   * others.
   */
  typeCoverage: { type: string; count: number }[];
  typeCoverageTruncated: boolean;
  totalMemories: number;
  totalEdges: number;
  /**
   * `totalEdges` split by who made the claim. Inferred-edge sprawl is
   * the failure this makes visible: auto-relate minting edges that centrality
   * then counts. Two scalars; bounded.
   */
  edgeProvenance: { asserted: number; inferred: number };
  graph: GraphShape;
  /**
   * Which cutoffs tiering is actually running on. `source: 'seed'` means
   * the fleet has silently reverted to the earlier absolute TIER_HOT/TIER_WARM
   * thresholds — the decay job has not run, or produced a degenerate
   * distribution. Bounded: five scalars, cannot grow with the corpus.
   */
  thermalCutoffs: {
    hot: number;
    warm: number;
    source: 'measured' | 'seed';
    corpusSize: number;
    computedAt: string | null;
  };
}

/**
 * System health metrics: orphans, stale, dedup candidates, contradictions.
 * All independent queries run in parallel via Promise.all.
 */
/**
 * Assemble the GraphShape payload.
 *
 * Split out so the aggregation is testable without a database. Community sizes
 * are reduced to four numbers here — never the member lists, which would add
 * one id per entity to an uncapped response.
 */
export function buildGraphShape(
  degreeRow: Record<string, unknown>,
  hubRows: Record<string, unknown>[],
  communities: { members: string[] }[],
): GraphShape {
  const sizes = communities.map((c) => c.members.length).sort((a, b) => a - b);
  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
  };
  return {
    // enforceHealthCap flips this if the response cap forces hubs shorter.
    hubsTruncated: false,
    degree: {
      min: Number(degreeRow?.min ?? 0),
      median: Number(degreeRow?.median ?? 0),
      p95: Number(degreeRow?.p95 ?? 0),
      max: Number(degreeRow?.max ?? 0),
      zeroCount: Number(degreeRow?.zero_count ?? 0),
    },
    hubs: hubRows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      degree: Number(r.degree),
    })),
    communities: {
      count: sizes.length,
      largest: sizes.length ? sizes[sizes.length - 1] : 0,
      median: median(sizes),
      singletons: sizes.filter((n) => n === 1).length,
    },
    centralityDenominator: Number(degreeRow?.centrality_denominator ?? 1),
  };
}

export async function getHealth(): Promise<HealthResult> {
  const [
    orphans,
    staleResult,
    dedupPairsResult,
    contradictions,
    typeCoverage,
    totals,
    degreeResult,
    hubsResult,
    communities,
    cutoffsResult,
  ] = await Promise.all([
      // Orphan memories (0 edges) — capped at HEALTH_ORPHAN_LIMIT.
      //
      // COUNT(*) OVER() is load-bearing, not decoration: orphanCount used to be
      // `orphans.rows.length`, so adding this LIMIT without it would silently
      // turn the exact total into the capped number — a capped list that reads
      // as a healthy one, which is the defect the health-cap change is about, one level down.
      db.execute(sql`
        SELECT e.id, e.name, (COUNT(*) OVER())::int AS "totalCount"
        FROM public.entities e
        WHERE NOT EXISTS (
          SELECT 1 FROM public.memory_relations r
          WHERE r.from_id = e.id OR r.to_id = e.id
        )
        ORDER BY e.created_at DESC, e.id
        LIMIT ${HEALTH_ORPHAN_LIMIT}
      `),
      // Stale count
      db.execute(sql`
        SELECT COUNT(*)::int AS count FROM public.entities WHERE stale = true
      `),
      // Dedup candidate pairs (cosine near-dupes) — capped at HEALTH_DEDUP_LIMIT.
      // Cosine over the bge-small embeddings: catches semantic/paraphrase dupes
      // a name-only discriminator misses, and post-backfill has a real vector on
      // every primary-origin row. Exclusions:
      //   - NULL-embedding rows (write-disabled machines, pre-backfill) can't be
      //     scored → excluded; an optional coverage monitor catches persistent
      //     primary NULLs.
      //   - pairs that already share an edge are already reconciled (merged
      //     sources are deleted; related/superseded pairs aren't open dupes).
      // Surfacing only — no merge, no delete (never auto-merge).
      // observations char_length is still the canonical-pick tie-break.
      // COUNT(*) OVER() gives the pre-LIMIT total in one pass.
      // Still O(n²) on the self-join; at n≳2000 add an HNSW index + a per-row
      // `embedding <=> embedding` lateral top-k instead of the full scan.
      db.execute(sql`
        WITH pair_scores AS (
          SELECT
            a.id         AS "aId",
            a.name       AS "aName",
            char_length(COALESCE(a.observations, '')) AS "aObservationsLength",
            a.created_at AS "aCreatedAt",
            b.id         AS "bId",
            b.name       AS "bName",
            char_length(COALESCE(b.observations, '')) AS "bObservationsLength",
            b.created_at AS "bCreatedAt",
            -- L2-normalized vectors → cosine similarity = 1 - cosine distance.
            (1 - (a.embedding <=> b.embedding)) AS "similarity",
            CASE
              WHEN char_length(COALESCE(a.observations, ''))
                 > char_length(COALESCE(b.observations, '')) THEN a.id
              WHEN char_length(COALESCE(a.observations, ''))
                 < char_length(COALESCE(b.observations, '')) THEN b.id
              WHEN a.created_at >= b.created_at THEN a.id
              ELSE b.id
            END AS "proposedCanonicalId"
          FROM public.entities a
          JOIN public.entities b
            ON a.type = b.type
           AND a.id < b.id
          WHERE a.embedding IS NOT NULL
            AND b.embedding IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM public.memory_relations r
              WHERE (r.from_id = a.id AND r.to_id = b.id)
                 OR (r.from_id = b.id AND r.to_id = a.id)
            )
        )
        SELECT *, (COUNT(*) OVER())::int AS "totalCount"
        FROM pair_scores
        WHERE "similarity" > ${DEDUP_COSINE_THRESHOLD}
        ORDER BY "similarity" DESC
        LIMIT ${HEALTH_DEDUP_LIMIT}
      `),
      // Contradiction count
      db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM public.memory_relations
        WHERE relation_type = 'contradicts'
      `),
      // Type coverage
      db.execute(sql`
        SELECT type, COUNT(*)::int AS count
        FROM public.entities
        GROUP BY type
        ORDER BY count DESC
      `),
      // Totals
      db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM public.entities) AS total_memories,
          r.total_edges,
          r.asserted_edges,
          r.inferred_edges
        FROM (
          -- One scan for all three edge counts.
          SELECT
            COUNT(*)::int                                          AS total_edges,
            COUNT(*) FILTER (WHERE provenance = 'asserted')::int   AS asserted_edges,
            COUNT(*) FILTER (WHERE provenance = 'inferred')::int   AS inferred_edges
          FROM public.memory_relations
        ) r
      `),
      // Degree distribution + the centrality denominator.
      //
      // Degree is computed by LEFT JOINing from entities, NOT by aggregating
      // memory_relations. A GROUP BY over the relations table can only see
      // nodes that HAVE an edge, so zeroCount — the one number this is most
      // needed for — would be structurally unreachable and silently report 0.
      //
      // The denominator comes from CENTRALITY_DENOM_EXPR, the same expression
      // recall divides by. See GraphShape.centralityDenominator for why this
      // must never be re-derived here.
      db.execute(sql`
        WITH degrees AS (
          SELECT e.id, (
            SELECT COUNT(*)::int FROM public.memory_relations r
            WHERE r.from_id = e.id OR r.to_id = e.id
          ) AS d
          FROM public.entities e
        )
        SELECT
          COALESCE(MIN(d), 0)::int                                        AS min,
          COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY d), 0)     AS median,
          COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY d), 0)    AS p95,
          COALESCE(MAX(d), 0)::int                                        AS max,
          COUNT(*) FILTER (WHERE d = 0)::int                              AS zero_count,
          (${CENTRALITY_DENOM_EXPR})::float                               AS centrality_denominator
        FROM degrees
      `),
      // Top-N hubs. LIMIT keeps this bounded as the corpus grows.
      db.execute(sql`
        SELECT e.id::text AS id, e.name AS name, (
          SELECT COUNT(*)::int FROM public.memory_relations r
          WHERE r.from_id = e.id OR r.to_id = e.id
        ) AS degree
        FROM public.entities e
        ORDER BY degree DESC, e.id
        LIMIT ${HEALTH_HUB_LIMIT}
      `),
      // Connected components, via the union-find already in graph.ts. Reused
      // rather than re-implemented in SQL, so health reports what the graph
      // code actually sees (the graph-shape work explicitly declines a Leiden swap here).
      detectCommunities(),
      // Thermal cutoffs (single row, or none before 0012 is applied).
      db.execute(sql`
        SELECT hot_cutoff, warm_cutoff, corpus_size, computed_at
        FROM public.thermal_cutoffs WHERE id = 1
      `),
    ]);

  const dedupRows = dedupPairsResult.rows as any[];
  const dedupCandidateCount = dedupRows.length > 0
    ? parseInt(dedupRows[0].totalCount) || 0
    : 0;

  const dedupCandidatesAll: DedupCandidatePair[] = dedupRows.map((r) => ({
    aId: r.aId,
    aName: r.aName,
    aObservationsLength: Number(r.aObservationsLength),
    aCreatedAt: r.aCreatedAt instanceof Date ? r.aCreatedAt.toISOString() : r.aCreatedAt,
    bId: r.bId,
    bName: r.bName,
    bObservationsLength: Number(r.bObservationsLength),
    bCreatedAt: r.bCreatedAt instanceof Date ? r.bCreatedAt.toISOString() : r.bCreatedAt,
    similarity: Number(r.similarity),
    proposedCanonicalId: r.proposedCanonicalId,
  }));

  const orphanRows = orphans.rows as { id: string; name: string; totalCount?: number }[];
  // The exact total, from COUNT(*) OVER() — never the length of the capped
  // array. Zero rows means zero orphans, so the fallback is correct.
  const orphanCount = orphanRows.length > 0 ? Number(orphanRows[0].totalCount) || 0 : 0;
  const orphanList = orphanRows.map((r) => ({ id: r.id, name: r.name }));

  const t = totals.rows[0] as any;

  // Thermal cutoffs: report what bump() is ACTUALLY tiering against,
  // not the raw stored columns — run the stored row through the same
  // resolveCutoffs() bump()'s SQL mirrors, so a stale or degenerate row is
  // reported as `source: 'seed'` with the seed values, never as `measured`
  // with stale numbers. See task-6-brief.md for why this must not be
  // simplified to reading hot_cutoff/warm_cutoff directly.
  const cutoffRow = (cutoffsResult.rows as any[])[0];
  const resolved = resolveCutoffs(
    cutoffRow
      ? {
          hotCutoff: Number(cutoffRow.hot_cutoff),
          warmCutoff: Number(cutoffRow.warm_cutoff),
          // corpus_size = 0 is the seed marker (0012 seeds it, and the decay
          // function's pass 3 rewrites it when a band is empty). It must be
          // passed, not dropped, or the seeded 0.7/0.3 row reports as
          // `measured`.
          corpusSize: Number(cutoffRow.corpus_size),
          computedAt: new Date(cutoffRow.computed_at),
        }
      : null,
  );

  return enforceHealthCap({
    // The exact total, from COUNT(*) OVER() — never the length of the capped
    // array. Zero rows means zero orphans, so the fallback is correct.
    orphanCount,
    orphans: orphanList,
    // Placeholder: enforceHealthCap recomputes both flags unconditionally from
    // the final list lengths, so these values never survive.
    orphansTruncated: false,
    staleCount: parseInt((staleResult.rows[0] as any).count) || 0,
    dedupCandidateCount,
    dedupCandidates: dedupCandidatesAll,
    dedupCandidatesTruncated: false,
    contradictionCount: parseInt((contradictions.rows[0] as any).count) || 0,
    typeCoverage: typeCoverage.rows as any[],
    // Placeholder: enforceHealthCap recomputes every truncation flag.
    typeCoverageTruncated: false,
    totalMemories: parseInt(t.total_memories) || 0,
    totalEdges: parseInt(t.total_edges) || 0,
    edgeProvenance: {
      asserted: parseInt(t.asserted_edges) || 0,
      inferred: parseInt(t.inferred_edges) || 0,
    },
    graph: buildGraphShape(degreeResult.rows[0] as any, hubsResult.rows as any[], communities),
    thermalCutoffs: {
      hot: resolved.hot,
      warm: resolved.warm,
      source: resolved.source,
      corpusSize: Number(cutoffRow?.corpus_size ?? 0),
      computedAt: cutoffRow?.computed_at ? new Date(cutoffRow.computed_at).toISOString() : null,
    },
  });
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface StatusResult {
  total: number;
  byTier: Record<string, number>;
  byType: Record<string, number>;
  hottest: { id: string; name: string; temperature: number | null; tier: string | null }[];
  coldest: { id: string; name: string; temperature: number | null; tier: string | null }[];
  staleCount: number;
}

/**
 * The `status` dashboard. Shared by the tool and the `memory://status`
 * resource (the resources change, toolsets) so the two cannot drift. Read-only: no bump, no event.
 */
export async function getStatus(): Promise<StatusResult> {
  const thermalColumns = { id: entities.id, name: entities.name, temperature: entities.temperature, tier: entities.tier };
  // Independent reads, so they run concurrently rather than one round trip each.
  const [[{ value: total }], tierCounts, typeCounts, hottest, coldest, [{ value: staleCount }]] = await Promise.all([
    db.select({ value: count() }).from(entities),
    db.select({ tier: entities.tier, count: count() }).from(entities).groupBy(entities.tier),
    db.select({ type: entities.type, count: count() }).from(entities).groupBy(entities.type),
    db.select(thermalColumns).from(entities).orderBy(desc(entities.temperature)).limit(STATUS_TOP_N),
    db.select(thermalColumns).from(entities).orderBy(asc(entities.temperature)).limit(STATUS_TOP_N),
    // Stale count (COLD for 30+ days)
    db.select({ value: count() }).from(entities).where(eq(entities.stale, true)),
  ]);

  const byTier: Record<string, number> = {};
  for (const row of tierCounts) byTier[row.tier ?? 'UNKNOWN'] = row.count;
  const byType: Record<string, number> = {};
  for (const row of typeCounts) byType[row.type] = row.count;

  return { total, byTier, byType, hottest, coldest, staleCount };
}
