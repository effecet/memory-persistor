/**
 * Phase 1 TDD tests: Enhanced Retrieval (v2 scoring).
 *
 * These tests define the DESIRED behavior for the v2 recall system:
 * - 8-signal hybrid scoring
 * - Trigram fuzzy matching (pg_trgm) — finds results FTS misses
 * - Graph centrality boost — well-connected memories rank higher
 * - Recency boost — recently accessed memories rank higher
 * - Access frequency boost — frequently accessed memories rank higher
 * - Hybrid WHERE clause — FTS OR trigram similarity > 0.2
 *
 * Expected to FAIL until Phase 1 implementation is complete.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { recall } from '../../src/retrieve.js';
import { bump } from '../../src/thermal.js';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  getMemory,
  closeTestDb,
} from './helpers.js';
import { entities } from '../../src/schema.js';
import { eq, sql } from 'drizzle-orm';

const PREFIX = 'v2-recall-';
const createdIds: string[] = [];

afterEach(async () => {
  // no-op — cleanup in afterAll since tests share data within describes
});

afterAll(async () => {
  await cleanupMemories(createdIds);
  await closeTestDb();
});

// ── Trigram fuzzy matching ─────────────────────────────────────────────────
// V1 uses FTS only (keyword match). V2 should use pg_trgm so partial/fuzzy
// queries return results even when exact terms don't match.

describe('trigram fuzzy matching', () => {
  let memAuth: { id: string };

  beforeAll(async () => {
    memAuth = await insertTestMemory({
      name: `${PREFIX}session token compliance rewrite`,
      type: 'project',
      tags: ['auth', 'security'],
      importance: 0.7,
      observations: 'Ripping out old auth middleware because legal flagged session token storage',
    });
    createdIds.push(memAuth.id);
  });

  it('fuzzy query finds memory that FTS misses', async () => {
    // "how we handle auth" won't FTS-match "session token compliance rewrite"
    // but trigram similarity on "auth" should match the tag/observations
    const results = (await recall({ query: 'how we handle auth' })).results;

    const found = results.find((r) => r.id === memAuth.id);
    expect(found).toBeDefined();
    expect(found!.score).toBeGreaterThan(0);
  });

  it('misspelled query still returns results', async () => {
    // "sesion token" (misspelled) should trigram-match "session token"
    const results = (await recall({ query: 'sesion token complianc' })).results;

    const found = results.find((r) => r.id === memAuth.id);
    expect(found).toBeDefined();
  });

  it('partial name match returns results', async () => {
    // "compliance" alone should match via trigram even if FTS stemming doesn't help
    const results = (await recall({ query: 'compliance rewrite' })).results;

    const found = results.find((r) => r.id === memAuth.id);
    expect(found).toBeDefined();
  });
});

// ── Graph centrality boost ─────────────────────────────────────────────────
// Memories with more edges (higher graph centrality) should rank higher
// when score is otherwise similar.

describe('graph centrality boost', () => {
  let memHub: { id: string };
  let memIsland: { id: string };
  let memSatellite1: { id: string };
  let memSatellite2: { id: string };
  let memSatellite3: { id: string };

  beforeAll(async () => {
    // Hub memory: well-connected (3 edges)
    memHub = await insertTestMemory({
      name: `${PREFIX}python testing centrality hub`,
      type: 'fact',
      tags: ['python', 'testing'],
      importance: 0.5,
      temperature: 0.5,
      tier: 'WARM',
      observations: 'Python testing best practices and conventions for the project',
    });
    createdIds.push(memHub.id);

    // Island memory: zero edges, same content relevance
    memIsland = await insertTestMemory({
      name: `${PREFIX}python testing centrality island`,
      type: 'fact',
      tags: ['python', 'testing'],
      importance: 0.5,
      temperature: 0.5,
      tier: 'WARM',
      observations: 'Python testing best practices and conventions for the project',
    });
    createdIds.push(memIsland.id);

    // Satellite memories linked to hub
    memSatellite1 = await insertTestMemory({
      name: `${PREFIX}centrality satellite one`,
      type: 'fact',
      tags: ['python'],
      importance: 0.3,
      observations: 'Satellite memory linked to hub',
    });
    createdIds.push(memSatellite1.id);

    memSatellite2 = await insertTestMemory({
      name: `${PREFIX}centrality satellite two`,
      type: 'fact',
      tags: ['testing'],
      importance: 0.3,
      observations: 'Another satellite memory linked to hub',
    });
    createdIds.push(memSatellite2.id);

    memSatellite3 = await insertTestMemory({
      name: `${PREFIX}centrality satellite three`,
      type: 'fact',
      tags: ['python'],
      importance: 0.3,
      observations: 'Third satellite memory linked to hub',
    });
    createdIds.push(memSatellite3.id);

    // Connect hub to all 3 satellites
    await insertTestRelation(memHub.id, memSatellite1.id, 'related_to');
    await insertTestRelation(memHub.id, memSatellite2.id, 'related_to');
    await insertTestRelation(memHub.id, memSatellite3.id, 'related_to');
    // Island has zero edges
  });

  it('well-connected memory ranks higher than isolated one with same content', async () => {
    const results = (await recall({ query: 'python testing centrality' })).results;

    const hubIdx = results.findIndex((r) => r.id === memHub.id);
    const islandIdx = results.findIndex((r) => r.id === memIsland.id);

    expect(hubIdx).toBeGreaterThanOrEqual(0);
    expect(islandIdx).toBeGreaterThanOrEqual(0);

    // Hub should rank higher (lower index) due to centrality boost
    expect(hubIdx).toBeLessThan(islandIdx);
  });
});

// ── Recency boost ──────────────────────────────────────────────────────────
// Recently accessed memories should score higher than stale ones
// when content relevance is otherwise equal.

describe('recency boost', () => {
  let memRecent: { id: string };
  let memStale: { id: string };

  beforeAll(async () => {
    // "Stale" memory: set last_accessed_at far in the past
    memStale = await insertTestMemory({
      name: `${PREFIX}recency test stale deployment`,
      type: 'project',
      tags: ['deploy'],
      importance: 0.5,
      temperature: 0.5,
      tier: 'WARM',
      observations: 'Deployment process for recency scoring test case',
    });
    createdIds.push(memStale.id);

    // Push last_accessed_at back 30 days
    await testDb
      .update(entities)
      .set({ lastAccessedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
      .where(eq(entities.id, memStale.id));

    // "Recent" memory: same content, freshly accessed
    memRecent = await insertTestMemory({
      name: `${PREFIX}recency test recent deployment`,
      type: 'project',
      tags: ['deploy'],
      importance: 0.5,
      temperature: 0.5,
      tier: 'WARM',
      observations: 'Deployment process for recency scoring test case',
    });
    createdIds.push(memRecent.id);
  });

  it('recently accessed memory ranks higher than stale one with same content', async () => {
    const results = (await recall({ query: 'recency deployment process' })).results;

    const recentIdx = results.findIndex((r) => r.id === memRecent.id);
    const staleIdx = results.findIndex((r) => r.id === memStale.id);

    expect(recentIdx).toBeGreaterThanOrEqual(0);
    expect(staleIdx).toBeGreaterThanOrEqual(0);

    // Recent should rank higher (lower index)
    expect(recentIdx).toBeLessThan(staleIdx);
  });
});

// ── Access frequency boost ─────────────────────────────────────────────────
// Memories accessed many times should score slightly higher than rarely-accessed ones.

describe('access frequency boost', () => {
  let memPopular: { id: string };
  let memRare: { id: string };

  beforeAll(async () => {
    memPopular = await insertTestMemory({
      name: `${PREFIX}frequency popular docker patterns`,
      type: 'fact',
      tags: ['docker'],
      importance: 0.5,
      temperature: 0.5,
      tier: 'WARM',
      observations: 'Docker patterns for frequency scoring test',
    });
    createdIds.push(memPopular.id);

    // Set high access count
    await testDb
      .update(entities)
      .set({ accessCount: 50 })
      .where(eq(entities.id, memPopular.id));

    memRare = await insertTestMemory({
      name: `${PREFIX}frequency rare docker patterns`,
      type: 'fact',
      tags: ['docker'],
      importance: 0.5,
      temperature: 0.5,
      tier: 'WARM',
      observations: 'Docker patterns for frequency scoring test',
    });
    createdIds.push(memRare.id);

    // access count stays at 0 (default)
  });

  it('frequently accessed memory ranks higher than rarely accessed one', async () => {
    const results = (await recall({ query: 'frequency docker patterns' })).results;

    const popularIdx = results.findIndex((r) => r.id === memPopular.id);
    const rareIdx = results.findIndex((r) => r.id === memRare.id);

    expect(popularIdx).toBeGreaterThanOrEqual(0);
    expect(rareIdx).toBeGreaterThanOrEqual(0);

    // Popular should rank higher (lower index)
    expect(popularIdx).toBeLessThan(rareIdx);
  });
});

// ── Hybrid WHERE clause ────────────────────────────────────────────────────
// V2 should match on FTS OR trigram similarity > 0.2, not FTS only.

describe('hybrid WHERE clause', () => {
  let memTarget: { id: string };

  beforeAll(async () => {
    memTarget = await insertTestMemory({
      name: `${PREFIX}kubernetes orchestration patterns`,
      type: 'fact',
      tags: ['k8s', 'infra'],
      importance: 0.6,
      observations: 'Container orchestration with Kubernetes for microservices deployment',
    });
    createdIds.push(memTarget.id);
  });

  it('trigram-only match (no FTS match) still returns results', async () => {
    // "k8s orchstration" has a typo and "k8s" is not a real English word for FTS,
    // but trigram similarity on "orchestration" should be high enough
    const results = (await recall({ query: 'orchestrtion patterns' })).results;

    const found = results.find((r) => r.id === memTarget.id);
    expect(found).toBeDefined();
  });

  it('FTS match still works as before', async () => {
    // Exact term match through FTS should continue to work
    const results = (await recall({ query: 'kubernetes orchestration' })).results;

    const found = results.find((r) => r.id === memTarget.id);
    expect(found).toBeDefined();
    expect(found!.score).toBeGreaterThan(0);
  });
});

// ── Tag matching fix ───────────────────────────────────────────────────────
// V1 has a bug where tags param doesn't serialize as PG array.
// V2 must fix this so tag filtering actually works.

describe('tag matching', () => {
  let memPython: { id: string };
  let memGo: { id: string };

  beforeAll(async () => {
    memPython = await insertTestMemory({
      name: `${PREFIX}tag test python conventions`,
      type: 'fact',
      tags: ['python', 'coding'],
      importance: 0.5,
      observations: 'Python coding conventions for tag matching test',
    });
    createdIds.push(memPython.id);

    memGo = await insertTestMemory({
      name: `${PREFIX}tag test golang conventions`,
      type: 'fact',
      tags: ['golang', 'coding'],
      importance: 0.5,
      observations: 'Go coding conventions for tag matching test',
    });
    createdIds.push(memGo.id);
  });

  it('tag filter boosts matching memory above non-matching one', async () => {
    // Both match FTS on "coding conventions", but passing tags=["python"]
    // should boost memPython above memGo
    const results = (await recall({ query: 'coding conventions', tags: ['python'] })).results;

    const pythonIdx = results.findIndex((r) => r.id === memPython.id);
    const goIdx = results.findIndex((r) => r.id === memGo.id);

    expect(pythonIdx).toBeGreaterThanOrEqual(0);
    // Python should rank higher due to tag match boost
    if (goIdx >= 0) {
      expect(pythonIdx).toBeLessThan(goIdx);
    }
  });

  it('tag filter does not crash (V1 bug fix)', async () => {
    // V1 crashes with "malformed array literal" when passing tags
    // V2 must handle this correctly
    const results = (await recall({ query: 'coding conventions', tags: ['python', 'coding'] })).results;

    expect(Array.isArray(results)).toBe(true);
    // Should return results, not throw
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
