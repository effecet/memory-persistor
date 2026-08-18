/**
 * Cosine near-duplicate detection in `health`.
 *
 * The upgrade that proves the feature: two memories with DIFFERENT names but a
 * near-identical body must surface as a `health` dedup candidate under cosine
 * scoring. The old name-only trigram detector missed exactly this case (the
 * discriminator was the name), so a diff-name/same-body pair is the regression
 * guard for "cosine, not trigram."
 *
 * Surfacing only — health never merges or deletes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { entities } from '../../src/schema.js';
import { embed, embedText } from '../../src/embed.js';
import { getHealth } from '../../src/observability.js';
import { DEDUP_COSINE_THRESHOLD } from '../../src/config.js';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  closeTestDb,
  findPair,
} from './helpers.js';

const PREFIX = 'dedup-cosine-';
const createdIds: string[] = [];

async function insertEmbedded(name: string, observations: string): Promise<string> {
  const mem = await insertTestMemory({ name, type: 'fact', observations });
  createdIds.push(mem.id);
  const vec = await embed(embedText(name, observations));
  await testDb.update(entities).set({ embedding: vec }).where(eq(entities.id, mem.id));
  return mem.id;
}

afterAll(async () => {
  await cleanupMemories(createdIds);
  await closeTestDb();
});

describe('cosine near-dupe detection in health (9th-signal upgrade)', () => {
  // A near-identical body under two different names — the case name-trigram
  // misses. One long shared body keeps cosine well above the strict 0.92 gate.
  const body =
    'The nightly thermal-decay job lowers each memory temperature on a ' +
    'pattern-aware curve and promotes or demotes its tier accordingly, ' +
    'running as a pg_cron task at 06:00 UTC against the shared Postgres.';

  it('surfaces a diff-name/same-body pair above DEDUP_COSINE_THRESHOLD, and not an unrelated memory', async () => {
    const aId = await insertEmbedded(`${PREFIX}thermal-decay-overview`, body);
    const bId = await insertEmbedded(`${PREFIX}how-decay-works`, body);
    // Unrelated same-type memory — must NOT pair with either above threshold.
    const cId = await insertEmbedded(
      `${PREFIX}pooler-hostname`,
      'The Supabase transaction pooler hostname differs by region and must be used on IPv4 networks.',
    );

    const health = await getHealth();

    const pair = findPair(health.dedupCandidates, aId, bId);
    expect(pair).toBeDefined();
    expect(pair!.similarity).toBeGreaterThan(DEDUP_COSINE_THRESHOLD);
    // proposedCanonical must be one of the two, never invented.
    expect([aId, bId]).toContain(pair!.proposedCanonicalId);

    // The unrelated memory must not form an above-threshold pair with A or B.
    expect(findPair(health.dedupCandidates, aId, cId)).toBeUndefined();
    expect(findPair(health.dedupCandidates, bId, cId)).toBeUndefined();
  }, 30_000);

  it('excludes a pair that already has a relation (already reconciled)', async () => {
    const aId = await insertEmbedded(`${PREFIX}rel-alpha`, body);
    const bId = await insertEmbedded(`${PREFIX}rel-beta`, body);

    // Before relating: the pair is a candidate.
    const before = await getHealth();
    expect(findPair(before.dedupCandidates, aId, bId)).toBeDefined();

    // Link them — now they're already-reconciled, not an open dupe.
    await insertTestRelation(aId, bId, 'related_to');

    const after = await getHealth();
    expect(findPair(after.dedupCandidates, aId, bId)).toBeUndefined();
  }, 30_000);
});
