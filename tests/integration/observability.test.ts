/**
 * Integration tests for Phase 5: Observability.
 * Tests: event logging, analytics, health.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  closeTestDb,
  findPair,
} from './helpers.js';
import { logEvent } from '../../src/events.js';
import { getAnalytics, getHealth } from '../../src/observability.js';
import { events } from '../../src/schema.js';
import { eq, sql } from 'drizzle-orm';

const createdIds: string[] = [];

/** Wait for fire-and-forget event inserts to settle. */
const settle = () => new Promise((r) => setTimeout(r, 50));

afterEach(async () => {
  // Clean up test events
  await testDb.execute(sql`
    DELETE FROM public.events
    WHERE payload->>'test' = 'true'
  `);
  await cleanupMemories(createdIds.splice(0));
});

afterAll(async () => {
  await closeTestDb();
});

// ── Event logging ───────────────────────────────────────────────────────────

describe('logEvent', () => {
  it('logs an event with type, memoryId, and payload', async () => {
    const mem = await insertTestMemory({ name: 'event-log-test' });
    createdIds.push(mem.id);

    logEvent('remember', mem.id, { test: 'true', detail: 'created' });
    await settle();

    const result = await testDb.execute(sql`
      SELECT event_type, memory_id, payload
      FROM public.events
      WHERE memory_id = ${mem.id}
      AND payload->>'test' = 'true'
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const row = result.rows[0] as any;
    expect(row.event_type).toBe('remember');
    expect(row.memory_id).toBe(mem.id);
    expect(row.payload.detail).toBe('created');
  });

  it('logs events without a memoryId (null)', async () => {
    logEvent('recall', null, { test: 'true', query: 'test query' });
    await settle();

    const result = await testDb.execute(sql`
      SELECT event_type, memory_id, payload
      FROM public.events
      WHERE event_type = 'recall'
      AND payload->>'test' = 'true'
      AND payload->>'query' = 'test query'
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const row = result.rows[0] as any;
    expect(row.memory_id).toBeNull();
  });

  it('does not throw on failure (fire-and-forget)', () => {
    // This should not throw even with invalid data patterns
    expect(() => {
      logEvent('remember', null, { test: 'true' });
    }).not.toThrow();
  });
});

// ── Analytics ───────────────────────────────────────────────────────────────

describe('getAnalytics', () => {
  it('returns valid analytics structure', async () => {
    const analytics = await getAnalytics();

    expect(analytics).toHaveProperty('recallHitRate');
    expect(analytics).toHaveProperty('totalRecalls');
    expect(analytics).toHaveProperty('topAccessed');
    expect(analytics).toHaveProperty('temperatureDistribution');
    expect(analytics).toHaveProperty('eventsPerDay');
    expect(analytics).toHaveProperty('graphDensity');

    expect(analytics.recallHitRate).toBeGreaterThanOrEqual(0);
    expect(analytics.recallHitRate).toBeLessThanOrEqual(1);
    expect(analytics.graphDensity).toBeGreaterThanOrEqual(0);
    expect(analytics.graphDensity).toBeLessThanOrEqual(1);
  });

  it('computes recall hit rate from events', async () => {
    // Log some recall events
    logEvent('recall', null, { test: 'true', resultCount: 3, avgScore: 0.75 });
    logEvent('recall', null, { test: 'true', resultCount: 0, avgScore: 0 });
    logEvent('recall', null, { test: 'true', resultCount: 5, avgScore: 0.82 });
    await settle();

    const analytics = await getAnalytics();
    // At least our 3 test events should be counted
    expect(analytics.totalRecalls).toBeGreaterThanOrEqual(3);
  });

  it('returns top accessed memories ordered by access_count', async () => {
    const mem = await insertTestMemory({
      name: 'top-accessed-test',
      accessCount: 999,
    });
    createdIds.push(mem.id);

    const analytics = await getAnalytics();
    expect(analytics.topAccessed.length).toBeGreaterThan(0);
    // Our memory with accessCount=999 should be first or near top
    const found = analytics.topAccessed.find((m) => m.id === mem.id);
    expect(found).toBeDefined();
  });
});

// ── Health ───────────────────────────────────────────────────────────────────

describe('getHealth', () => {
  it('returns valid health structure', async () => {
    const health = await getHealth();

    expect(health).toHaveProperty('orphanCount');
    expect(health).toHaveProperty('orphans');
    expect(health).toHaveProperty('staleCount');
    expect(health).toHaveProperty('dedupCandidateCount');
    expect(health).toHaveProperty('contradictionCount');
    expect(health).toHaveProperty('typeCoverage');
    expect(health).toHaveProperty('totalMemories');
    expect(health).toHaveProperty('totalEdges');

    expect(health.orphanCount).toBeGreaterThanOrEqual(0);
    expect(health.staleCount).toBeGreaterThanOrEqual(0);
    expect(health.totalMemories).toBeGreaterThanOrEqual(0);
  });

  it('identifies orphan memories (no edges)', async () => {
    const orphan = await insertTestMemory({ name: 'orphan-health-test' });
    createdIds.push(orphan.id);

    const health = await getHealth();
    const found = health.orphans.find((o) => o.id === orphan.id);
    expect(found).toBeDefined();
    expect(health.orphanCount).toBeGreaterThanOrEqual(1);
  });

  it('does not count connected memories as orphans', async () => {
    const mem1 = await insertTestMemory({ name: 'connected-health-1' });
    const mem2 = await insertTestMemory({ name: 'connected-health-2' });
    createdIds.push(mem1.id, mem2.id);

    await insertTestRelation(mem1.id, mem2.id, 'related_to');

    const health = await getHealth();
    const orphanIds = health.orphans.map((o) => o.id);
    expect(orphanIds).not.toContain(mem1.id);
    expect(orphanIds).not.toContain(mem2.id);
  });

  it('counts contradictions from memory_relations', async () => {
    const mem1 = await insertTestMemory({ name: 'contradict-health-1' });
    const mem2 = await insertTestMemory({ name: 'contradict-health-2' });
    createdIds.push(mem1.id, mem2.id);

    await insertTestRelation(mem1.id, mem2.id, 'contradicts');

    const health = await getHealth();
    expect(health.contradictionCount).toBeGreaterThanOrEqual(1);
  });

  it('reports type coverage', async () => {
    // Seed a memory so typeCoverage has at least one entry to report —
    // relying on pre-existing DB state is flaky under CI's clean ephemeral
    // Postgres (0 entities at test start).
    const seed = await insertTestMemory({
      name: 'type-coverage-probe',
      type: 'fact',
      observations: 'probe for health.typeCoverage aggregation',
    });
    createdIds.push(seed.id);

    const health = await getHealth();
    expect(health.typeCoverage.length).toBeGreaterThan(0);
    // Each entry should have type and count
    for (const entry of health.typeCoverage) {
      expect(entry.type).toBeTruthy();
      expect(entry.count).toBeGreaterThan(0);
    }
  });
});

// ── dedupCandidates (new field — Task 1) ─────────────────────────────────

describe('getHealth — dedupCandidates field', () => {
  it('returns dedupCandidates as an array (no pair for a unique seeded memory)', async () => {
    const mem = await insertTestMemory({
      name: 'unique-task1-memory-abc',
      type: 'fact',
      observations: 'completely unique content xyz-task1',
    });
    createdIds.push(mem.id);

    const health = await getHealth();
    expect(Array.isArray(health.dedupCandidates)).toBe(true);
    // Filter to pairs involving our seeded memory — isolates from other
    // test data on the shared DB.
    const ours = health.dedupCandidates.filter(
      (p) => p.aId === mem.id || p.bId === mem.id,
    );
    expect(ours.length).toBe(0);
  });

  it('returns one pair with full metadata when two near-duplicates exist', async () => {
    const longObs = 'The postgres pooler transaction mode has an implicit connection limit that matters for concurrent writes and you should set it explicitly in production.';
    const shortObs = 'The postgres pooler transaction mode has a connection limit.';

    const memA = await insertTestMemory({
      name: 'postgres-pooler-connection-limit-notes',
      type: 'fact',
      observations: longObs,
    });
    createdIds.push(memA.id);

    const memB = await insertTestMemory({
      name: 'postgres-pooler-connection-limit-notes',
      type: 'fact',
      observations: shortObs,
    });
    createdIds.push(memB.id);

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, memA.id, memB.id);
    expect(pair).toBeDefined();

    // Pair metadata is populated
    expect(typeof pair!.aName).toBe('string');
    expect(typeof pair!.bName).toBe('string');
    expect(typeof pair!.aObservationsLength).toBe('number');
    expect(typeof pair!.bObservationsLength).toBe('number');
    expect(typeof pair!.similarity).toBe('number');
    expect(pair!.similarity).toBeGreaterThan(0.85);
    expect([pair!.aId, pair!.bId]).toContain(pair!.proposedCanonicalId);
  });

  it('proposedCanonicalId points at the memory with longer observations', async () => {
    const memA = await insertTestMemory({
      name: 'canonical-length-test-a',
      type: 'fact',
      observations:
        'The canonical length picker prefers longer observations because more text usually carries more context and more context is more useful.',
    });
    createdIds.push(memA.id);

    const memB = await insertTestMemory({
      name: 'canonical-length-test-a',
      type: 'fact',
      // Identical name to memA — guarantees the pair surfaces (similarity is
      // name-only). Shorter observations exercise the length tie-break.
      observations:
        'The canonical length picker prefers longer observations because more text',
    });
    createdIds.push(memB.id);

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, memA.id, memB.id);
    expect(pair).toBeDefined();
    expect(pair!.proposedCanonicalId).toBe(memA.id);
  });

  it('proposedCanonicalId tiebreak by newer created_at when lengths are equal', async () => {
    const sameLengthObs = 'Tiebreak test observation with fixed length forty chars.';

    const memOlder = await insertTestMemory({
      name: 'canonical-tiebreak-test',
      type: 'fact',
      observations: sameLengthObs,
    });
    createdIds.push(memOlder.id);

    // Force a time gap so created_at differs
    await new Promise((r) => setTimeout(r, 50));

    const memNewer = await insertTestMemory({
      name: 'canonical-tiebreak-test',
      type: 'fact',
      observations: sameLengthObs,
    });
    createdIds.push(memNewer.id);

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, memOlder.id, memNewer.id);
    expect(pair).toBeDefined();
    expect(pair!.proposedCanonicalId).toBe(memNewer.id);
  });

  it('proposedCanonicalId is one of the two ids (deterministic) when everything is equal', async () => {
    const memA = await insertTestMemory({
      name: 'canonical-fallback-test',
      type: 'fact',
      observations: 'Identical observation text for fallback determinism check.',
    });
    createdIds.push(memA.id);

    const memB = await insertTestMemory({
      name: 'canonical-fallback-test',
      type: 'fact',
      observations: 'Identical observation text for fallback determinism check.',
    });
    createdIds.push(memB.id);

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, memA.id, memB.id);
    expect(pair).toBeDefined();
    expect([memA.id, memB.id]).toContain(pair!.proposedCanonicalId);
  });

  it('caps dedupCandidates at 100 pairs even when more exist', async () => {
    // Seed 15 memories with identical observations of the same type → C(15,2) = 105 pairs
    const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const baseObs = `Cap test observation content used for hundred pair limit check ${runId}.`;
    const seededIds = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const mem = await insertTestMemory({
        name: `cap-test-memory-${runId}-${i}`,
        type: 'fact',
        observations: baseObs,
      });
      createdIds.push(mem.id);
      seededIds.add(mem.id);
    }

    const health = await getHealth();
    // Our 15 seeded memories generate 105 intra-group pairs. The global
    // cap is 100, so dedupCandidates.length <= 100 regardless of what
    // other test data exists in the store.
    expect(health.dedupCandidates.length).toBeLessThanOrEqual(100);
    // And at least some of them should be our cap-test pairs (we injected
    // 105 identical-content candidates, which have maximal similarity).
    const capPairs = health.dedupCandidates.filter(
      (p) => seededIds.has(p.aId) || seededIds.has(p.bId),
    );
    expect(capPairs.length).toBeGreaterThan(0);
  });

  it('excludes cross-type pairs even at high similarity', async () => {
    const sharedObs =
      'Cross type predicate guard check content placeholder with enough text to clear the threshold if the predicate is missing.';

    const memA = await insertTestMemory({
      name: 'cross-type-guard-test',
      type: 'fact',
      observations: sharedObs,
    });
    createdIds.push(memA.id);

    const memB = await insertTestMemory({
      name: 'cross-type-guard-test',
      type: 'feedback', // different type
      observations: sharedObs,
    });
    createdIds.push(memB.id);

    const health = await getHealth();
    const crossTypePair = findPair(health.dedupCandidates, memA.id, memB.id);
    expect(crossTypePair).toBeUndefined();
  });

  it('excludes pairs below the 0.85 similarity threshold', async () => {
    const memA = await insertTestMemory({
      name: 'threshold-low-test-apples',
      type: 'fact',
      observations: 'Apples are red fruits that grow on trees in temperate climates.',
    });
    createdIds.push(memA.id);

    const memB = await insertTestMemory({
      name: 'threshold-low-test-rockets',
      type: 'fact',
      observations: 'Rockets are space vehicles that carry payloads into orbit.',
    });
    createdIds.push(memB.id);

    const health = await getHealth();
    const lowSimPair = findPair(health.dedupCandidates, memA.id, memB.id);
    expect(lowSimPair).toBeUndefined();
  });

  it('excludes pairs with identical observations but dissimilar names (name-only similarity)', async () => {
    // Pins the deliberate name-only narrowing: before this change, identical
    // observation bodies could push concatenated similarity over 0.85 even
    // with unrelated names. Now similarity is name-only, so this pair must
    // NOT surface despite byte-identical observations.
    const sharedObs =
      'This observation text is byte-identical across both memories on purpose to prove body text no longer contributes to dedup similarity.';

    const memA = await insertTestMemory({
      name: 'quantum-entanglement-notes',
      type: 'fact',
      observations: sharedObs,
    });
    createdIds.push(memA.id);

    const memB = await insertTestMemory({
      name: 'sourdough-starter-schedule',
      type: 'fact',
      observations: sharedObs,
    });
    createdIds.push(memB.id);

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, memA.id, memB.id);
    expect(pair).toBeUndefined();
  });

  it('proposedCanonicalId tiebreaks by created_at when both observations are null', async () => {
    const memA = await insertTestMemory({
      name: 'null-obs-tiebreak-test',
      type: 'fact',
      observations: null,
    });
    createdIds.push(memA.id);

    await new Promise((r) => setTimeout(r, 50));

    const memB = await insertTestMemory({
      name: 'null-obs-tiebreak-test',
      type: 'fact',
      observations: null,
    });
    createdIds.push(memB.id);

    const health = await getHealth();
    const pair = findPair(health.dedupCandidates, memA.id, memB.id);
    expect(pair).toBeDefined();
    // Both observations null → char_length 0 each → tiebreak by newer created_at
    expect(pair!.proposedCanonicalId).toBe(memB.id);
  });

  it('dedupCandidateCount >= dedupCandidates.length invariant holds', async () => {
    const health = await getHealth();
    expect(health.dedupCandidateCount).toBeGreaterThanOrEqual(health.dedupCandidates.length);
  });
});
