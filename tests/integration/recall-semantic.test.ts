/**
 * Semantic similarity as the 9th recall signal.
 *
 * The regression that proves the feature: a memory whose text paraphrases a
 * query with ZERO shared content words must rank under semantic scoring, and
 * must be absent once its embedding is cleared (the FTS-only control — this
 * simulates the pre-Phase-2 state for the exact same row/query pair, so the
 * only variable is the embedding column).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { entities } from '../../src/schema.js';
import { embed, embedText } from '../../src/embed.js';
import { recall } from '../../src/retrieve.js';
import { testDb, insertTestMemory, cleanupMemories, closeTestDb } from './helpers.js';

const PREFIX = 'semantic-recall-';
const createdIds: string[] = [];

afterAll(async () => {
  await cleanupMemories(createdIds);
  await closeTestDb();
});

describe('semantic similarity (9th signal)', () => {
  it('paraphrase with zero shared content words ranks under semantic scoring, absent once embedding is cleared', async () => {
    const query = 'Sales figures dropped sharply according to the latest earnings summary';
    const paraphraseText = 'The quarterly financial report revealed a significant decline in revenue growth';

    const mem = await insertTestMemory({
      name: `${PREFIX}paraphrase`,
      type: 'fact',
      observations: paraphraseText,
    });
    createdIds.push(mem.id);

    const vec = await embed(embedText(mem.name, paraphraseText));
    await testDb.update(entities).set({ embedding: vec }).where(eq(entities.id, mem.id));

    const withEmbedding = (await recall({ query })).results;
    const found = withEmbedding.find((r) => r.id === mem.id);
    expect(found).toBeDefined();
    expect(found!.score).toBeGreaterThan(0);

    // Control: clear the embedding (same row, same query — simulates the
    // pre-Phase-2 / FTS-only state). Pure lexical matching must miss it.
    await testDb.update(entities).set({ embedding: null }).where(eq(entities.id, mem.id));

    const withoutEmbedding = (await recall({ query })).results;
    expect(withoutEmbedding.find((r) => r.id === mem.id)).toBeUndefined();
  }, 30_000);

  it('NULL-embedding rows still score via lexical signals only (no crash, no phantom boost)', async () => {
    const mem = await insertTestMemory({
      name: `${PREFIX}lexical-only kubernetes patterns`,
      type: 'fact',
      observations: 'Container orchestration patterns for the semantic-signal NULL-safety test',
    });
    createdIds.push(mem.id);

    const results = (await recall({ query: 'kubernetes orchestration patterns' })).results;
    const found = results.find((r) => r.id === mem.id);
    expect(found).toBeDefined();
    expect(found!.score).toBeGreaterThan(0);
  });
});
