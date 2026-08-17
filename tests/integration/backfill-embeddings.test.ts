/**
 * One-time embedding backfill.
 *
 * Proves the backfill against the real Docker Postgres: NULL-embedding rows get
 * a 384-d vector, dry-run mutates nothing, and a re-run is idempotent (already-
 * embedded rows are skipped, not re-embedded). Uses the `onlyIds` scope so the
 * test stays hermetic — it never touches the machine's other un-embedded rows.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { entities } from '../../src/schema.js';
import { EMBED_DIMS } from '../../src/config.js';
import { backfillEmbeddings } from '../../scripts/backfill-embeddings.js';
import { testDb, insertTestMemory, cleanupMemory, closeTestDb } from './helpers.js';

describe('backfill-embeddings', () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    for (const id of createdIds.splice(0)) {
      await cleanupMemory(id);
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function readEmbedding(id: string): Promise<number[] | null> {
    const [row] = await testDb
      .select({ embedding: entities.embedding })
      .from(entities)
      .where(eq(entities.id, id))
      .limit(1);
    return row.embedding;
  }

  it('embeds all NULL-embedding rows in scope', async () => {
    const a = await insertTestMemory({ name: 'backfill-a', observations: 'alpha content' });
    const b = await insertTestMemory({ name: 'backfill-b', observations: 'bravo content' });
    createdIds.push(a.id, b.id);

    const result = await backfillEmbeddings({ onlyIds: createdIds });

    expect(result.total).toBe(2);
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);

    const embA = await readEmbedding(a.id);
    const embB = await readEmbedding(b.id);
    expect(embA).toHaveLength(EMBED_DIMS);
    expect(embB).toHaveLength(EMBED_DIMS);
  }, 30_000);

  it('dry-run counts but writes nothing', async () => {
    const a = await insertTestMemory({ name: 'backfill-dry', observations: 'dry content' });
    createdIds.push(a.id);

    const result = await backfillEmbeddings({ onlyIds: createdIds, dryRun: true });

    expect(result.total).toBe(1);
    expect(result.embedded).toBe(0); // dry-run performs no writes
    expect(await readEmbedding(a.id)).toBeNull();
  }, 30_000);

  it('is idempotent — a second run skips already-embedded rows', async () => {
    const a = await insertTestMemory({ name: 'backfill-idem', observations: 'idem content' });
    createdIds.push(a.id);

    const first = await backfillEmbeddings({ onlyIds: createdIds });
    expect(first.embedded).toBe(1);

    // Second run: the row is no longer NULL, so it's not even in scope.
    const second = await backfillEmbeddings({ onlyIds: createdIds });
    expect(second.total).toBe(0);
    expect(second.embedded).toBe(0);
  }, 30_000);
});
