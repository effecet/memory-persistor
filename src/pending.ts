/**
 * Pending work queue.
 *
 * A queue, not memory: rows here get no thermal decay, no embedding, no graph
 * edges, and no markdown mirror. Kept in the same database only so the
 * session-start hook needs a single connection.
 */
import { hostname } from 'node:os';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db } from './db.js';
import { pending } from './schema.js';
import { PENDING_BRIEF_LIMIT } from './config.js';
import type { PendingCategory, PendingPriority, PendingStatus } from './config.js';

export type PendingRow = typeof pending.$inferSelect;
export type { PendingCategory, PendingPriority, PendingStatus };

export type AddPendingInput = {
  title: string;
  category: PendingCategory;
  body?: string;
  priority?: PendingPriority;
  source?: string;
};

export type ListPendingOptions = {
  status?: PendingStatus;
  category?: PendingCategory;
  limit?: number;
  titlesOnly?: boolean;
};

/**
 * Sort weight for a priority string: high=0, medium=1, everything else=2.
 * Mirrors the SQL CASE expression below so JS-side sorts and DB-side sorts
 * can never disagree.
 */
export function priorityRank(priority: string): number {
  if (priority === 'high') return 0;
  if (priority === 'medium') return 1;
  return 2;
}

/** SQL twin of priorityRank — the canonical queue ordering. */
const PRIORITY_ORDER = sql`CASE ${pending.priority} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

export async function addPending(input: AddPendingInput): Promise<PendingRow> {
  const [row] = await db
    .insert(pending)
    .values({
      title: input.title,
      body: input.body ?? '',
      category: input.category,
      priority: input.priority ?? 'medium',
      status: 'open',
      source: input.source ?? process.cwd(),
      originHost: hostname(),
    })
    .returning();
  return row;
}

export async function listPending(
  opts: ListPendingOptions = {},
): Promise<{ items: PendingRow[]; total: number }> {
  const status = opts.status ?? 'open';
  const filters = [eq(pending.status, status)];
  if (opts.category) filters.push(eq(pending.category, opts.category));
  const where = and(...filters);

  const [{ value: total }] = await db
    .select({ value: count() })
    .from(pending)
    .where(where);

  const items = await db
    .select()
    .from(pending)
    .where(where)
    .orderBy(PRIORITY_ORDER, desc(pending.createdAt))
    .limit(opts.limit ?? PENDING_BRIEF_LIMIT);

  if (opts.titlesOnly) {
    return { items: items.map((i) => ({ ...i, body: '' })), total };
  }
  return { items, total };
}

/**
 * Close an item, as `done` (finished) or `archived` (dropped without being
 * done). Both are terminal and reversible with an UPDATE — nothing is deleted.
 *
 * Only matches rows still `open`, so re-resolving an already-closed item is a
 * no-op rather than silently overwriting its original `resolvedAt` /
 * `resolution` — or flipping an `archived` row to `done`. Returns null in that
 * case, and when the id does not exist, so the caller can report both without
 * throwing.
 */
export async function resolvePending(
  id: string,
  resolution?: string,
  status: Extract<PendingStatus, 'done' | 'archived'> = 'done',
): Promise<PendingRow | null> {
  const [row] = await db
    .update(pending)
    .set({
      status,
      resolvedAt: new Date(),
      resolution: resolution ?? null,
    })
    .where(and(eq(pending.id, id), eq(pending.status, 'open')))
    .returning();
  return row ?? null;
}
