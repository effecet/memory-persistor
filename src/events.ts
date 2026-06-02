/**
 * Event logging for observability.
 * All logging is fire-and-forget — failures never block tool execution.
 */
import { db } from './db.js';
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
  | 'recall_by_ids';

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
