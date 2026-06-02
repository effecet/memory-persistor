/**
 * Knowledge graph operations: relation ontology, multi-hop traversal,
 * auto-detect relation types, and community detection.
 *
 * All graph queries use recursive CTEs for traversal and
 * union-find for community detection — pure PostgreSQL, no extensions.
 */
import { db } from './db.js';
import { sql } from 'drizzle-orm';

// ── Relation ontology ──────────────────────────────────────────────────────

export const RELATION_TYPES = [
  'related_to',
  'supersedes',
  'contradicts',
  'elaborates',
  'depends_on',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export function isValidRelationType(type: string): type is RelationType {
  return (RELATION_TYPES as readonly string[]).includes(type);
}

// ── Traverse (recursive CTE) ──────────────────────────────────────────────

interface TraverseNode {
  id: string;
  name: string;
  type: string;
  tier: string;
  depth: number;
}

interface TraverseEdge {
  fromId: string;
  toId: string;
  relationType: string;
}

interface TraverseResult {
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  mermaid: string;
}

interface TraverseOptions {
  depth?: number;
  relationTypes?: string[];
}

/**
 * Multi-hop graph traversal from a starting memory.
 * Uses a recursive CTE to explore the graph breadth-first.
 */
export async function traverse(
  startId: string,
  options: TraverseOptions = {},
): Promise<TraverseResult> {
  const maxDepth = Math.min(Math.max(options.depth ?? 2, 1), 5);
  const filterTypes = options.relationTypes;

  // Build relation type filter for the CTE
  const typeFilter = filterTypes && filterTypes.length > 0
    ? sql`AND r.relation_type = ANY(${`{${filterTypes.map((t) => t.replace(/[{},"'\\\\/]/g, '')).join(',')}}`}::text[])`
    : sql``;

  const result = await db.execute(sql`
    WITH RECURSIVE graph_walk AS (
      -- Base case: the starting node at depth 0
      SELECT
        e.id,
        e.name,
        e.type,
        COALESCE(e.tier, 'COLD') AS tier,
        0 AS depth,
        ARRAY[e.id] AS visited
      FROM public.entities e
      WHERE e.id = ${startId}

      UNION ALL

      -- Recursive case: follow edges (bidirectional) up to maxDepth
      SELECT
        neighbor.id,
        neighbor.name,
        neighbor.type,
        COALESCE(neighbor.tier, 'COLD') AS tier,
        gw.depth + 1,
        gw.visited || neighbor.id
      FROM graph_walk gw
      JOIN public.memory_relations r
        ON (r.from_id = gw.id OR r.to_id = gw.id)
        ${typeFilter}
      JOIN public.entities neighbor
        ON neighbor.id = CASE WHEN r.from_id = gw.id THEN r.to_id ELSE r.from_id END
      WHERE gw.depth < ${maxDepth}
        AND NOT (neighbor.id = ANY(gw.visited))
    )
    SELECT DISTINCT ON (id) id, name, type, tier, depth
    FROM graph_walk
    ORDER BY id, depth ASC
  `);

  const nodes = result.rows as unknown as TraverseNode[];
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Fetch edges between discovered nodes
  const nodeIdArray = `{${Array.from(nodeIds).join(',')}}`;
  const edgeResult = await db.execute(sql`
    SELECT r.from_id AS "fromId", r.to_id AS "toId", r.relation_type AS "relationType"
    FROM public.memory_relations r
    WHERE r.from_id = ANY(${nodeIdArray}::uuid[])
      AND r.to_id = ANY(${nodeIdArray}::uuid[])
  `);

  const edges = edgeResult.rows as unknown as TraverseEdge[];

  // Build Mermaid subgraph
  const mermaid = buildTraverseMermaid(nodes, edges);

  return { nodes, edges, mermaid };
}

function buildTraverseMermaid(nodes: TraverseNode[], edges: TraverseEdge[]): string {
  const lines: string[] = ['flowchart LR'];
  lines.push('  classDef hot fill:#ff6b6b,stroke:#c0392b,color:#fff');
  lines.push('  classDef warm fill:#f39c12,stroke:#e67e22,color:#fff');
  lines.push('  classDef cold fill:#3498db,stroke:#2980b9,color:#fff');

  const idMap = new Map<string, string>();
  for (const n of nodes) {
    const shortId = n.id.replace(/-/g, '').slice(0, 8);
    idMap.set(n.id, shortId);
    const safeName = (n.name || '').replace(/"/g, "'").slice(0, 40);
    lines.push(`  ${shortId}["${safeName}\\n(${n.type})"]`);
    lines.push(`  class ${shortId} ${(n.tier || 'cold').toLowerCase()}`);
  }

  for (const e of edges) {
    const from = idMap.get(e.fromId);
    const to = idMap.get(e.toId);
    if (from && to) {
      lines.push(`  ${from} -->|${e.relationType}| ${to}`);
    }
  }

  return lines.join('\n');
}

// ── Auto-detect relation type ──────────────────────────────────────────────

interface MemoryLike {
  id: string;
  name: string;
  type: string;
  observations?: string;
}

/**
 * Detect the most appropriate relation type between two memories
 * using pg_trgm word_similarity on name and observations.
 *
 * Rules:
 * - supersedes: name similarity > 0.8, same type (newer replaces older)
 * - contradicts: name similarity > 0.7, observations similarity < 0.3, same type
 * - related_to: default fallback
 */
export async function detectRelationType(
  newMemory: MemoryLike,
  existingMemory: MemoryLike,
): Promise<RelationType> {
  if (newMemory.type !== existingMemory.type) {
    return 'related_to';
  }

  const result = await db.execute(sql`
    SELECT
      word_similarity(${newMemory.name}, ${existingMemory.name}) AS name_sim,
      word_similarity(
        COALESCE(${newMemory.observations ?? ''}, ''),
        COALESCE(${existingMemory.observations ?? ''}, '')
      ) AS obs_sim
  `);

  const row = result.rows[0] as { name_sim: number; obs_sim: number };
  const nameSim = row.name_sim;
  const obsSim = row.obs_sim;

  // Supersedes: very similar name, same type (new version of same knowledge)
  if (nameSim > 0.8) {
    return 'supersedes';
  }

  // Contradicts: similar topic (name) but different content (observations)
  if (nameSim > 0.7 && obsSim < 0.3) {
    return 'contradicts';
  }

  return 'related_to';
}

// ── Community detection (connected components) ─────────────────────────────

interface Community {
  id: number;
  members: string[];
}

/**
 * Detect communities (connected components) in the memory graph.
 * Fetches all nodes and edges, then runs BFS in application code.
 * Returns clusters with 1+ members.
 */
export async function detectCommunities(): Promise<Community[]> {
  // Fetch all node IDs
  const nodesResult = await db.execute(sql`SELECT id FROM public.entities`);
  const allIds = (nodesResult.rows as { id: string }[]).map((r) => r.id);

  // Fetch all edges
  const edgesResult = await db.execute(sql`
    SELECT from_id AS "fromId", to_id AS "toId" FROM public.memory_relations
  `);
  const edges = edgesResult.rows as { fromId: string; toId: string }[];

  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const id of allIds) {
    adj.set(id, new Set());
  }
  for (const e of edges) {
    adj.get(e.fromId)?.add(e.toId);
    adj.get(e.toId)?.add(e.fromId);
  }

  // BFS to find connected components
  const visited = new Set<string>();
  const communities: Community[] = [];
  let idx = 0;

  for (const startId of allIds) {
    if (visited.has(startId)) continue;

    const members: string[] = [];
    const queue = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      members.push(current);

      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    communities.push({ id: idx++, members });
  }

  return communities;
}
