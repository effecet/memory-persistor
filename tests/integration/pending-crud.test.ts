/**
 * Integration tests for addPending / listPending / resolvePending.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { testDb } from './helpers.js';
import { pending } from '../../src/schema.js';
import {
  addPending,
  listPending,
  resolvePending,
  updatePending,
  currentHost,
} from '../../src/pending.js';
import type { UpdatePendingInput } from '../../src/pending.js';

afterEach(async () => {
  await testDb.delete(pending);
});

describe('addPending', () => {
  it('stores an item with defaults and stamps origin_host', async () => {
    const row = await addPending({ title: 'wire the thing', category: 'automation' });
    expect(row.title).toBe('wire the thing');
    expect(row.priority).toBe('medium');
    expect(row.status).toBe('open');
    expect(row.originHost).toBeTruthy();
    expect(row.source).toBeTruthy();
  });

  it('honours explicit body, priority, and source', async () => {
    const row = await addPending({
      title: 'urgent thing',
      category: 'rule',
      body: 'the long explanation',
      priority: 'high',
      source: '/tmp/some-project',
    });
    expect(row.body).toBe('the long explanation');
    expect(row.priority).toBe('high');
    expect(row.source).toBe('/tmp/some-project');
  });
});

describe('listPending', () => {
  it('orders high before medium before low, newest first within a priority', async () => {
    await addPending({ title: 'low one', category: 'skill', priority: 'low' });
    await addPending({ title: 'high older', category: 'skill', priority: 'high' });
    await addPending({ title: 'medium one', category: 'skill', priority: 'medium' });
    await addPending({ title: 'high newer', category: 'skill', priority: 'high' });

    const { items } = await listPending();
    expect(items.map((i) => i.title)).toEqual([
      'high newer', 'high older', 'medium one', 'low one',
    ]);
  });

  it('returns the full open count even when the limit truncates', async () => {
    for (let i = 0; i < 12; i++) {
      await addPending({ title: `item ${i}`, category: 'knowledge' });
    }
    const { items, total } = await listPending({ limit: 5 });
    expect(items).toHaveLength(5);
    expect(total).toBe(12);
  });

  it('excludes archived and done items from the default open listing', async () => {
    const keep = await addPending({ title: 'still open', category: 'skill' });
    const gone = await addPending({ title: 'finished', category: 'skill' });
    await resolvePending(gone.id);
    const old = await addPending({ title: 'old', category: 'skill' });
    await resolvePending(old.id, 'superseded', 'archived');

    const { items, total } = await listPending();
    expect(total).toBe(1);
    expect(items[0].id).toBe(keep.id);
  });

  it('filters by category', async () => {
    await addPending({ title: 'a skill thing', category: 'skill' });
    await addPending({ title: 'an automation thing', category: 'automation' });
    const { items, total } = await listPending({ category: 'automation' });
    expect(total).toBe(1);
    expect(items[0].title).toBe('an automation thing');
  });

  it('blanks bodies when titlesOnly is set', async () => {
    await addPending({ title: 't', category: 'skill', body: 'a very long body' });
    const { items } = await listPending({ titlesOnly: true });
    expect(items[0].body).toBe('');
    expect(items[0].title).toBe('t');
  });
});

describe('resolvePending', () => {
  it('sets status done, stamps resolved_at, and stores the resolution', async () => {
    const row = await addPending({ title: 'do it', category: 'rule' });
    const done = await resolvePending(row.id, 'shipped in PR #99');
    expect(done).not.toBeNull();
    expect(done!.status).toBe('done');
    expect(done!.resolvedAt).toBeInstanceOf(Date);
    expect(done!.resolution).toBe('shipped in PR #99');
  });

  it('returns null for an unknown id instead of throwing', async () => {
    const result = await resolvePending('00000000-0000-4000-8000-000000000000');
    expect(result).toBeNull();
  });

  it('archives when asked, and archived is reachable through the API', async () => {
    const row = await addPending({ title: 'obsolete', category: 'knowledge' });
    const archived = await resolvePending(row.id, 'no longer wanted', 'archived');
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe('archived');

    const { items } = await listPending({ status: 'archived' });
    expect(items.map(i => i.id)).toContain(row.id);
  });

  it('is a no-op on an already-closed item, preserving the first resolution', async () => {
    const row = await addPending({ title: 'do it once', category: 'rule' });
    const first = await resolvePending(row.id, 'closed by the first call');
    expect(first!.resolution).toBe('closed by the first call');

    // Must not clobber the original note, and must not flip archived → done.
    const second = await resolvePending(row.id, 'a later, wrong note');
    expect(second).toBeNull();

    const [current] = await testDb.select().from(pending).where(eq(pending.id, row.id));
    expect(current.resolution).toBe('closed by the first call');
    expect(current.resolvedAt).toEqual(first!.resolvedAt);
  });
});

describe('updatePending', () => {
  it('corrects a title while preserving the row identity', async () => {
    const row = await addPending({
      title: '~/.claude/hooks is backed up nowhere',
      category: 'automation',
      body: 'EVIDENCE (server-b): ...',
      priority: 'high',
    });

    const updated = await updatePending(row.id, {
      title: 'server-b only: ~/.claude/hooks is backed up nowhere',
    });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('server-b only: ~/.claude/hooks is backed up nowhere');

    // The whole point of the issue: archive+re-add destroyed these. An update
    // must not.
    expect(updated!.id).toBe(row.id);
    expect(updated!.createdAt).toEqual(row.createdAt);
    expect(updated!.status).toBe('open');
    // originHost is asserted separately below against a value this machine
    // could not have produced — see the next test.

    // Untouched fields survive a partial update.
    expect(updated!.body).toBe('EVIDENCE (server-b): ...');
    expect(updated!.priority).toBe('high');
    expect(updated!.category).toBe('automation');
  });

  it('updates body, priority, and category', async () => {
    const row = await addPending({ title: 'thing', category: 'skill', priority: 'low' });

    const updated = await updatePending(row.id, {
      body: 'a fuller explanation',
      priority: 'high',
      category: 'rule',
    });

    expect(updated!.body).toBe('a fuller explanation');
    expect(updated!.priority).toBe('high');
    expect(updated!.category).toBe('rule');
    // Title was not passed — it must not be blanked.
    expect(updated!.title).toBe('thing');
  });

  it('returns null for an unknown id instead of throwing', async () => {
    const result = await updatePending('00000000-0000-4000-8000-000000000000', {
      title: 'nope',
    });
    expect(result).toBeNull();
  });

  it('refuses to edit a closed item, so resolved history stays truthful', async () => {
    const row = await addPending({ title: 'finished thing', category: 'knowledge' });
    await resolvePending(row.id, 'done in commit abc123');

    const result = await updatePending(row.id, { title: 'a retroactive rewrite' });
    expect(result).toBeNull();

    const [current] = await testDb.select().from(pending).where(eq(pending.id, row.id));
    expect(current.title).toBe('finished thing');
  });

  it('throws on an all-undefined call rather than issuing a no-op UPDATE', async () => {
    const row = await addPending({ title: 'unchanged', category: 'skill' });
    await expect(updatePending(row.id, {})).rejects.toThrow(/no fields/i);
  });

  it('cannot change status — pending_resolve owns that transition', async () => {
    const row = await addPending({ title: 'still open', category: 'skill' });

    // A real field is passed alongside `status` deliberately. With `status`
    // alone the updates object is empty and updatePending throws, so the
    // assertion below would pass even if status WERE writable — the throw,
    // not the allowlist, would be doing the work.
    const updated = await updatePending(row.id, {
      title: 'edited',
      status: 'done',
    } as UpdatePendingInput);

    expect(updated!.title).toBe('edited');
    expect(updated!.status).toBe('open');

    const [current] = await testDb.select().from(pending).where(eq(pending.id, row.id));
    expect(current.status).toBe('open');
  });

  it('preserves originHost — the correcting machine must not re-stamp it', async () => {
    const row = await addPending({ title: 'found on server-b', category: 'automation' });

    // Force a host this machine cannot produce, so the assertion can actually
    // fail if updatePending ever adds `originHost: hostname()` to its .set().
    await testDb
      .update(pending)
      .set({ originHost: 'some-other-machine' })
      .where(eq(pending.id, row.id));

    const updated = await updatePending(row.id, { title: 'server-b only: found on server-b' });

    expect(updated!.originHost).toBe('some-other-machine');
  });

  it('refuses an empty title, which would blank the session brief line', async () => {
    const row = await addPending({ title: 'has a title', category: 'skill' });
    await expect(updatePending(row.id, { title: '   ' })).rejects.toThrow(/title cannot be empty/i);

    const [current] = await testDb.select().from(pending).where(eq(pending.id, row.id));
    expect(current.title).toBe('has a title');
  });
});

// ── host scope ──────────────────────────────────────────────────

describe('host scope', () => {
  it('defaults to fleet-wide, which is visible on every machine', async () => {
    const row = await addPending({ title: 'fleet thing', category: 'rule' });
    expect(row.appliesTo).toEqual([]);

    const { items, hiddenByHost } = await listPending();
    expect(items.map((i) => i.title)).toContain('fleet thing');
    expect(hiddenByHost).toBe(0);
  });

  it('hides an item scoped to another host, and counts it', async () => {
    await addPending({ title: 'fleet thing', category: 'rule' });
    await addPending({
      title: 'server-b only thing',
      category: 'rule',
      appliesTo: ['some-other-machine'],
    });

    const { items, total, hiddenByHost } = await listPending();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('fleet thing');
    expect(titles).not.toContain('server-b only thing');
    expect(total).toBe(1);
    // The count is the safety property: a misscoped item must never simply
    // vanish, because that is indistinguishable from it having been resolved.
    expect(hiddenByHost).toBe(1);
  });

  it('shows an item scoped to THIS host', async () => {
    await addPending({
      title: 'mine',
      category: 'rule',
      appliesTo: [currentHost()],
    });
    const { items, hiddenByHost } = await listPending();
    expect(items.map((i) => i.title)).toContain('mine');
    expect(hiddenByHost).toBe(0);
  });

  it('matches regardless of case or domain on the stored value', async () => {
    // Normalized on write, so an FQDN or shouted hostname still matches.
    await addPending({
      title: 'shouty',
      category: 'rule',
      appliesTo: [`${currentHost().toUpperCase()}.local`],
    });
    const { items } = await listPending();
    expect(items.map((i) => i.title)).toContain('shouty');
  });

  it('returns everything when allHosts is set, and still reports the count', async () => {
    // hiddenByHost is reported even here, where nothing is actually hidden.
    // Returning 0 would conflate "none are off-host" with "not measured" — a
    // false reassurance from the one field that exists to surface misscoping.
    await addPending({ title: 'elsewhere', category: 'rule', appliesTo: ['nowhere-host'] });
    const { items, total, hiddenByHost } = await listPending({ allHosts: true });
    expect(items.map((i) => i.title)).toContain('elsewhere');
    expect(total).toBe(1);
    expect(hiddenByHost).toBe(1);
  });

  it('counts ONLY host exclusions, not rows dropped by another filter', async () => {
    // The arithmetic must be taken against the same status/category base.
    // Computing it against a differently-filtered base would silently fold
    // category exclusions into a number labelled "hidden by host".
    await addPending({ title: 'rule elsewhere', category: 'rule', appliesTo: ['nowhere-host'] });
    await addPending({ title: 'skill elsewhere', category: 'skill', appliesTo: ['nowhere-host'] });
    await addPending({ title: 'rule here', category: 'rule' });

    const { total, hiddenByHost } = await listPending({ category: 'rule' });
    expect(total).toBe(1);
    expect(hiddenByHost).toBe(1); // the skill row is out of scope of the filter
  });

  it('does not count closed items as hidden', async () => {
    const row = await addPending({
      title: 'done elsewhere',
      category: 'rule',
      appliesTo: ['nowhere-host'],
    });
    await resolvePending(row.id, 'done');
    const { hiddenByHost } = await listPending();
    expect(hiddenByHost).toBe(0);
  });

  it('re-scopes an open item in place, the 2026-08-28 correction case', async () => {
    // Before pending_update this needed archive + re-add, which reset
    // created_at, changed the id, and re-stamped originHost.
    const row = await addPending({ title: 'misscoped', category: 'rule' });
    const fixed = await updatePending(row.id, { appliesTo: ['some-other-machine'] });
    expect(fixed?.id).toBe(row.id);
    expect(fixed?.appliesTo).toEqual(['some-other-machine']);
    expect(fixed?.createdAt).toEqual(row.createdAt);

    const { items, hiddenByHost } = await listPending();
    expect(items.map((i) => i.title)).not.toContain('misscoped');
    expect(hiddenByHost).toBe(1);
  });

  it('widens an item back to fleet-wide with an empty array', async () => {
    const row = await addPending({
      title: 'too narrow',
      category: 'rule',
      appliesTo: ['some-other-machine'],
    });
    await updatePending(row.id, { appliesTo: [] });
    const { items, hiddenByHost } = await listPending();
    expect(items.map((i) => i.title)).toContain('too narrow');
    expect(hiddenByHost).toBe(0);
  });

  it('normalizes on write so stored scope cannot drift from the filter', async () => {
    const row = await addPending({
      title: 'normalized',
      category: 'rule',
      appliesTo: ['SERVER-B.lan', 'Laptop-A.local'],
    });
    expect(row.appliesTo).toEqual(['server-b', 'laptop-a']);
  });

  it('cannot re-scope a closed item', async () => {
    const row = await addPending({ title: 'closed', category: 'rule' });
    await resolvePending(row.id, 'done');
    expect(await updatePending(row.id, { appliesTo: ['x'] })).toBeNull();
  });
});

describe('host scope — invalid-state guards (gate round 2)', () => {
  it('a scope that normalizes to nothing becomes fleet-wide, not invisible', async () => {
    // `['.']` used to store `['']` — cardinality 1, matching no host — so the
    // item was hidden on EVERY machine while looking deliberately scoped.
    const row = await addPending({
      title: 'dot scope',
      category: 'rule',
      appliesTo: ['.'],
    });
    expect(row.appliesTo).toEqual([]);

    const { items, hiddenByHost } = await listPending();
    expect(items.map((i) => i.title)).toContain('dot scope');
    expect(hiddenByHost).toBe(0);
  });

  it('de-duplicates spellings that normalize together', async () => {
    const row = await addPending({
      title: 'dupes',
      category: 'rule',
      appliesTo: ['Laptop-A', 'laptop-a.local', 'LAPTOP-A'],
    });
    expect(row.appliesTo).toEqual(['laptop-a']);
  });

  it('reports hiddenByHost even under allHosts, where nothing is hidden', async () => {
    // 0 there would conflate "none are off-host" with "not measured" — a false
    // reassurance from the one field that exists to make misscoping visible.
    await addPending({ title: 'elsewhere', category: 'rule', appliesTo: ['nowhere-host'] });
    await addPending({ title: 'here', category: 'rule' });

    const scoped = await listPending();
    const all = await listPending({ allHosts: true });
    expect(scoped.hiddenByHost).toBe(1);
    expect(all.hiddenByHost).toBe(1);
    expect(all.total).toBe(2);
    expect(scoped.total).toBe(1);
    // total + hiddenByHost is the full open count under the same filters.
    expect(scoped.total + scoped.hiddenByHost).toBe(all.total);
  });

  it('counts come from one snapshot, so they cannot contradict each other', async () => {
    // Previously two separate count() round trips in different transactions;
    // a concurrent write between them could make the subtraction disagree with
    // reality, or go negative.
    await Promise.all([
      addPending({ title: 'a', category: 'rule' }),
      addPending({ title: 'b', category: 'rule', appliesTo: ['nowhere-host'] }),
      addPending({ title: 'c', category: 'rule', appliesTo: ['nowhere-host'] }),
    ]);
    const { total, hiddenByHost } = await listPending();
    expect(total).toBe(1);
    expect(hiddenByHost).toBe(2);
    expect(hiddenByHost).toBeGreaterThanOrEqual(0);
  });
});

describe('host scope — a NULL array element must not vanish', () => {
  it('counts a row whose applies_to contains NULL', async () => {
    // The column is NOT NULL but its ELEMENTS are unconstrained, and the
    // migration deliberately adds no content CHECK (the host vocabulary is
    // open). With a bare predicate, `host = ANY('{a,NULL}')` evaluates to NULL,
    // so the row satisfied NEITHER count(*) FILTER and disappeared from both
    // figures — under-reporting the queue with no signal. Measured on PG16
    // before the fix: 3 rows in, in=1 out=1.
    //
    // Inserted through raw SQL on purpose: normalizeScope() strips empties on
    // the write path, so this state is only reachable from outside the API —
    // which is exactly why the READ path has to be total.
    await testDb.execute(sql`
      INSERT INTO pending (title, category, priority, status, applies_to)
      VALUES ('fleet', 'rule', 'medium', 'open', '{}'),
             ('elsewhere', 'rule', 'medium', 'open', '{nowhere-host}'),
             ('nullelem', 'rule', 'medium', 'open', ARRAY['a', NULL]::text[])
    `);

    const { total, hiddenByHost } = await listPending();
    // Every row is accounted for by exactly one side of the partition.
    expect(total + hiddenByHost).toBe(3);
    expect(total).toBe(1);
    expect(hiddenByHost).toBe(2);
  });
});
