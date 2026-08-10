/**
 * Integration tests for the pending table — shape, defaults, and ordering.
 * Runs against the real Docker Postgres instance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { testDb } from './helpers.js';
import { pending } from '../../src/schema.js';

afterEach(async () => {
  await testDb.delete(pending);
});

describe('pending table', () => {
  it('applies defaults for body, priority, status, and created_at', async () => {
    const [row] = await testDb
      .insert(pending)
      .values({ title: 'defaults probe', category: 'automation' })
      .returning();

    expect(row.body).toBe('');
    expect(row.priority).toBe('medium');
    expect(row.status).toBe('open');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.resolvedAt).toBeNull();
    expect(row.resolution).toBeNull();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a row with no title', async () => {
    await expect(
      // @ts-expect-error — deliberately omitting the NOT NULL column
      testDb.insert(pending).values({ category: 'skill' }),
    ).rejects.toThrow();
  });

  it('creates the status+priority index', async () => {
    const res = await testDb.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'pending'`,
    );
    const names = res.rows.map((r) => r.indexname as string);
    expect(names).toContain('idx_pending_status_priority');
  });

  it('has no embedding, temperature, or tier columns (queue, not memory)', async () => {
    const res = await testDb.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'pending'`,
    );
    const cols = res.rows.map((r) => r.column_name as string);
    expect(cols).not.toContain('embedding');
    expect(cols).not.toContain('temperature');
    expect(cols).not.toContain('tier');
    expect(cols.sort()).toEqual([
      'body', 'category', 'created_at', 'id', 'origin_host',
      'priority', 'resolution', 'resolved_at', 'source', 'status', 'title',
    ]);
  });
});
