/**
 * Event logging for observability.
 * All logging is fire-and-forget — failures never block tool execution.
 */
import { db } from './db.js';
import { classifyError, type ClassifiedError } from './errors.js';
import { events } from './schema.js';

export type EventType =
  | 'remember'
  | 'recall'
  | 'forget'
  | 'update'
  | 'relate'
  | 'decay'
  | 'bump'
  | 'dedup_detected'
  | 'contradiction_detected'
  | 'merge'
  | 'traverse'
  | 'history'
  | 'conflicts'
  | 'recall_by_ids'
  | 'pending_add'
  | 'pending_resolve'
  | 'pending_update'
  | 'tool_error' // a tool call failed; payload {tool, errorCategory}
  | 'tool_warning' // a non-fatal step inside a successful call failed; payload {tool, steps}
  | 'resource_read' // an MCP resource was read; payload {resource}. Not 'recall' — it must not move the hit rate
  | 'resource_error' // a resource read failed; payload {resource, errorCategory}
  | 'prompt_get' // an MCP prompt was fetched; payload {prompt}
  | 'prompt_error' // a prompt fetch failed; payload {prompt, errorCategory}
  | 'heartbeat'; // written by a client-side hook via raw SQL, not logEvent — listed for completeness

/**
 * Log an event. Fire-and-forget — never throws, never blocks tool execution.
 *
 * A prior silent `.catch(() => {})` masked a misrouted DATABASE_URL for six
 * days (2026-04-07 → 2026-04-13). We now emit structured diagnostics on
 * stderr so a broken insert pipeline is visible on the next MCP restart
 * instead of taking the freshness canary to surface.
 *
 * stdout is reserved for the MCP transport, so all logging goes to stderr.
 */
export function logEvent(
  eventType: EventType,
  memoryId: string | null,
  payload: Record<string, unknown> = {},
): void {
  const render = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    return `[events] logEvent failed — eventType=${eventType} memoryId=${memoryId ?? 'null'} err=${msg}`;
  };
  try {
    db.insert(events)
      .values({ eventType, memoryId, payload })
      .catch((err: unknown) => console.error(render(err)));
  } catch (syncErr) {
    // Defence against a synchronous throw in the query builder — must not
    // propagate to tool execution. Should never fire in practice.
    console.error(render(syncErr));
  }
}

/**
 * The one failure path shared by tools (withErrorContract), resources
 * (withResourceContract) and prompts: classify, log to stderr, record the
 * error event.
 * Each caller then shapes the failure for its own primitive. The message is
 * classifyError's, never `err.message` — drizzle embeds SQL and params there.
 */
const FAILURE_EVENT = { tool: 'tool_error', resource: 'resource_error', prompt: 'prompt_error' } as const;

export function logFailure(kind: keyof typeof FAILURE_EVENT, name: string, err: unknown): ClassifiedError {
  const c = classifyError(err);
  console.error(`[memory-persistor] ${kind} ${name} failed (${c.category}): ${c.message}`);
  logEvent(FAILURE_EVENT[kind], null, { [kind]: name, errorCategory: c.category });
  return c;
}
