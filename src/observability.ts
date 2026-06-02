/**
 * Observability: analytics and health metrics.
 * All queries are read-only and use the shared connection pool.
 */
import { db } from './db.js';
import { sql } from 'drizzle-orm';

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
  similarity: number;
  proposedCanonicalId: string;
}

export interface HealthResult {
  orphanCount: number;
  orphans: { id: string; name: string }[];
  staleCount: number;
  dedupCandidateCount: number;
  dedupCandidates: DedupCandidatePair[];
  contradictionCount: number;
  typeCoverage: { type: string; count: number }[];
  totalMemories: number;
  totalEdges: number;
}

/**
 * System health metrics: orphans, stale, dedup candidates, contradictions.
 * All independent queries run in parallel via Promise.all.
 */
export async function getHealth(): Promise<HealthResult> {
  const [orphans, staleResult, dedupPairsResult, contradictions, typeCoverage, totals] =
    await Promise.all([
      // Orphan memories (0 edges)
      db.execute(sql`
        SELECT e.id, e.name
        FROM public.entities e
        WHERE NOT EXISTS (
          SELECT 1 FROM public.memory_relations r
          WHERE r.from_id = e.id OR r.to_id = e.id
        )
      `),
      // Stale count
      db.execute(sql`
        SELECT COUNT(*)::int AS count FROM public.entities WHERE stale = true
      `),
      // Dedup candidate pairs (with proposedCanonicalId) — capped at 100.
      // COUNT(*) OVER() provides the total count before LIMIT, eliminating
      // a separate count query (one less full self-join scan).
      // Uses bidirectional word_similarity via GREATEST(forward, reverse).
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
            -- Similarity is name-only. Concatenating multi-KB observations
            -- made this O(n²) word_similarity infeasible — verified >2min
            -- timeout at n=334 (name-only: ~400ms). This is a deliberate
            -- narrowing: the name is the dedup discriminator; bodies added
            -- quadratic trigram cost for marginal recall. observations are
            -- still used below (char_length) for the canonical-pick
            -- tie-break — that signal is unchanged. The 0.85 threshold is
            -- now calibrated against name-only scores.
            -- Future: the self-join is still O(n²) on pair count — at n≳2000
            -- add a gin_trgm_ops index on name + a 'name %> name' join so the
            -- planner does an index-backed similarity join instead of a scan.
            GREATEST(
              word_similarity(COALESCE(a.name, ''), COALESCE(b.name, '')),
              word_similarity(COALESCE(b.name, ''), COALESCE(a.name, ''))
            ) AS "similarity",
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
        )
        SELECT *, (COUNT(*) OVER())::int AS "totalCount"
        FROM pair_scores
        WHERE "similarity" > 0.85
        ORDER BY "similarity" DESC
        LIMIT 100
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
          (SELECT COUNT(*)::int FROM public.memory_relations) AS total_edges
      `),
    ]);

  const dedupRows = dedupPairsResult.rows as any[];
  const dedupCandidateCount = dedupRows.length > 0
    ? parseInt(dedupRows[0].totalCount) || 0
    : 0;

  const dedupCandidates: DedupCandidatePair[] = dedupRows.map((r) => ({
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

  const t = totals.rows[0] as any;

  return {
    orphanCount: (orphans.rows as any[]).length,
    orphans: orphans.rows as any[],
    staleCount: parseInt((staleResult.rows[0] as any).count) || 0,
    dedupCandidateCount,
    dedupCandidates,
    contradictionCount: parseInt((contradictions.rows[0] as any).count) || 0,
    typeCoverage: typeCoverage.rows as any[],
    totalMemories: parseInt(t.total_memories) || 0,
    totalEdges: parseInt(t.total_edges) || 0,
  };
}
