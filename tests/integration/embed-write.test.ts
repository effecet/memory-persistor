/**
 * Integration tests for the entities.embedding column.
 * Proves the pgvector round-trip through Drizzle against the real Docker
 * Postgres instance, at the DB layer via helpers. (The remember/update
 * handlers themselves live in src/mcp-tools.ts and are reachable through a
 * real client via tests/integration/mcp-harness.ts.) This is the layer that
 * proves "a written vector comes back intact".
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { entities } from '../../src/schema.js';
import { embed } from '../../src/embed.js';
import { EMBED_DIMS } from '../../src/config.js';
import { testDb, insertTestMemory, cleanupMemory, closeTestDb } from './helpers.js';

describe('entities.embedding column', () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    for (const id of createdIds.splice(0)) {
      await cleanupMemory(id);
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('persists and reads back a full-precision vector through Drizzle + pgvector', async () => {
    const vec = await embed('integration round-trip probe text');
    const entity = await insertTestMemory({ name: 'embed-roundtrip' });
    createdIds.push(entity.id);

    await testDb.update(entities).set({ embedding: vec }).where(eq(entities.id, entity.id));

    const [row] = await testDb
      .select({ embedding: entities.embedding })
      .from(entities)
      .where(eq(entities.id, entity.id))
      .limit(1);

    expect(row.embedding).not.toBeNull();
    expect(row.embedding).toHaveLength(EMBED_DIMS);
    row.embedding!.forEach((v, i) => expect(v).toBeCloseTo(vec[i], 4));
  }, 30_000);

  it('leaves embedding NULL when never written', async () => {
    const entity = await insertTestMemory({ name: 'embed-null-default' });
    createdIds.push(entity.id);

    const [row] = await testDb
      .select({ embedding: entities.embedding })
      .from(entities)
      .where(eq(entities.id, entity.id))
      .limit(1);

    expect(row.embedding).toBeNull();
  });
});
