/**
 * Integration test for the memory-compact duplicates mode round-trip.
 * Seeds near-duplicate memories, pulls them via getHealth.dedupCandidates,
 * then exercises each mutation path (merge / forget / related_to)
 * and verifies the store reflects the action.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  testDb,
  insertTestMemory,
  cleanupMemories,
  closeTestDb,
  getMemory,
  getRelations,
  findPair,
} from './helpers.js';
import { getHealth } from '../../src/observability.js';
import { mergeMemories } from '../../src/intelligence.js';
import { entities, memoryRelations } from '../../src/schema.js';

const createdIds: string[] = [];

afterEach(async () => {
  await cleanupMemories(createdIds.splice(0));
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * Seed a pair of near-duplicates that appear in dedupCandidates. The shorter
 * observation is a clean prefix of the longer, so bidirectional similarity
 * is comfortably above the 0.85 threshold regardless of UUID ordering.
 */
async function seedPair(tag: string) {
  const longObs = `The ${tag} topic has substantial context and surrounding detail that makes the observation verbose and information dense enough to survive the similarity threshold.`;
  const shortObs = `The ${tag} topic has substantial context and surrounding detail that makes the observation`;
  const a = await insertTestMemory({
    name: `roundtrip-${tag}-notes`,
    type: 'fact',
    observations: longObs,
  });
  const b = await insertTestMemory({
    name: `roundtrip-${tag}-notes`,
    type: 'fact',
    observations: shortObs,
  });
  createdIds.push(a.id, b.id);
  return { a, b };
}

describe('memory-compact duplicates round-trip', () => {
  it('merge path: survivor keeps both observations, loser is deleted', async () => {
    const { a, b } = await seedPair('merge-path');

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, a.id, b.id);
    expect(pair).toBeDefined();

    const winnerId = pair!.proposedCanonicalId;
    const loserId = winnerId === pair!.aId ? pair!.bId : pair!.aId;

    // Use the real merge function: sourceId (deleted) → targetId (survives)
    await mergeMemories(loserId, winnerId);

    const survivor = await getMemory(winnerId);
    expect(survivor).not.toBeNull();
    // mergeMemories appends loser's observations with a "[Merged from: <name>]" marker
    expect(survivor!.observations).toContain('[Merged from: roundtrip-merge-path-notes]');

    const loser = await getMemory(loserId);
    expect(loser).toBeNull();
  });

  it('forget path: one memory is deleted, the other is untouched', async () => {
    const { a, b } = await seedPair('forget-path');

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, a.id, b.id);
    expect(pair).toBeDefined();

    // Forget A
    await testDb.delete(entities).where(eq(entities.id, a.id));

    const forgotten = await getMemory(a.id);
    expect(forgotten).toBeNull();

    const survivor = await getMemory(b.id);
    expect(survivor).not.toBeNull();
  });

  it('related_to path: both memories remain, a new related_to edge exists', async () => {
    const { a, b } = await seedPair('related-path');

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, a.id, b.id);
    expect(pair).toBeDefined();

    // Add a related_to edge (simulating skill's [R] action)
    await testDb.insert(memoryRelations).values({
      fromId: a.id,
      toId: b.id,
      relationType: 'related_to',
      weight: 1.0,
    });

    const memA = await getMemory(a.id);
    const memB = await getMemory(b.id);
    expect(memA).not.toBeNull();
    expect(memB).not.toBeNull();

    const edges = await getRelations(a.id);
    const relatedEdge = edges.find(
      (e: any) =>
        e.relation_type === 'related_to' &&
        ((e.from_id === a.id && e.to_id === b.id) ||
          (e.from_id === b.id && e.to_id === a.id)),
    );
    expect(relatedEdge).toBeDefined();

    // Clean the edge (entities clean up in afterEach)
    await testDb
      .delete(memoryRelations)
      .where(eq(memoryRelations.fromId, a.id));
  });

  it('getHealth reports one less dedup candidate after one side is removed', async () => {
    const { a, b } = await seedPair('post-merge-check');

    let health = await getHealth();
    const beforePair = findPair(health.dedupCandidates, a.id, b.id);
    expect(beforePair).toBeDefined();

    // Remove one side (mimics post-merge state)
    await testDb.delete(entities).where(eq(entities.id, b.id));

    health = await getHealth();
    const afterPair = findPair(health.dedupCandidates, a.id, b.id);
    expect(afterPair).toBeUndefined();
  });
});
