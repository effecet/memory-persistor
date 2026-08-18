/**
 * Backfill failure path: when the embedding model can't
 * load, the backfill must NOT silently mark rows embedded. It aborts on the
 * pre-loop probe, reports failed=total (non-zero exit), and leaves every row
 * NULL so a re-run after the model is fixed picks them up.
 *
 * Mocks @huggingface/transformers so the pipeline load rejects deterministically
 * (same isolation rationale as embed-write-failure.test.ts — kept in its own
 * file so the module mock doesn't leak into the real-model backfill tests).
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { entities } from '../../src/schema.js';
import { testDb, insertTestMemory, cleanupMemory, closeTestDb } from './helpers.js';

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockRejectedValue(new Error('simulated model-load failure')),
}));

describe('backfill-embeddings failure handling', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIds.splice(0)) await cleanupMemory(id);
    await closeTestDb();
  });

  it('aborts and leaves rows NULL when the model cannot load', async () => {
    const { backfillEmbeddings } = await import('../../scripts/backfill-embeddings.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const a = await insertTestMemory({ name: 'backfill-fail', observations: 'fail content' });
    createdIds.push(a.id);

    const result = await backfillEmbeddings({ onlyIds: createdIds });

    expect(result.total).toBe(1);
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(1);
    expect(errorSpy).toHaveBeenCalled();

    const [row] = await testDb
      .select({ embedding: entities.embedding })
      .from(entities)
      .where(eq(entities.id, a.id))
      .limit(1);
    expect(row.embedding).toBeNull();

    errorSpy.mockRestore();
  }, 30_000);
});
