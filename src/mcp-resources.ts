/**
 * MCP resources: read-only views of the brain that a CLIENT can list and
 * attach, rather than the model having to discover them with tool calls.
 *
 * Resources are the application-controlled primitive. Every read here is
 * side-effect-free on the corpus: no `bump()`, no `recall` event. That is the
 * point — exploratory `recall` reheats what it returns (temperature is a recall
 * prior), so discovering "what exists" by searching degraded the ranking it
 * searched. A `resource_read` event is still logged (fire-and-forget) so usage
 * stays measurable; it is a different event type, so `analytics`' recall hit
 * rate is untouched.
 *
 *   memory://index               counts per type and tier, with one link per type
 *   memory://index/{type}        one line per memory of that type → its entity URI
 *   memory://entity/{id}         one memory's full body (read-only twin of recall_by_ids)
 *   memory://pending             the open queue, scoped to this host
 *   memory://status              the `status` dashboard
 *   memory://graph               the `graph` Mermaid projection
 *
 * `memory://entity/{id}` is a template with NO list callback on purpose: the
 * index is how entities are enumerated, and listing ~1,000 URIs in
 * `resources/list` would put the whole corpus in every client's resource menu.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { sql, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db.js';
import { entities } from './schema.js';
import { MEMORY_TYPES, RESPONSE_CAP_BYTES, RESPONSE_JSON_INDENT } from './config.js';
import { truncateDescription, TIER_RANK } from './file-sync.js';
import { fetchByIds } from './retrieve.js';
import { listPending } from './pending.js';
import { getStatus } from './observability.js';
import { renderGraphMermaid } from './graph.js';
import { logEvent, logFailure } from './events.js';
import { CategorizedError } from './errors.js';

const entityId = z.string().uuid();

/** MCP's "resource not found" (spec 2025-11-25); the SDK 1.30 ErrorCode enum has no member for it. */
const RESOURCE_NOT_FOUND = -32002;
const entityUri = (id: string): string => `memory://entity/${id}`;
const indexTypeUri = (type: string): string => `memory://index/${type}`;

/** A memory name as Markdown link text: brackets and parens escaped, newlines flattened, so a name cannot forge or split an index line. */
const linkText = (name: string): string => name.replace(/\s*\r?\n\s*/g, ' ').replace(/[[\]()\\]/g, (c) => `\\${c}`);

function text(uri: URL, body: string, mimeType: string): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType, text: body }] };
}

function json(uri: URL, value: unknown): ReadResourceResult {
  return text(uri, JSON.stringify(value, null, RESPONSE_JSON_INDENT), 'application/json');
}

/**
 * The resource-side twin of withErrorContract. A resource read has no
 * `isError` result shape — failures travel as JSON-RPC errors — so this maps
 * the same classification onto McpError codes: a caller's mistake is
 * InvalidParams, anything else InternalError.
 *
 * The message is classifyError's, never `err.message`: drizzle's
 * DrizzleQueryError embeds the full SQL and params, i.e. memory content.
 */
/** @internal — exported so tests can drive the failure path with an injected fault. */
export function withResourceContract<A extends unknown[]>(
  name: string,
  read: (uri: URL, ...rest: A) => Promise<ReadResourceResult>,
): (uri: URL, ...rest: A) => Promise<ReadResourceResult> {
  return async (uri, ...rest) => {
    try {
      const result = await read(uri, ...rest);
      logEvent('resource_read', null, { resource: name });
      return result;
    } catch (err) {
      if (err instanceof McpError) {
        // Already shaped by the handler (resource not found): pass it through.
        logEvent('resource_error', null, { resource: name, errorCategory: 'validation' });
        throw err;
      }
      const c = logFailure('resource', name, err);
      throw new McpError(c.category === 'validation' ? ErrorCode.InvalidParams : ErrorCode.InternalError, c.message);
    }
  };
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    'index',
    'memory://index',
    {
      title: 'Memory catalog',
      description: 'How many memories exist per type and tier, with a link to each type\'s full listing. Read-only; reading does not reheat anything.',
      mimeType: 'text/markdown',
    },
    withResourceContract('index', async (uri) => {
      const rows = await db
        .select({ type: entities.type, tier: sql<string>`COALESCE(${entities.tier}, 'UNKNOWN')`, n: count() })
        .from(entities)
        .groupBy(entities.type, entities.tier);
      const byType = new Map<string, Map<string, number>>();
      for (const r of rows) {
        if (!byType.has(r.type)) byType.set(r.type, new Map());
        byType.get(r.type)!.set(r.tier, r.n);
      }
      const total = rows.reduce((s, r) => s + r.n, 0);
      const lines = [`# Memory catalog (${total})`, ''];
      for (const type of [...byType.keys()].sort()) {
        const tiers = byType.get(type)!;
        const n = [...tiers.values()].reduce((s, x) => s + x, 0);
        const split = [...Object.keys(TIER_RANK), 'UNKNOWN']
          .filter((t) => tiers.has(t))
          .map((t) => `${tiers.get(t)} ${t}`)
          .join(', ');
        lines.push(`- [${type}](${indexTypeUri(type)}) — ${n} (${split})`);
      }
      return text(uri, lines.join('\n'), 'text/markdown');
    }),
  );

  server.registerResource(
    'index-by-type',
    new ResourceTemplate('memory://index/{type}', {
      // Bounded and known: one resource per memory type.
      list: async () => ({
        resources: MEMORY_TYPES.map((t) => ({ uri: indexTypeUri(t), name: `${t} memories`, mimeType: 'text/markdown' })),
      }),
      complete: { type: (value) => MEMORY_TYPES.filter((t) => t.startsWith(value)) },
    }),
    {
      title: 'Memories of one type',
      description: 'One line per memory of the given type — name, short description, tier — each linking to memory://entity/{id}. Ordered hottest first; cut at the 30 KB response cap with an "…and N more" footer.',
      mimeType: 'text/markdown',
    },
    withResourceContract('index-by-type', async (uri, { type }) => {
      const t = String(type);
      if (!(MEMORY_TYPES as readonly string[]).includes(t)) {
        throw new CategorizedError('validation', `unknown memory type "${t}" — one of ${MEMORY_TYPES.join(', ')}`);
      }
      // Hottest first: tier (unknown ranks as WARM, like file-sync's
      // UNKNOWN_TIER_RANK), then temperature, then name in codepoint order.
      // left(…, 200): a line shows truncateDescription's 40 code points, so
      // shipping every full body over the wire would be waste.
      const rows = await db
        .select({
          id: entities.id,
          name: entities.name,
          tier: entities.tier,
          observations: sql<string | null>`left(${entities.observations}, 200)`,
        })
        .from(entities)
        .where(eq(entities.type, t))
        .orderBy(
          sql`CASE ${entities.tier} WHEN 'HOT' THEN 0 WHEN 'WARM' THEN 1 WHEN 'COLD' THEN 2 ELSE 1 END`,
          sql`${entities.temperature} DESC NULLS LAST`,
          sql`${entities.name} COLLATE "C"`,
        );

      // Bounded like every other response: measured on Supabase
      // 2026-10-01, `feedback` alone renders ~60 KB. Lines are added until the
      // next one, plus the footer, would cross RESPONSE_CAP_BYTES.
      const lines = [`# ${t} (${rows.length})`, ''];
      let bytes = Buffer.byteLength(lines.join('\n'));
      let shown = 0;
      for (const r of rows) {
        const desc = truncateDescription(r.observations);
        const line = `- [${linkText(r.name)}](${entityUri(r.id)})${desc ? ` — ${desc}` : ''} [${r.tier ?? 'UNKNOWN'}]`;
        const footerBudget = Buffer.byteLength(`\n- …and ${rows.length} more — use recall`);
        if (bytes + 1 + Buffer.byteLength(line) + footerBudget > RESPONSE_CAP_BYTES) break;
        lines.push(line);
        bytes += 1 + Buffer.byteLength(line);
        shown++;
      }
      if (shown < rows.length) lines.push(`- …and ${rows.length - shown} more — use recall`);
      return text(uri, lines.join('\n'), 'text/markdown');
    }),
  );

  server.registerResource(
    'entity',
    new ResourceTemplate('memory://entity/{id}', { list: undefined }),
    {
      title: 'One memory',
      description: 'A memory\'s full body and its edges, in recall_by_ids\' shape. Read-only and uncapped — unlike recall and recall_by_ids, reading it never bumps temperature.',
      mimeType: 'application/json',
    },
    withResourceContract('entity', async (uri, { id }) => {
      const parsed = entityId.safeParse(String(id));
      if (!parsed.success) throw new CategorizedError('validation', `not a memory id: "${String(id)}"`);
      // recall_by_ids' own fetch without its cap or its bump: same row and
      // `related` shape, the WHOLE body (the cap would silently degrade one
      // oversized memory to a summary), and no reheat.
      const [row] = await fetchByIds([parsed.data]);
      if (!row) throw new McpError(RESOURCE_NOT_FOUND, `no memory with id ${parsed.data}`);
      return json(uri, row);
    }),
  );

  server.registerResource(
    'pending',
    'memory://pending',
    {
      title: 'Open pending queue',
      description: 'The top open work-queue items in scope for this host, priority-ordered — exactly what pending_list returns by default (10 items; `total` gives the full count).',
      mimeType: 'application/json',
    },
    withResourceContract('pending', async (uri) => json(uri, await listPending({ status: 'open' }))),
  );

  server.registerResource(
    'status',
    'memory://status',
    {
      title: 'Memory dashboard',
      description: 'Totals by tier and type, hottest and coldest memories, stale count — the status tool as a resource.',
      mimeType: 'application/json',
    },
    withResourceContract('status', async (uri) => json(uri, await getStatus())),
  );

  server.registerResource(
    'graph',
    'memory://graph',
    {
      title: 'Memory graph',
      description: 'The whole knowledge graph as a Mermaid flowchart — the graph tool as a resource.',
      mimeType: 'text/plain',
    },
    withResourceContract('graph', async (uri) => text(uri, await renderGraphMermaid(), 'text/plain')),
  );
}
