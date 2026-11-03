/**
 * Tool registration for the memory-persistor MCP server. Importing this
 * module has NO side effects beyond src/db.ts building (not connecting) its
 * pool — no server, no stdio, no main(). That is what makes every handler
 * reachable from tests through a real MCP Client; see
 * tests/integration/mcp-harness.ts.
 *
 * Env loading is owned by src/db.ts. Do NOT add `import 'dotenv/config'`
 * here — see src/mcp-server.ts's docblock for the 2026-04-07 incident.
 */
import { hostname } from 'node:os';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from './db.js';
import { entities, memoryRelations } from './schema.js';
import { and, eq, sql } from 'drizzle-orm';
import { recall, recallByIds, shouldAutoRelate } from './retrieve.js';
import { bump } from './thermal.js';
import { syncToFile, removeFile, syncMerge, assertMemoryNameIsTitle } from './file-sync.js';
import { assertClaimsAccepted, claimFlags, isVolatile, withVolatileTag, VOLATILE_TAG } from './claim-contract.js';
import {
  MEMORY_TYPES,
  AUTO_RELATE_LIMIT,
  PENDING_CATEGORIES,
  PENDING_PRIORITIES,
  PENDING_STATUSES,
  PENDING_BRIEF_LIMIT,
  RESPONSE_JSON_INDENT,
  TOOLSETS,
  parseToolsets,
} from './config.js';
import { addPending, listPending, resolvePending, updatePending } from './pending.js';
import { embedForWrite, resolveEmbeddingForTextChange, resolveUpdateEmbeddingText } from './embed.js';
import { traverse, detectRelationType, isValidRelationType, RELATION_TYPES, renderGraphMermaid } from './graph.js';
import {
  findDedupCandidates,
  snapshotVersionSafe,
  getHistory,
  mergeMemories,
  getConflicts,
} from './intelligence.js';
import { logEvent, logFailure } from './events.js';
import { registerResources } from './mcp-resources.js';
import { registerPrompts } from './mcp-prompts.js';
import { getAnalytics, getHealth, getStatus } from './observability.js';
import {
  CategorizedError,
  classifyError,
  runNonFatal,
  toErrorResult,
  type ErrorResult,
  type NonFatalWarning,
} from './errors.js';


// Row shape needed for markdown sync (file-sync.ts's MemoryEntity) — excludes
// embedding (384 floats), which syncToFile/syncMerge/removeFile never read.
// Shared by forget, update, and merge's re-reads below.
export const SYNC_COLUMNS = {
  id: entities.id,
  name: entities.name,
  type: entities.type,
  observations: entities.observations,
  temperature: entities.temperature,
  tier: entities.tier,
  source: entities.source,
  importance: entities.importance,
  accessCount: entities.accessCount,
  originHost: entities.originHost,
};

export function registerTools(server: McpServer): Map<string, RegisteredTool> {
  // Every registration goes through `reg`, which keeps the returned handle so
  // createServer can remove tools outside the selected toolsets.
  const handles = new Map<string, RegisteredTool>();
  const reg: McpServer['registerTool'] = (name, config, cb) => {
    const handle = server.registerTool(name, config, cb);
    handles.set(name, handle);
    return handle;
  };

  // ── remember ───────────────────────────────────────────────────────────────

  reg(
    'remember',
    {
      description:
        'Store a new memory with tags, type, and importance. Use this to persist knowledge, decisions, user preferences, or patterns. Record conclusions, not logs: a body that reads as a conversation transcript (4+ "User:"/"Assistant:"/"Human:" lines outside code blocks) is rejected. A body stating a volatile figure (size, percentage, duration, count) with no date is still stored, but tagged "volatile" and reported in a `flags` field — add the date it was true to clear it.',
      inputSchema: {
        name: z.string().trim().min(1).describe('Human-readable title, e.g. "API merge 405 means merged". NOT a filename stem — a name like "feedback_foo_bar" is rejected.'),
        type: z.enum(MEMORY_TYPES).describe('Memory category'),
        observations: z.string().describe('Full content of the memory'),
        tags: z.array(z.string()).describe('Search tags (e.g., ["python", "preference"]). "volatile" is server-managed: it is set or cleared from the body, whatever you pass.'),
        importance: z.number().min(0).max(1).describe('How critical this memory is (0.0-1.0)'),
        source: z.string().optional().describe('Project CWD path (defaults to env)'),
        relatedTo: z.string().uuid().optional().describe('Existing entity ID to link to'),
      },
    },
    withErrorContract('remember', async ({ name, type, observations, tags, importance, source, relatedTo }) => {
      // Reject a filename stem pasted in as a name. Checked before
      // embedForWrite so a rejected write never pays for an ONNX inference.
      assertMemoryNameIsTitle(name);

      // Claim contract: a transcript is rejected before anything is
      // written; an undated volatile figure is tagged and reported, never blocked.
      const claims = assertClaimsAccepted(observations);
      const storedTags = withVolatileTag(tags, claims.volatile);

      // Validate the link target BEFORE any write. Checked after the insert, an
      // unknown id failed the call with the memory already stored, so a caller
      // following the contract ("validation: fix the input") stored it twice.
      if (relatedTo) {
        const [target] = await db
          .select({ id: entities.id })
          .from(entities)
          .where(eq(entities.id, relatedTo))
          .limit(1);
        if (!target) throw new CategorizedError('validation', `relatedTo: no memory with id ${relatedTo}`);
      }

      const entitySource = source || process.env.MEMORY_PERSISTOR_DIR || process.cwd();
      const embedding = await embedForWrite(name, observations);

      const [entity] = await db
        .insert(entities)
        .values({
          name,
          type,
          observations,
          tags: storedTags,
          source: entitySource,
          importance,
          temperature: 1.0,
          tier: 'HOT',
          accessCount: 0,
          originHost: hostname(),
          embedding,
        })
        .returning({ id: entities.id, name: entities.name });

      // Every step below runs AFTER the row exists, so none may fail the call:
      // a failure there invites a retry that stores the memory twice. Failures
      // surface in `warnings` instead.
      const warnings: NonFatalWarning[] = [];

      // Dual-write to markdown
      await runNonFatal('file_sync', () =>
        syncToFile({
          id: entity.id,
          name: entity.name,
          type,
          observations: observations || '',
          temperature: 1.0,
          tier: 'HOT',
          source: entitySource,
          importance,
          accessCount: 0,
          originHost: hostname(),
        }), warnings);

      // Create relation if specified (target existence was checked before the insert)
      if (relatedTo) {
        await runNonFatal('related_to', () =>
          db.insert(memoryRelations).values({
            fromId: entity.id,
            toId: relatedTo,
            relationType: 'related_to',
            provenance: 'asserted',
          }).onConflictDoNothing(), warnings);
      }

      // ── Auto-relate: find existing memories similar to the new one ──────
      await runNonFatal('auto_relate', async () => {
        // Full mode (not summary) here: detectRelationType below needs the match's
        // observations for its trigram contradicts/elaborates signal. This recall is
        // internal (<=3 rows, never serialized to the harness), so summary saves nothing
        // but would zero out obsSim and mislabel similar memories as "contradicts".
        const autoRelatedRes = await recall({
          query: `${name} ${(observations || '').slice(0, 200)}`,
          limit: AUTO_RELATE_LIMIT,
          // embedForWrite already embedded this same text a few lines up for the
          // write-path vector — a second embedForQuery call here would be pure
          // redundant inference, and would force ad-hoc (write-disabled)
          // machines to load the ONNX runtime on every remember, not just on an
          // explicit recall (see RecallOptions.skipSemantic).
          skipSemantic: true,
        });
        const autoRelated = autoRelatedRes.results;

        for (const match of autoRelated) {
          if (match.id === entity.id) continue;
          if (relatedTo && match.id === relatedTo) continue;
          if (!shouldAutoRelate(match)) continue;

          // Auto-detect relation type using trigram similarity on name/observations
          const detectedType = await detectRelationType(
            { id: entity.id, name, type, observations },
            { id: match.id, name: match.name, type: match.type, observations: (match as { observations?: string }).observations ?? '' },
          );

          await db.insert(memoryRelations).values({
            fromId: entity.id,
            toId: match.id,
            relationType: detectedType,
            provenance: 'inferred',
          }).onConflictDoNothing();
        }
      }, warnings);

      // ── Dedup check: surface near-duplicates for the caller to decide ──────
      const dedup_candidates =
        (await runNonFatal('dedup', () => findDedupCandidates(entity.id, name, observations, type), warnings)) ?? [];

      const result: Record<string, unknown> = {
        id: entity.id,
        name: entity.name,
        tier: 'HOT',
        origin_host: hostname(),
      };
      const flags = claimFlags(claims.volatile);
      if (flags.length > 0) result.flags = flags;
      if (dedup_candidates.length > 0) {
        result.dedup_candidates = dedup_candidates;
        logEvent('dedup_detected', entity.id, { candidates: dedup_candidates.length });
      }

      if (warnings.length > 0) {
        result.warnings = warnings;
      }
      logWarnings('remember', entity.id, warnings);

      logEvent('remember', entity.id, { type, tags: storedTags, importance });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    }),
  );

  // ── recall ─────────────────────────────────────────────────────────────────

  reg(
    'recall',
    {
      description:
        'Search memories using full-text search, tag matching, and thermal scoring. Returns the most relevant memories. Pass output_mode="summary" for a lean projection (no observations body, related[] capped with related_total when capped) to triage under the harness token budget; then use recall_by_ids to fetch full bodies for the ids you want. Response is {results, total_matches, truncated, degraded_to_summary}; total_matches counts candidates after limit (not the whole corpus), truncated means the 30 KB cap trimmed rows, degraded_to_summary means full mode fell back to summary because a row exceeded the cap. Results come in two groups: a memory superseded by another (an asserted supersedes edge) is listed after every live result regardless of score, and carries superseded_by: [{id, name}] naming its replacement — read that one instead.',
      inputSchema: {
        query: z.string().describe('Search query text'),
        type: z.enum(MEMORY_TYPES).optional().describe('Filter by memory type'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        tier: z.enum(['HOT', 'WARM', 'COLD']).optional().describe('Filter by thermal tier'),
        limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
        output_mode: z.enum(['full', 'summary']).optional().describe('Projection: "full" (default) returns observations bodies and every related edge; "summary" returns lean triage rows with at most 5 related edges — when more exist, related_total gives the true count and traverse fetches the rest'),
      },
    },
    withErrorContract('recall', async ({ query, type, tags, tier, limit, output_mode }) => {
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
    }),
  );

  // ── recall_by_ids ────────────────────────────────────────────────────────────

  reg(
    'recall_by_ids',
    {
      description:
        'Fetch full memory bodies for specific ids (no search/scoring). Use after a summary-mode recall to drill into the memories you chose. Preserves input order, omits unknown ids, honors output_mode and the response cap. A superseded memory carries superseded_by: [{id, name}].',
      inputSchema: {
        ids: z.array(z.string().uuid()).min(1).max(50).describe('Memory ids (uuids) to fetch, in the order to return them'),
        output_mode: z.enum(['full', 'summary']).optional().describe('Projection: "full" (default) returns observations bodies and every related edge; "summary" returns lean rows with at most 5 related edges — when more exist, related_total gives the true count and traverse fetches the rest'),
      },
    },
    withErrorContract('recall_by_ids', async ({ ids, output_mode }) => {
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
    }),
  );

  // ── forget ─────────────────────────────────────────────────────────────────

  reg(
    'forget',
    {
      description:
        'Delete a memory and its relations. Also removes the corresponding markdown file.',
      inputSchema: {
        id: z.string().uuid().describe('Entity ID to delete'),
      },
    },
    withErrorContract('forget', async ({ id }) => {
      // Fetch entity for file removal before deleting
      const [entity] = await db
        .select(SYNC_COLUMNS)
        .from(entities)
        .where(eq(entities.id, id))
        .limit(1);

      if (!entity) {
        throw new CategorizedError('validation', `No memory with id ${id}`);
      }

      // Delete from Postgres (cascades relations)
      await db.delete(entities).where(eq(entities.id, id));

      // Remove markdown file. The row is already gone, so a failure here must not
      // fail the call — a retry would only report "no memory with id".
      const warnings: NonFatalWarning[] = [];
      await runNonFatal('file_sync', () =>
        removeFile({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          observations: (entity.observations as string) || '',
          temperature: entity.temperature ?? 1.0,
          tier: entity.tier ?? 'HOT',
          source: entity.source,
        }), warnings);

      logEvent('forget', id, { name: entity.name });
      logWarnings('forget', id, warnings);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, name: entity.name, ...(warnings.length > 0 ? { warnings } : {}) }),
          },
        ],
      };
    }),
  );

  // ── update ─────────────────────────────────────────────────────────────────

  reg(
    'update',
    {
      description:
        'Modify an existing memory. Partial update — only provided fields are changed. `append_observations` adds text to the end of the stored body (server-side, after a blank line) instead of replacing it; it cannot be combined with `observations`. An append is neither atomic nor idempotent: concurrent appends are last-writer-wins, and a retry after a transient error can append twice — check the body before retrying. A new body (an append is judged as the whole body it produces) is re-checked like `remember`: a transcript is rejected, an undated volatile figure is tagged "volatile" and reported in `flags`, and adding a date clears the tag. A tags-only update re-derives "volatile" from the stored body and can also return `flags`.',
      inputSchema: {
        id: z.string().uuid().describe('Entity ID to update'),
        name: z.string().trim().min(1).optional().describe('New human-readable title. NOT a filename stem — a name like "feedback_foo_bar" is rejected.'),
        observations: z.string().optional().describe('New observations'),
        append_observations: z
          .string()
          .refine((s) => s.trim().length > 0, 'append_observations must not be blank')
          .optional()
          .describe('Text appended verbatim to the stored body after a blank line. Grows a long memory without resending it. Mutually exclusive with observations.'),
        tags: z.array(z.string()).optional().describe('New tags. "volatile" is server-managed: it follows the body, whatever you pass.'),
        importance: z.number().min(0).max(1).optional().describe('New importance'),
        type: z.enum(MEMORY_TYPES).optional().describe('New type'),
      },
    },
    withErrorContract('update', async ({ id, name, observations, append_observations: append, tags, importance, type }) => {
      const updates: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      if (name !== undefined) { updates.name = name; updatedFields.push('name'); }
      if (observations !== undefined && append !== undefined) {
        throw new CategorizedError('validation', 'Pass observations OR append_observations, not both.');
      }
      if (observations !== undefined || append !== undefined) updatedFields.push('observations');
      if (tags !== undefined) { updates.tags = tags; updatedFields.push('tags'); }
      if (importance !== undefined) { updates.importance = importance; updatedFields.push('importance'); }
      if (type !== undefined) { updates.type = type; updatedFields.push('type'); }
      updates.originHost = hostname();

      if (updatedFields.length === 0) {
        throw new CategorizedError(
          'validation',
          'No fields to update — pass at least one of name, observations, append_observations, tags, importance, type.',
        );
      }

      // Claim contract, only when the body changes. Checked before the
      // row lookup: a rejected body never costs a query. An append's own text
      // is checked here too, so a stored body ending in an unclosed fence
      // cannot hide it; the body it produces is checked after the lookup.
      const replaced = observations !== undefined ? assertClaimsAccepted(observations) : null;
      if (append !== undefined) assertClaimsAccepted(append);

      // Resolve the row up front. Two jobs, one query:
      //   1. Fail fast on an unknown id, BEFORE resolveEmbeddingForTextChange
      //      below runs a local ONNX inference that can only be thrown away.
      //   2. Supply the unchanged half of name/observations to the embedding
      //      block, which used to issue this same SELECT itself.
      const [existing] = await db
        .select({ name: entities.name, observations: entities.observations, tags: entities.tags })
        .from(entities)
        .where(eq(entities.id, id))
        .limit(1);

      if (!existing) {
        throw new CategorizedError('validation', `No memory with id ${id}`);
      }

      // An append becomes the full body it produces (one blank line after the
      // stored body's trailing whitespace; a blank stored body takes the text
      // alone), and from here on is a plain replacement. Read-modify-write: two
      // concurrent appends to one memory are last-writer-wins, as every other
      // field of this handler already is, and a retry after a transient error
      // that landed post-commit appends twice.
      const stored = existing.observations?.trimEnd() ?? '';
      const appended = append !== undefined ? (stored ? `${stored}\n\n${append}` : append) : undefined;
      const body = appended ?? observations;
      if (body !== undefined) updates.observations = body;
      const claims = appended !== undefined ? assertClaimsAccepted(appended) : replaced;

      // The flag follows the body, in BOTH directions, whichever of body and
      // tags this call changes: a new body re-derives it, and a tags-only call
      // re-derives it from the stored body, so a caller can neither drop the
      // flag from an undated body nor pin it on a dated one.
      let volatile = false;
      if (claims || tags !== undefined) {
        volatile = claims ? claims.volatile : isVolatile(existing.observations ?? '');
        const base = tags ?? existing.tags ?? [];
        const flagMoves = base.includes(VOLATILE_TAG) !== volatile;
        if (tags !== undefined || flagMoves) {
          updates.tags = withVolatileTag(base, volatile);
          if (tags === undefined) updatedFields.push('tags');
        }
      }

      // Same guard as `remember` — update is the other path that can set a name, so
      // leaving it unguarded would just move the defect.
      //
      // Deliberately placed AFTER the row lookup and scoped to an actual RENAME.
      // Checking `name !== undefined` alone would reject a caller re-sending an
      // entity's CURRENT name alongside new observations, which is a normal pattern —
      // and would make the nine already-malformed entities partially un-updatable,
      // including by the tooling meant to rename them.
      if (name !== undefined && name !== existing.name) {
        assertMemoryNameIsTitle(name);
      }

      // Embedding text is name+observations (spec §4.3) — recompute only when
      // either changed. resolveEmbeddingForTextChange decides invalidate (gate
      // off) vs recompute vs preserve-on-transient-failure (undefined = leave
      // updates.embedding unset, so the column is untouched).
      if (name !== undefined || body !== undefined) {
        const text = resolveUpdateEmbeddingText(name, body, existing);
        const embedding = await resolveEmbeddingForTextChange(text.name, text.observations);
        if (embedding !== undefined) {
          updates.embedding = embedding;
        }
      }

      // Snapshot current state before applying changes.
      //
      // Non-fatal by design — a history-write failure must not block the user's
      // edit — but NOT silent: snapshotVersionSafe logs the id and the cause to
      // stderr. The bare `catch {}` this replaces destroyed edit history with no
      // trace, which is what made "zero version rows" look like evidence that a
      // memory had never been edited.
      // The result is carried into logEvent and the tool response below. stderr
      // alone would be ephemeral and invisible to the caller — and the lost-history fix is
      // precisely about a lost snapshot being undetectable after the fact.
      const historyRecorded = await snapshotVersionSafe(id);

      const [updated] = await db
        .update(entities)
        .set(updates)
        .where(eq(entities.id, id))
        .returning({ id: entities.id, name: entities.name });

      if (!updated) {
        throw new CategorizedError('validation', `Memory ${id} was deleted while this update ran`);
      }

      // Everything below runs AFTER the UPDATE landed, so none of it may fail
      // the call: a retry would snapshot and bump a second time.
      const warnings: NonFatalWarning[] = [];

      // Bump temperature on update
      await runNonFatal('bump', () => bump(id), warnings);

      // Re-read the post-bump state and sync it to markdown.
      await runNonFatal('file_sync', async () => {
        const [current] = await db
          .select(SYNC_COLUMNS)
          .from(entities)
          .where(eq(entities.id, id))
          .limit(1);
        if (!current) throw new CategorizedError('validation', `Memory ${id} was deleted before its markdown could sync`);
        await syncToFile({
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
      }, warnings);

      logEvent('update', id, { updatedFields, historyRecorded });
      logWarnings('update', id, warnings);

      // history_recorded is surfaced ONLY when false. Callers get a quiet success
      // in the normal case, and a lost snapshot becomes something the caller can
      // actually see rather than a stderr line nobody reads.
      const payload: Record<string, unknown> = {
        id,
        name: updated.name,
        updated_fields: updatedFields,
      };
      if (!historyRecorded) {
        payload.history_recorded = false;
      }
      // Reported whenever this call re-derived the flag, so a caller who sees
      // 'tags' in updated_fields also sees why.
      const flags = claimFlags(volatile);
      if (flags.length > 0) payload.flags = flags;
      if (warnings.length > 0) {
        payload.warnings = warnings;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(payload),
          },
        ],
      };
    }),
  );

  // ── relate ─────────────────────────────────────────────────────────────────

  reg(
    'relate',
    {
      description:
        'Link two memories with a typed relation. Valid types: related_to, supersedes, contradicts, elaborates, depends_on. A self-link is rejected. If an edge of that type from fromId to toId already exists, it is returned with existing: true (marked asserted, weight updated only if passed) instead of writing a duplicate; the reverse direction is a separate edge.',
      inputSchema: {
        fromId: z.string().uuid().describe('Source entity ID'),
        toId: z.string().uuid().describe('Target entity ID'),
        relationType: z.enum(RELATION_TYPES as unknown as [string, ...string[]]).describe('Relation type'),
        weight: z.number().min(0).max(1).optional().describe('Relation strength (default 1.0)'),
      },
    },
    withErrorContract('relate', async ({ fromId, toId, relationType, weight }) => {
      // Lower-cased: zod's uuid() accepts either case and Postgres compares uuids case-blind.
      if (fromId.toLowerCase() === toId.toLowerCase()) {
        throw new CategorizedError('validation', 'relate: fromId and toId are the same memory');
      }

      // A repeat claim re-asserts the existing edge (an inferred one is
      // upgraded) rather than adding a second row that would double-count in
      // centrality. Directional: B→A is a different edge from A→B, even for
      // related_to. The unique (from, to, type) index (drizzle/0017) settles a
      // race: when a concurrent identical relate inserts first, ours does
      // nothing and the re-assert below runs on the winner's row. ON CONFLICT
      // names no target, so this is also valid against a database without it.
      const sameEdge = and(
        eq(memoryRelations.fromId, fromId),
        eq(memoryRelations.toId, toId),
        eq(memoryRelations.relationType, relationType),
      );
      const reassert = () => db
        .update(memoryRelations)
        .set({ provenance: 'asserted', ...(weight === undefined ? {} : { weight }) })
        .where(sameEdge)
        .returning();
      let [relation] = await reassert();
      let reused = relation !== undefined;
      if (!relation) {
        [relation] = await db
          .insert(memoryRelations)
          .values({
            fromId,
            toId,
            relationType,
            weight: weight ?? 1.0,
            provenance: 'asserted',
          })
          .onConflictDoNothing()
          .returning();
      }
      if (!relation) {
        [relation] = await reassert();
        reused = true;
      }
      if (!relation) {
        // The row our insert conflicted with was removed (an endpoint deleted)
        // before the re-assert could read it.
        throw new CategorizedError('transient', 'relate: the edge changed concurrently; retry');
      }

      logEvent('relate', fromId, { toId, relationType, weight: relation.weight, existing: reused });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ id: relation.id, relationType: relation.relationType, existing: reused }),
          },
        ],
      };
    }),
  );

  // ── status ─────────────────────────────────────────────────────────────────

  reg(
    'status',
    {
      description:
        'Memory dashboard: total count, tier breakdown, type breakdown, hottest and coldest memories.',
      inputSchema: {},
    },
    withErrorContract('status', async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(await getStatus(), null, RESPONSE_JSON_INDENT) }],
    })),
  );

  // ── graph ─────────────────────────────────────────────────────────────────

  reg(
    'graph',
    {
      description:
        'Visualize the memory graph as a Mermaid flowchart. Nodes show name and type, colored by thermal tier. Edges show relation types.',
      inputSchema: {},
    },
    withErrorContract('graph', async () => ({
      content: [{ type: 'text' as const, text: await renderGraphMermaid() }],
    })),
  );

  // ── traverse ──────────────────────────────────────────────────────────────

  reg(
    'traverse',
    {
      description:
        'Multi-hop graph traversal from a starting memory. Explores connected memories breadth-first and returns nodes, edges, and a Mermaid diagram.',
      inputSchema: {
        id: z.string().uuid().describe('Starting memory ID'),
        depth: z.number().min(1).max(5).optional().describe('Max hops to traverse (1-5, default 2)'),
        relationTypes: z
          .array(z.enum(RELATION_TYPES as unknown as [string, ...string[]]))
          .optional()
          .describe('Only follow these relation types (default: all)'),
      },
    },
    withErrorContract('traverse', async ({ id, depth, relationTypes }) => {
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
    }),
  );

  // ── history ──────────────────────────────────────────────────────────────

  reg(
    'history',
    {
      description:
        'View the version history of a memory. Shows previous states before each update.',
      inputSchema: {
        id: z.string().uuid().describe('Memory ID to get history for'),
      },
    },
    withErrorContract('history', async ({ id }) => {
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
    }),
  );

  // ── merge ────────────────────────────────────────────────────────────────

  reg(
    'merge',
    {
      description:
        'Merge two memories: appends observations, unions tags, keeps higher importance, transfers edges, deletes source.',
      inputSchema: {
        sourceId: z.string().uuid().describe('Memory to merge FROM (will be deleted)'),
        targetId: z.string().uuid().describe('Memory to merge INTO (will be kept)'),
      },
    },
    withErrorContract('merge', async ({ sourceId, targetId }) => {
      // Source row is deleted by mergeMemories — capture identity first so its
      // markdown orphan can be cleared.
      const [src] = await db
        .select(SYNC_COLUMNS)
        .from(entities)
        .where(eq(entities.id, sourceId))
        .limit(1);

      const result = await mergeMemories(sourceId, targetId);

      logEvent('merge', targetId, { sourceId, edgesTransferred: result.edgesTransferred });

      // The merge has committed; everything below (the re-read and the markdown
      // reconciliation) is a warning on failure, never a failed call — a retry
      // would only report "Memory not found" for a merge that succeeded.
      const warnings: NonFatalWarning[] = [];
      await runNonFatal('file_sync', async () => {
        const [current] = await db
          .select(SYNC_COLUMNS)
          .from(entities)
          .where(eq(entities.id, targetId))
          .limit(1);

        // mergeMemories throws "Memory not found" if either row was missing, so a
        // gap here means a concurrent delete — reported, never skipped silently.
        if (!src || !current) {
          throw new CategorizedError('validation', `Merge committed but ${!src ? sourceId : targetId} was gone before its markdown could sync`);
        }
        await syncMerge(
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
      }, warnings);
      logWarnings('merge', targetId, warnings);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(warnings.length > 0 ? { ...result, warnings } : result, null, 2),
          },
        ],
      };
    }),
  );

  // ── conflicts ────────────────────────────────────────────────────────────

  reg(
    'conflicts',
    {
      description:
        'List all pairs of memories connected by a "contradicts" edge. Useful for resolving conflicting knowledge.',
      inputSchema: {},
    },
    withErrorContract('conflicts', async () => {
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
    }),
  );

  // ── analytics ────────────────────────────────────────────────────────────

  reg(
    'analytics',
    {
      description:
        'Usage analytics: recall hit rate, top accessed memories, temperature distribution, events per day, graph density.',
      inputSchema: {},
    },
    withErrorContract('analytics', async () => {
      const analytics = await getAnalytics();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(analytics, null, 2),
          },
        ],
      };
    }),
  );

  // ── health ──────────────────────────────────────────────────────────────

  reg(
    'health',
    {
      description:
        'System health: orphan memories, stale count, dedup candidates, contradictions, type coverage, graph shape and the live thermal cutoffs. The orphans, dedupCandidates and graph.hubs lists are capped to keep the response bounded, so each may be a PREFIX — check orphansTruncated, dedupCandidatesTruncated and graph.hubsTruncated before reading a short list as a complete one. orphanCount and dedupCandidateCount are always the exact totals.',
      inputSchema: {},
    },
    withErrorContract('health', async () => {
      const health = await getHealth();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(health, null, RESPONSE_JSON_INDENT),
          },
        ],
      };
    }),
  );

  // ── pending_add ──────────────────────────────────────────────────────────

  reg(
    'pending_add',
    {
      description:
        'Add an item to the pending work queue. Use this instead of appending to pending.md when deferring an improvement. ' +
          'Items are fleet-wide by default; set appliesTo to narrow one to specific machines.',
      inputSchema: {
        title: z.string().min(1).describe('Short one-line title — this is what the session brief shows'),
        category: z.enum(PENDING_CATEGORIES).describe('skill | rule | automation | knowledge'),
        body: z.string().optional().describe('Full description — never injected into the session brief'),
        priority: z.enum(PENDING_PRIORITIES).optional().describe('low | medium | high (default medium)'),
        source: z.string().optional().describe('Project CWD where the item was raised (defaults to server cwd)'),
        appliesTo: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Hostnames this item is TRUE on, e.g. ["server-b"]. Omit or pass [] for fleet-wide, which is ' +
              'the default. This is NOT originHost (which records the machine that WROTE the item) — a ' +
              'finding written on one machine is often fleet-wide. Narrow only when the item is genuinely false ' +
              'elsewhere, because pending_list hides off-host items by default.',
          ),
      },
    },
    withErrorContract('pending_add', async ({ title, category, body, priority, source, appliesTo }) => {
      const row = await addPending({ title, category, body, priority, source, appliesTo });

      logEvent('pending_add', null, { pendingId: row.id, category, priority: row.priority });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { id: row.id, title: row.title, priority: row.priority, status: row.status, appliesTo: row.appliesTo },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // ── pending_list ─────────────────────────────────────────────────────────

  reg(
    'pending_list',
    {
      description:
        'List pending queue items, priority-ordered (high → low, newest first). Defaults to open items ' +
          'SCOPED TO THIS MACHINE: fleet-wide items plus any narrowed to this host. `total` counts only items ' +
          'in scope. hiddenByHost counts items matching the same status/category filters (not just open ones) ' +
          'that are scoped elsewhere; it is reported even under allHosts. A non-zero count on EVERY machine ' +
          'means an item was scoped to a hostname that does not exist. Pass allHosts to see everything.',
      inputSchema: {
        status: z.enum(PENDING_STATUSES).optional().describe('open (default) | done | archived'),
        category: z.enum(PENDING_CATEGORIES).optional().describe('Filter by category'),
        limit: z.number().int().min(1).max(100).optional().describe(`Max items (default ${PENDING_BRIEF_LIMIT})`),
        titlesOnly: z
          .boolean()
          .optional()
          .describe(
            'Omit bodies — cheap triage projection. When true, every returned item has body set to the ' +
              'empty string regardless of its actual content — this does NOT mean the body is empty, only ' +
              'that it was stripped. Call again without titlesOnly to fetch the full body.',
          ),
        allHosts: z
          .boolean()
          .optional()
          .describe('Ignore host scope and return every machine\'s items (default false)'),
      },
    },
    withErrorContract('pending_list', async ({ status, category, limit, titlesOnly, allHosts }) => {
      const { items, total, hiddenByHost } = await listPending({
        status,
        category,
        limit,
        titlesOnly,
        allHosts,
      });

      // Deliberately no logEvent() call here — pending_list is a read-only
      // observability call. Logging it would write an events row on every
      // session start, keeping the event-freshness signal permanently fresh
      // and silently defeating the write-pipeline check in
      // scripts/events_canary.py.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ total, returned: items.length, hiddenByHost, items }, null, 2),
          },
        ],
      };
    }),
  );

  // ── pending_resolve ──────────────────────────────────────────────────────

  reg(
    'pending_resolve',
    {
      description:
        'Close a pending item, stamping resolved_at and an optional resolution note. ' +
          'Never deletes — status flips back with an UPDATE.',
      inputSchema: {
        id: z.string().uuid().describe('Pending item id'),
        resolution: z.string().optional().describe('What resolved it (commit, PR, decision)'),
        status: z
          .enum(['done', 'archived'])
          .optional()
          .describe(
            'done (default) = finished. archived = dropped without being done ' +
              '(obsolete, superseded, no longer wanted).',
          ),
      },
    },
    withErrorContract('pending_resolve', async ({ id, resolution, status }) => {
      const row = await resolvePending(id, resolution, status);

      if (!row) {
        throw new CategorizedError(
          'business',
          `No open pending item with id ${id} — it does not exist, or it was already closed.`,
        );
      }

      logEvent('pending_resolve', null, { pendingId: row.id });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ id: row.id, title: row.title, status: row.status, resolvedAt: row.resolvedAt }, null, 2),
          },
        ],
      };
    }),
  );

  // ── pending_update ───────────────────────────────────────────────────────

  reg(
    'pending_update',
    {
      description:
        'Correct an open pending item in place. Use this instead of archiving and re-adding — ' +
          'archive+re-add resets created_at, changes the id, and leaves an "archived" row on a ' +
          'problem that was never dropped. Cannot change status; use pending_resolve for that. ' +
          'Pass at least one of title/body/priority/category/appliesTo — omitted fields are left ' +
          'unchanged, body: "" clears the body, and appliesTo: [] widens an item back to fleet-wide.',
      inputSchema: {
        id: z.string().uuid().describe('Pending item id'),
        title: z.string().min(1).optional().describe('Corrected one-line title — what the session brief shows'),
        body: z.string().optional().describe('Corrected full description'),
        priority: z.enum(PENDING_PRIORITIES).optional().describe('low | medium | high'),
        category: z.enum(PENDING_CATEGORIES).optional().describe('skill | rule | automation | knowledge'),
        appliesTo: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Corrected host scope. [] = fleet-wide. This is the field to fix when an item was written ' +
              'as fleet-wide but is only true on one machine (or vice versa) — before this existed the ' +
              'only remedy was archive + re-add.',
          ),
      },
    },
    withErrorContract('pending_update', async ({ id, title, body, priority, category, appliesTo }) => {
      const row = await updatePending(id, { title, body, priority, category, appliesTo });

      if (!row) {
        throw new CategorizedError(
          'business',
          `No open pending item with id ${id} — it does not exist, or it was already closed. ` +
            `Closed items are deliberately not editable.`,
        );
      }

      // Which fields changed, not just that something did. There is no
      // `updated_at` column and no pending_versions table, so this event row is
      // the only trace an in-place edit ever happened.
      const changedFields = Object.entries({ title, body, priority, category, appliesTo })
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      logEvent('pending_update', null, { pendingId: row.id, changedFields });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                id: row.id,
                title: row.title,
                priority: row.priority,
                category: row.category,
                status: row.status,
                appliesTo: row.appliesTo,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );
  return handles;
}

/** One tool_warning event per call that produced warnings; nothing otherwise. */
function logWarnings(tool: string, memoryId: string | null, warnings: NonFatalWarning[]): void {
  if (warnings.length > 0) logEvent('tool_warning', memoryId, { tool, steps: warnings.map((w) => w.step) });
}

/**
 * The single tool-layer catch. Any exception becomes a contract-shaped
 * isError result; nothing a handler throws can leave as a success.
 */
export function withErrorContract<A extends unknown[], R>(
  tool: string,
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | ErrorResult> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      return toErrorResult(logFailure('tool', tool, err));
    }
  };
}

/**
 * Errors the SDK raises BEFORE a handler runs — Zod input validation — never
 * reach withErrorContract. McpServer routes them through its own
 * createToolError(message), which is `private` in the SDK's .d.ts, so it
 * cannot be overridden by a subclass; it is replaced on the instance instead.
 *
 * If a future SDK drops the method, this warns rather than aborting boot: an
 * unshaped validation error is degraded, a dead brain is not.
 * tests/integration/mcp-contract.test.ts ("a Zod-invalid argument") is the
 * alarm for that upgrade.
 */
// SDK 1.30 raises caller mistakes — Zod input validation, an unknown or
// disabled tool — as McpError(InvalidParams), whose message starts
// "MCP error -32602: " (measured, not assumed). Anything else reaching the
// override is a handler that escaped withErrorContract: internal.
const SDK_INVALID_PARAMS = /^MCP error -32602: /;

export function installErrorContract(server: McpServer): void {
  const target = server as unknown as { createToolError?: (message: string) => unknown };
  if (typeof target.createToolError !== 'function') {
    console.error(
      '[memory-persistor] WARNING: McpServer.createToolError is gone — SDK input-validation errors will not carry errorCategory',
    );
    return;
  }
  target.createToolError = (message: string) =>
    toErrorResult({
      category: SDK_INVALID_PARAMS.test(message) ? 'validation' : 'internal',
      // Only the message string reaches here, so a DrizzleQueryError from an
      // unwrapped handler would carry the full SQL + params. Never echo it.
      message: message.startsWith('Failed query:') ? 'Database query failed' : message,
    });
}

export type CreateServerOptions = {
  /** A MEMORY_PERSISTOR_TOOLSETS-style value; defaults to the environment variable. */
  toolsets?: string;
};

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'memory-persistor', version: '1.0.0' });
  installErrorContract(server);
  // Read at call time, not module scope: src/config.ts must not read env that
  // src/db.ts has not loaded yet (see search-path.ts).
  const { tools, unknown } = parseToolsets(options.toolsets ?? process.env.MEMORY_PERSISTOR_TOOLSETS);
  if (unknown.length > 0) {
    console.error(
      `[memory-persistor] WARNING: unknown toolset(s) ${unknown.join(', ')} in MEMORY_PERSISTOR_TOOLSETS — known: ${Object.keys(TOOLSETS).join(', ')}, all`,
    );
  }
  // A tool outside the selection is removed, which keeps it out of
  // `tools/list` and makes a call to it the SDK's standard unknown-tool error.
  for (const [name, handle] of registerTools(server)) {
    if (!tools.has(name)) handle.remove();
  }
  registerResources(server);
  registerPrompts(server, tools);
  return server;
}
