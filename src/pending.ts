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
import { CategorizedError } from './errors.js';
import { pending } from './schema.js';
import { PENDING_BRIEF_LIMIT } from './config.js';
import type { PendingCategory, PendingPriority, PendingStatus } from './config.js';

/**
 * Canonical host spelling, shared by every read and write of `applies_to`.
 *
 * The whole feature is a string comparison between a stored host and the
 * current one. If the two ever disagree an item becomes SILENTLY INVISIBLE —
 * the same class of failure host scoping exists to fix — so the rule is stated once and
 * applied on both sides rather than assumed.
 *
 * On a typical machine `os.hostname()`, Python's `socket.gethostname()` and
 * `hostname` all return the same short form, but nothing guarantees it on
 * every machine, so domain-stripping and case-folding are defensive, not
 * cosmetic: an FQDN or a case difference on any machine must not hide work.
 *
 * Any client that filters pending items by host (a session-start hook, for
 * example) must apply this exact rule. `tests/test_host_normalization_parity.py`
 * pins the rule's expected outputs.
 */
export function normalizeHost(host: string): string {
  // The character strip is part of the RULE, not sanitation bolted on at one
  // call site. A client that embeds this value into SQL and strips only there
  // would STORE a host outside `[a-z0-9_-]` one way via addPending and COMPARE
  // it another way —
  // reintroducing silent invisibility, the exact failure host scoping exists to fix.
  // Keeping the strip inside the shared rule is what lets the parity test
  // cover the value that actually decides visibility.
  return host.split('.')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/**
 * Normalize a caller-supplied scope list for storage.
 *
 * Drops entries that normalize to empty and de-duplicates. Without the first,
 * `appliesTo: ['.']` stores `['']` — `cardinality` 1, matching no host — so the
 * item is invisible on EVERY machine while looking deliberately scoped. That
 * slips past the MCP layer's `z.string().min(1)`, which validates the input
 * rather than the normalized result.
 */
export function normalizeScope(hosts: string[]): string[] {
  const cleaned = [...new Set(hosts.map(normalizeHost).filter((h) => h.length > 0))];
  if (hosts.length > 0 && cleaned.length === 0) {
    // The caller asked to NARROW and got fleet-wide. Safe direction — visible
    // beats invisible — but it is the one misscoping `hiddenByHost` can never
    // surface, precisely because the item is not hidden anywhere. Say so.
    console.error(
      `[pending] appliesTo ${JSON.stringify(hosts)} normalized to nothing; ` +
        'storing as fleet-wide. Check the hostname spelling.',
    );
  }
  return cleaned;
}

/** The current machine, as stored and compared. */
export function currentHost(): string {
  return normalizeHost(hostname());
}

export type PendingRow = typeof pending.$inferSelect;
export type { PendingCategory, PendingPriority, PendingStatus };

export type AddPendingInput = {
  title: string;
  category: PendingCategory;
  body?: string;
  priority?: PendingPriority;
  source?: string;
  /** Hosts this item is true on. Omitted or empty = fleet-wide. */
  appliesTo?: string[];
};

/**
 * Fields correctable in place. `status` is deliberately absent — see
 * updatePending's note.
 */
export type UpdatePendingInput = {
  title?: string;
  body?: string;
  priority?: PendingPriority;
  category?: PendingCategory;
  /** Re-scope in place. `[]` widens an item back to fleet-wide. */
  appliesTo?: string[];
};

export type ListPendingOptions = {
  status?: PendingStatus;
  category?: PendingCategory;
  limit?: number;
  titlesOnly?: boolean;
  /** Ignore host scope and return every machine's items. Default false. */
  allHosts?: boolean;
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
      // Fleet-wide is the zero-friction default; narrowing is the deliberate
      // act. Normalized on write so a stored value can never differ
      // in case or domain from what the filter compares it against.
      appliesTo: normalizeScope(input.appliesTo ?? []),
    })
    .returning();
  return row;
}

/**
 * Items whose scope includes `host`. Empty `applies_to` = fleet-wide.
 *
 * `cardinality(...) = 0` rather than `IS NULL`: the column is NOT NULL with a
 * `'{}'` default, so there is exactly one spelling of fleet-wide to test for.
 */
const hostScope = (host: string) =>
  sql`(cardinality(${pending.appliesTo}) = 0 OR ${host} = ANY(${pending.appliesTo}))`;

export async function listPending(
  opts: ListPendingOptions = {},
): Promise<{
  items: PendingRow[];
  total: number;
  /** Items matching the same status/category filters — whatever `status` was
   *  passed, not only 'open' — but scoped to another machine. Always computed,
   *  including under `allHosts`, where nothing is actually hidden. */
  hiddenByHost: number;
}> {
  const status = opts.status ?? 'open';
  const filters = [eq(pending.status, status)];
  if (opts.category) filters.push(eq(pending.category, opts.category));
  const baseWhere = and(...filters);
  const scope = hostScope(currentHost());

  // ONE query, two FILTER aggregates, one snapshot.
  //
  // This was previously two `count()` round trips whose difference gave the
  // hidden count. That is wrong under concurrency: the two counts ran in
  // separate transactions, so a write landing between them could make the
  // subtraction disagree with reality — or go negative. Both figures now come
  // from a single scan of the same base filter, so the only difference between
  // them is the host predicate, which is exactly what `hiddenByHost` claims.
  const [counts] = await db
    .select({
      // `IS TRUE` / `IS NOT TRUE` rather than the bare predicate and `NOT`:
      // a NULL ELEMENT inside applies_to makes `host = ANY(...)` evaluate to
      // NULL, so such a row would satisfy NEITHER filter and disappear from
      // both counts — under-reporting the queue with no signal at all. The
      // column is NOT NULL but its elements are unconstrained, and the
      // migration deliberately adds no content CHECK because the host
      // vocabulary is open. This partition is total by construction.
      inScope: sql<number>`count(*) FILTER (WHERE (${scope}) IS TRUE)::int`,
      outOfScope: sql<number>`count(*) FILTER (WHERE (${scope}) IS NOT TRUE)::int`,
    })
    .from(pending)
    .where(baseWhere);

  const inScope = Number(counts?.inScope ?? 0);
  const hiddenByHost = Number(counts?.outOfScope ?? 0);
  // Reported even under `allHosts`, where nothing is actually hidden. Returning
  // 0 there would conflate "none are off-host" with "not measured" — a false
  // reassurance from the one field that exists to make misscoping visible.
  const total = opts.allHosts ? inScope + hiddenByHost : inScope;

  const items = await db
    .select()
    .from(pending)
    .where(opts.allHosts ? baseWhere : and(baseWhere, sql`(${scope}) IS TRUE`))
    .orderBy(PRIORITY_ORDER, desc(pending.createdAt))
    .limit(opts.limit ?? PENDING_BRIEF_LIMIT);

  if (opts.titlesOnly) {
    return { items: items.map((i) => ({ ...i, body: '' })), total, hiddenByHost };
  }
  return { items, total, hiddenByHost };
}

/**
 * Correct an open item in place.
 *
 * `pending_list` feeds the session brief, so the title is the entire
 * user-facing surface of an item — it is what gets read, prioritized, and
 * acted on. A wrong title routes work. Before this existed, the only way to
 * fix one was archive + re-add, which reset `created_at`, changed the uuid,
 * re-stamped `originHost` to whichever machine made the correction, and left
 * an `archived` row on a problem that was never actually dropped.
 *
 * Deliberately narrow:
 * - `status` is NOT updatable. `resolvePending` owns that transition, and
 *   splitting one transition across two functions invites drift.
 * - Only matches rows still `open`. A wrong title only routes work while the
 *   item is live, and letting a closed item be rewritten would make resolved
 *   history untrustworthy. Returns null for a closed row and for an unknown
 *   id, matching resolvePending's shape so callers can report both.
 *
 * Throws rather than issuing a no-op UPDATE when no field is supplied, so a
 * caller that forgot to pass anything hears about it.
 */
export async function updatePending(
  id: string,
  input: UpdatePendingInput,
): Promise<PendingRow | null> {
  // An empty title would blank the NOT NULL column that IS the item's entire
  // user-facing surface in the session brief. The MCP layer's z.string().min(1)
  // catches this for tool callers; scripts and future callers reach the
  // function directly, so the invariant lives here too.
  if (input.title !== undefined && input.title.trim() === '') {
    throw new CategorizedError('validation', 'title cannot be empty — it is what the session brief shows.');
  }

  const updates: Partial<
    Pick<PendingRow, 'title' | 'body' | 'priority' | 'category' | 'appliesTo'>
  > = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.body !== undefined) updates.body = input.body;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.category !== undefined) updates.category = input.category;
  // Normalized on write, exactly as addPending does — a scope corrected here
  // must compare equal to one set there.
  if (input.appliesTo !== undefined) {
    updates.appliesTo = normalizeScope(input.appliesTo);
  }

  if (Object.keys(updates).length === 0) {
    throw new CategorizedError(
      'validation',
      'No fields to update — pass at least one of title, body, priority, category, appliesTo.',
    );
  }

  const [row] = await db
    .update(pending)
    .set(updates)
    .where(and(eq(pending.id, id), eq(pending.status, 'open')))
    .returning();
  return row ?? null;
}

/**
 * Close an item, as `done` (finished) or `archived` (dropped without being
 * done). Nothing is deleted — the row survives with its status flipped. Note
 * that no tool currently reopens a closed item: both this and `updatePending`
 * match `status = 'open'`, so reversing a close means a direct UPDATE.
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
