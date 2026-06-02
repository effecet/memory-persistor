/**
 * MCP Server for memory-persistor.
 * Exposes 14 tools: remember, recall, recall_by_ids, forget, update, relate, status, graph,
 * traverse, history, merge, conflicts, analytics, health.
 *
 * Note: env loading is handled exclusively by src/db.ts via an explicit
 * dotenv.config({ path, override: true }). Do NOT re-introduce
 * `import 'dotenv/config'` here — it ran before db.ts and shadowed
 * DOTENV_CONFIG_PATH, silently routing all writes to local Docker
 * for 6+ days (observed 2026-04-07 → 2026-04-13).
 */
import { hostname } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { db, closeDb } from './db.js';
import { entities, memoryRelations } from './schema.js';
import { eq, sql, count, desc, asc } from 'drizzle-orm';
import { recall, recallByIds } from './retrieve.js';
import { bump } from './thermal.js';
import { syncToFile, removeFile, syncMerge } from './file-sync.js';
import { MEMORY_TYPES, STATUS_TOP_N, AUTO_RELATE_THRESHOLD, AUTO_RELATE_LIMIT } from './config.js';
import { traverse, detectRelationType, isValidRelationType, RELATION_TYPES } from './graph.js';
import {
  findDedupCandidates,
  snapshotVersion,
  getHistory,
  mergeMemories,
  getConflicts,
} from './intelligence.js';
import { logEvent } from './events.js';
import { getAnalytics } from './observability.js';
import { getHealth } from './observability.js';

const server = new McpServer({
  name: 'memory-persistor',
  version: '1.0.0',
});

// ── remember ───────────────────────────────────────────────────────────────

server.tool(
  'remember',
  'Store a new memory with tags, type, and importance. Use this to persist knowledge, decisions, user preferences, or patterns.',
  {
    name: z.string().describe('Short label for the memory'),
    type: z.enum(MEMORY_TYPES).describe('Memory category'),
    observations: z.string().describe('Full content of the memory'),
    tags: z.array(z.string()).describe('Search tags (e.g., ["python", "preference"])'),
    importance: z.number().min(0).max(1).describe('How critical this memory is (0.0-1.0)'),
    source: z.string().optional().describe('Project CWD path (defaults to env)'),
    relatedTo: z.string().uuid().optional().describe('Existing entity ID to link to'),
  },
  async ({ name, type, observations, tags, importance, source, relatedTo }) => {
    const entitySource = source || process.env.MEMORY_PERSISTOR_DIR || process.cwd();

    const [entity] = await db
      .insert(entities)
      .values({
        name,
        type,
        observations,
        tags,
        source: entitySource,
        importance,
        temperature: 1.0,
        tier: 'HOT',
        accessCount: 0,
        originHost: hostname(),
      })
      .returning();

    // Dual-write to markdown
    syncToFile({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      observations: observations || '',
      temperature: 1.0,
      tier: 'HOT',
      source: entitySource,
      importance,
      accessCount: 0,
      originHost: hostname(),
    });

    // Create relation if specified
    if (relatedTo) {
      await db.insert(memoryRelations).values({
        fromId: entity.id,
        toId: relatedTo,
        relationType: 'related_to',
      });
    }

    // ── Auto-relate: find existing memories similar to the new one ──────
    try {
      // Full mode (not summary) here: detectRelationType below needs the match's
      // observations for its trigram contradicts/elaborates signal. This recall is
      // internal (<=3 rows, never serialized to the harness), so summary saves nothing
      // but would zero out obsSim and mislabel similar memories as "contradicts".
      const autoRelatedRes = await recall({
        query: `${name} ${(observations || '').slice(0, 200)}`,
        limit: AUTO_RELATE_LIMIT,
      });
      const autoRelated = autoRelatedRes.results;

      for (const match of autoRelated) {
        if (match.id === entity.id) continue;
        if (relatedTo && match.id === relatedTo) continue;
        if (match.score < AUTO_RELATE_THRESHOLD) continue;

        // Auto-detect relation type using trigram similarity on name/observations
        const detectedType = await detectRelationType(
          { id: entity.id, name, type, observations },
          { id: match.id, name: match.name, type: match.type, observations: (match as { observations?: string }).observations ?? '' },
        );

        await db.insert(memoryRelations).values({
          fromId: entity.id,
          toId: match.id,
          relationType: detectedType,
        });
      }
    } catch {
      // Non-fatal: auto-relate failure shouldn't block remember
    }

    // ── Dedup check: surface near-duplicates for the caller to decide ──────
    let dedup_candidates: { id: string; name: string; similarity: number }[] = [];
    try {
      dedup_candidates = await findDedupCandidates(entity.id, name, observations, type);
    } catch {
      // Non-fatal: dedup failure shouldn't block remember
    }

    const result: Record<string, unknown> = {
      id: entity.id,
      name: entity.name,
      tier: 'HOT',
      origin_host: hostname(),
    };
    if (dedup_candidates.length > 0) {
      result.dedup_candidates = dedup_candidates;
      logEvent('dedup_detected', entity.id, { candidates: dedup_candidates.length });
    }

    logEvent('remember', entity.id, { type, tags, importance });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result),
        },
      ],
    };
  },
);

// ── recall ─────────────────────────────────────────────────────────────────

server.tool(
  'recall',
  'Search memories using full-text search, tag matching, and thermal scoring. Returns the most relevant memories. Pass output_mode="summary" for a lean projection (no observations body) to triage under the harness token budget; then use recall_by_ids to fetch full bodies for the ids you want. Response is {results, total_matches, truncated, degraded_to_summary}; total_matches counts candidates after limit (not the whole corpus), truncated means the 30 KB cap trimmed rows, degraded_to_summary means full mode fell back to summary because a row exceeded the cap.',
  {
    query: z.string().describe('Search query text'),
    type: z.enum(MEMORY_TYPES).optional().describe('Filter by memory type'),
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    tier: z.enum(['HOT', 'WARM', 'COLD']).optional().describe('Filter by thermal tier'),
    limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
    output_mode: z.enum(['full', 'summary']).optional().describe('Projection: "full" (default) returns observations bodies; "summary" returns lean triage rows'),
  },
  async ({ query, type, tags, tier, limit, output_mode }) => {
    const res = await recall({ query, type, tags, tier, limit, output_mode });

    const avgScore = res.results.length > 0
      ? res.results.reduce((sum, r) => sum + r.score, 0) / res.results.length
      : 0;
    logEvent('recall', null, {
      query,
      resultCount: res.results.length,
      totalMatches: res.total_matches,
      truncated: res.truncated,
      degradedToSummary: res.degraded_to_summary,
      outputMode: output_mode ?? 'full',
      avgScore,
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(res) }],
    };
  },
);

// ── recall_by_ids ────────────────────────────────────────────────────────────

server.tool(
  'recall_by_ids',
  'Fetch full memory bodies for specific ids (no search/scoring). Use after a summary-mode recall to drill into the memories you chose. Preserves input order, omits unknown ids, honors output_mode and the response cap.',
  {
    ids: z.array(z.string().uuid()).min(1).max(50).describe('Memory ids (uuids) to fetch, in the order to return them'),
    output_mode: z.enum(['full', 'summary']).optional().describe('Projection: "full" (default) returns observations bodies; "summary" returns lean rows'),
  },
  async ({ ids, output_mode }) => {
    const res = await recallByIds({ ids, output_mode });
    logEvent('recall_by_ids', null, {
      requested: ids.length,
      resultCount: res.results.length,
      totalMatches: res.total_matches,
      truncated: res.truncated,
      degradedToSummary: res.degraded_to_summary,
      outputMode: output_mode ?? 'full',
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(res) }],
    };
  },
);

// ── forget ─────────────────────────────────────────────────────────────────

server.tool(
  'forget',
  'Delete a memory and its relations. Also removes the corresponding markdown file.',
  {
    id: z.string().uuid().describe('Entity ID to delete'),
  },
  async ({ id }) => {
    // Fetch entity for file removal before deleting
    const [entity] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, id))
      .limit(1);

    if (!entity) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Not found' }) }],
      };
    }

    // Delete from Postgres (cascades relations)
    await db.delete(entities).where(eq(entities.id, id));

    // Remove markdown file
    removeFile({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      observations: (entity.observations as string) || '',
      temperature: entity.temperature ?? 1.0,
      tier: entity.tier ?? 'HOT',
      source: entity.source,
    });

    logEvent('forget', id, { name: entity.name });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: true, name: entity.name }),
        },
      ],
    };
  },
);

// ── update ─────────────────────────────────────────────────────────────────

server.tool(
  'update',
  'Modify an existing memory. Partial update — only provided fields are changed.',
  {
    id: z.string().uuid().describe('Entity ID to update'),
    name: z.string().optional().describe('New name'),
    observations: z.string().optional().describe('New observations'),
    tags: z.array(z.string()).optional().describe('New tags'),
    importance: z.number().min(0).max(1).optional().describe('New importance'),
    type: z.enum(MEMORY_TYPES).optional().describe('New type'),
  },
  async ({ id, name, observations, tags, importance, type }) => {
    const updates: Record<string, unknown> = {};
    const updatedFields: string[] = [];

    if (name !== undefined) { updates.name = name; updatedFields.push('name'); }
    if (observations !== undefined) { updates.observations = observations; updatedFields.push('observations'); }
    if (tags !== undefined) { updates.tags = tags; updatedFields.push('tags'); }
    if (importance !== undefined) { updates.importance = importance; updatedFields.push('importance'); }
    if (type !== undefined) { updates.type = type; updatedFields.push('type'); }
    updates.originHost = hostname();

    if (updatedFields.length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No fields to update' }) }],
      };
    }

    // Snapshot current state before applying changes
    try {
      await snapshotVersion(id);
    } catch {
      // Non-fatal: version history failure shouldn't block update
    }

    const [updated] = await db
      .update(entities)
      .set(updates)
      .where(eq(entities.id, id))
      .returning();

    if (!updated) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Not found' }) }],
      };
    }

    // Bump temperature on update
    await bump(id);

    // Re-read to get post-bump state for accurate markdown sync
    const [current] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, id))
      .limit(1);

    // Sync to markdown with accurate temperature/tier
    syncToFile({
      id: current.id,
      name: current.name,
      type: current.type,
      observations: (current.observations as string) || '',
      temperature: current.temperature ?? 1.0,
      tier: current.tier ?? 'HOT',
      source: current.source,
      importance: current.importance ?? 0.5,
      accessCount: current.accessCount ?? 0,
      originHost: current.originHost ?? hostname(),
    });

    logEvent('update', id, { updatedFields });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ id: current.id, name: current.name, updated_fields: updatedFields }),
        },
      ],
    };
  },
);

// ── relate ─────────────────────────────────────────────────────────────────

server.tool(
  'relate',
  'Link two memories with a typed relation. Valid types: related_to, supersedes, contradicts, elaborates, depends_on.',
  {
    fromId: z.string().uuid().describe('Source entity ID'),
    toId: z.string().uuid().describe('Target entity ID'),
    relationType: z.enum(RELATION_TYPES as unknown as [string, ...string[]]).describe('Relation type'),
    weight: z.number().min(0).max(1).optional().describe('Relation strength (default 1.0)'),
  },
  async ({ fromId, toId, relationType, weight }) => {
    const [relation] = await db
      .insert(memoryRelations)
      .values({
        fromId,
        toId,
        relationType,
        weight: weight ?? 1.0,
      })
      .returning();

    logEvent('relate', fromId, { toId, relationType, weight: weight ?? 1.0 });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ id: relation.id, relationType: relation.relationType }),
        },
      ],
    };
  },
);

// ── status ─────────────────────────────────────────────────────────────────

server.tool(
  'status',
  'Memory dashboard: total count, tier breakdown, type breakdown, hottest and coldest memories.',
  {},
  async () => {
    // Total count
    const [{ value: total }] = await db.select({ value: count() }).from(entities);

    // By tier
    const tierCounts = await db
      .select({ tier: entities.tier, count: count() })
      .from(entities)
      .groupBy(entities.tier);

    const byTier: Record<string, number> = {};
    for (const row of tierCounts) {
      byTier[row.tier ?? 'UNKNOWN'] = row.count;
    }

    // By type
    const typeCounts = await db
      .select({ type: entities.type, count: count() })
      .from(entities)
      .groupBy(entities.type);

    const byType: Record<string, number> = {};
    for (const row of typeCounts) {
      byType[row.type] = row.count;
    }

    // Hottest
    const hottest = await db
      .select({ id: entities.id, name: entities.name, temperature: entities.temperature, tier: entities.tier })
      .from(entities)
      .orderBy(desc(entities.temperature))
      .limit(STATUS_TOP_N);

    // Coldest
    const coldest = await db
      .select({ id: entities.id, name: entities.name, temperature: entities.temperature, tier: entities.tier })
      .from(entities)
      .orderBy(asc(entities.temperature))
      .limit(STATUS_TOP_N);

    // Stale count (COLD for 30+ days)
    const [{ value: staleCount }] = await db
      .select({ value: count() })
      .from(entities)
      .where(eq(entities.stale, true));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ total, byTier, byType, hottest, coldest, staleCount }, null, 2),
        },
      ],
    };
  },
);

// ── graph ─────────────────────────────────────────────────────────────────

server.tool(
  'graph',
  'Visualize the memory graph as a Mermaid flowchart. Nodes show name and type, colored by thermal tier. Edges show relation types.',
  {},
  async () => {
    const allEntities = await db
      .select({
        id: entities.id,
        name: entities.name,
        type: entities.type,
        tier: entities.tier,
        temperature: entities.temperature,
      })
      .from(entities);

    const allRelations = await db
      .select({
        fromId: memoryRelations.fromId,
        toId: memoryRelations.toId,
        relationType: memoryRelations.relationType,
      })
      .from(memoryRelations);

    if (allEntities.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No memories found.' }],
      };
    }

    const lines: string[] = ['flowchart LR'];
    lines.push('  classDef hot fill:#ff6b6b,stroke:#c0392b,color:#fff');
    lines.push('  classDef warm fill:#f39c12,stroke:#e67e22,color:#fff');
    lines.push('  classDef cold fill:#3498db,stroke:#2980b9,color:#fff');

    const idMap = new Map<string, string>();
    for (const e of allEntities) {
      const shortId = e.id.replace(/-/g, '').slice(0, 8);
      idMap.set(e.id, shortId);
      // Escape quotes and limit label length
      const safeName = (e.name || '').replace(/"/g, "'").slice(0, 40);
      const label = `${safeName}\\n(${e.type})`;
      lines.push(`  ${shortId}["${label}"]`);
      const tierClass = (e.tier || 'COLD').toLowerCase();
      lines.push(`  class ${shortId} ${tierClass}`);
    }

    for (const r of allRelations) {
      const from = idMap.get(r.fromId);
      const to = idMap.get(r.toId);
      if (from && to) {
        lines.push(`  ${from} -->|${r.relationType}| ${to}`);
      }
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

// ── traverse ──────────────────────────────────────────────────────────────

server.tool(
  'traverse',
  'Multi-hop graph traversal from a starting memory. Explores connected memories breadth-first and returns nodes, edges, and a Mermaid diagram.',
  {
    id: z.string().uuid().describe('Starting memory ID'),
    depth: z.number().min(1).max(5).optional().describe('Max hops to traverse (1-5, default 2)'),
    relationTypes: z
      .array(z.enum(RELATION_TYPES as unknown as [string, ...string[]]))
      .optional()
      .describe('Only follow these relation types (default: all)'),
  },
  async ({ id, depth, relationTypes }) => {
    const result = await traverse(id, { depth, relationTypes });

    logEvent('traverse', id, { depth: depth ?? 2, nodeCount: result.nodes.length });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              nodeCount: result.nodes.length,
              edgeCount: result.edges.length,
              nodes: result.nodes,
              edges: result.edges,
            },
            null,
            2,
          ),
        },
        {
          type: 'text' as const,
          text: result.mermaid,
        },
      ],
    };
  },
);

// ── history ──────────────────────────────────────────────────────────────

server.tool(
  'history',
  'View the version history of a memory. Shows previous states before each update.',
  {
    id: z.string().uuid().describe('Memory ID to get history for'),
  },
  async ({ id }) => {
    const versions = await getHistory(id);

    logEvent('history', id, { versionCount: versions.length });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ memoryId: id, versions, count: versions.length }, null, 2),
        },
      ],
    };
  },
);

// ── merge ────────────────────────────────────────────────────────────────

server.tool(
  'merge',
  'Merge two memories: appends observations, unions tags, keeps higher importance, transfers edges, deletes source.',
  {
    sourceId: z.string().uuid().describe('Memory to merge FROM (will be deleted)'),
    targetId: z.string().uuid().describe('Memory to merge INTO (will be kept)'),
  },
  async ({ sourceId, targetId }) => {
    try {
      // Source row is deleted by mergeMemories — capture identity first so its
      // markdown orphan can be cleared (issue #15).
      const [src] = await db
        .select()
        .from(entities)
        .where(eq(entities.id, sourceId))
        .limit(1);

      const result = await mergeMemories(sourceId, targetId);

      logEvent('merge', targetId, { sourceId, edgesTransferred: result.edgesTransferred });

      // Re-read target for file sync
      const [current] = await db
        .select()
        .from(entities)
        .where(eq(entities.id, targetId))
        .limit(1);

      // src and current are both guaranteed: mergeMemories throws "Memory not
      // found" if either row is missing (intelligence.ts), so reaching here
      // means both SELECTs returned a row.
      if (src && current) {
        syncMerge(
          {
            id: src.id,
            name: src.name,
            type: src.type,
            source: src.source,
            observations: '',
            temperature: 0,
            tier: '',
          },
          {
            id: current.id,
            name: current.name,
            type: current.type,
            observations: (current.observations as string) || '',
            temperature: current.temperature ?? 1.0,
            tier: current.tier ?? 'HOT',
            source: current.source,
            importance: current.importance ?? 0.5,
            accessCount: current.accessCount ?? 0,
            originHost: current.originHost ?? hostname(),
          },
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: (err as Error).message }),
          },
        ],
      };
    }
  },
);

// ── conflicts ────────────────────────────────────────────────────────────

server.tool(
  'conflicts',
  'List all pairs of memories connected by a "contradicts" edge. Useful for resolving conflicting knowledge.',
  {},
  async () => {
    const conflicts = await getConflicts();

    logEvent('conflicts', null, { count: conflicts.length });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ count: conflicts.length, conflicts }, null, 2),
        },
      ],
    };
  },
);

// ── analytics ────────────────────────────────────────────────────────────

server.tool(
  'analytics',
  'Usage analytics: recall hit rate, top accessed memories, temperature distribution, events per day, graph density.',
  {},
  async () => {
    const analytics = await getAnalytics();

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(analytics, null, 2),
        },
      ],
    };
  },
);

// ── health ──────────────────────────────────────────────────────────────

server.tool(
  'health',
  'System health: orphan memories, stale count, dedup candidates, contradictions, type coverage.',
  {},
  async () => {
    const health = await getHealth();

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(health, null, 2),
        },
      ],
    };
  },
);

// ── Start server ───────────────────────────────────────────────────────────

async function main() {
  // Verify database connectivity before accepting tool calls
  await db.execute(sql`SELECT 1`);

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
