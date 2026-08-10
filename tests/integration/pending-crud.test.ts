/**
 * Integration tests for addPending / listPending / resolvePending.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from './helpers.js';
import { pending } from '../../src/schema.js';
import { addPending, listPending, resolvePending } from '../../src/pending.js';

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
