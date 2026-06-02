/**
 * Integration tests for Phase 4: Memory Intelligence.
 * Tests: version history, merge, conflicts, dedup detection.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  getMemory,
  getRelations,
  closeTestDb,
} from './helpers.js';
import {
  snapshotVersion,
  getHistory,
  mergeMemories,
  getConflicts,
  findDedupCandidates,
} from '../../src/intelligence.js';
import { entities, memoryRelations, memoryVersions } from '../../src/schema.js';
import { eq, sql } from 'drizzle-orm';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR } from '../../src/config.js';
import { encodeProjectPath, syncToFile, syncMerge } from '../../src/file-sync.js';

// Track IDs for cleanup
const createdIds: string[] = [];

afterEach(async () => {
  // Clean up versions first (FK constraint), then entities
  for (const id of createdIds) {
    await testDb.delete(memoryVersions).where(eq(memoryVersions.memoryId, id)).catch(() => {});
  }
  await cleanupMemories(createdIds.splice(0));
});

afterAll(async () => {
  await closeTestDb();
});

// ── Version history ─────────────────────────────────────────────────────────

describe('snapshotVersion + getHistory', () => {
  it('saves a snapshot of the current memory state', async () => {
    const mem = await insertTestMemory({
      name: 'version-test-memory',
      observations: 'original content',
      tags: ['v1'],
      importance: 0.5,
    });
    createdIds.push(mem.id);

    await snapshotVersion(mem.id);

    const history = await getHistory(mem.id);
    expect(history).toHaveLength(1);
    expect(history[0].name).toBe('version-test-memory');
    expect(history[0].observations).toBe('original content');
    expect(history[0].tags).toEqual(['v1']);
    expect(history[0].importance).toBeCloseTo(0.5);
  });

  it('returns versions ordered by changedAt descending (newest first)', async () => {
    const mem = await insertTestMemory({
      name: 'version-order-test',
      observations: 'v1 content',
    });
    createdIds.push(mem.id);

    // Snapshot v1
    await snapshotVersion(mem.id);

    // Update and snapshot v2
    await testDb
      .update(entities)
      .set({ observations: 'v2 content' })
      .where(eq(entities.id, mem.id));
    await snapshotVersion(mem.id);

    const history = await getHistory(mem.id);
    expect(history).toHaveLength(2);
    // Newest first
    expect(history[0].observations).toBe('v2 content');
    expect(history[1].observations).toBe('v1 content');
  });

  it('returns empty array for memory with no versions', async () => {
    const mem = await insertTestMemory({ name: 'no-versions-test' });
    createdIds.push(mem.id);

    const history = await getHistory(mem.id);
    expect(history).toHaveLength(0);
  });

  it('cascade-deletes versions when memory is deleted', async () => {
    const mem = await insertTestMemory({ name: 'cascade-delete-test' });
    createdIds.push(mem.id);

    await snapshotVersion(mem.id);
    await snapshotVersion(mem.id);

    // Delete the entity — versions should cascade
    await testDb.delete(entities).where(eq(entities.id, mem.id));
    createdIds.splice(createdIds.indexOf(mem.id), 1); // already cleaned up

    const history = await getHistory(mem.id);
    expect(history).toHaveLength(0);
  });
});

// ── Merge ───────────────────────────────────────────────────────────────────

describe('mergeMemories', () => {
  it('appends source observations to target', async () => {
    const target = await insertTestMemory({
      name: 'merge-target',
      observations: 'target content',
      tags: ['tag-a'],
      importance: 0.6,
    });
    const source = await insertTestMemory({
      name: 'merge-source',
      observations: 'source content',
      tags: ['tag-b'],
      importance: 0.8,
    });
    createdIds.push(target.id, source.id);

    const result = await mergeMemories(source.id, target.id);

    expect(result.targetId).toBe(target.id);
    expect(result.sourceDeleted).toBe(true);

    const merged = await getMemory(target.id);
    expect(merged).not.toBeNull();
    expect(merged!.observations).toContain('target content');
    expect(merged!.observations).toContain('source content');
    expect(merged!.observations).toContain('Merged from: merge-source');

    // Source should be deleted
    const deletedSource = await getMemory(source.id);
    expect(deletedSource).toBeNull();

    // Remove source from cleanup (already deleted)
    createdIds.splice(createdIds.indexOf(source.id), 1);
  });

  it('unions tags and keeps higher importance', async () => {
    const target = await insertTestMemory({
      name: 'merge-tags-target',
      tags: ['a', 'b'],
      importance: 0.3,
    });
    const source = await insertTestMemory({
      name: 'merge-tags-source',
      tags: ['b', 'c'],
      importance: 0.7,
    });
    createdIds.push(target.id, source.id);

    await mergeMemories(source.id, target.id);

    const merged = await getMemory(target.id);
    expect(merged!.tags).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(merged!.tags).toHaveLength(3);
    expect(merged!.importance).toBeCloseTo(0.7);

    createdIds.splice(createdIds.indexOf(source.id), 1);
  });

  it('transfers edges from source to target', async () => {
    const target = await insertTestMemory({ name: 'merge-edge-target' });
    const source = await insertTestMemory({ name: 'merge-edge-source' });
    const neighbor = await insertTestMemory({ name: 'merge-edge-neighbor' });
    createdIds.push(target.id, source.id, neighbor.id);

    // Source has an edge to neighbor
    await insertTestRelation(source.id, neighbor.id, 'related_to');

    const result = await mergeMemories(source.id, target.id);

    expect(result.edgesTransferred).toBeGreaterThanOrEqual(1);

    // Target should now have edge to neighbor
    const targetRelations = await getRelations(target.id);
    const hasNeighborEdge = (targetRelations as any[]).some(
      (r) =>
        (r.from_id === target.id && r.to_id === neighbor.id) ||
        (r.to_id === target.id && r.from_id === neighbor.id),
    );
    expect(hasNeighborEdge).toBe(true);

    createdIds.splice(createdIds.indexOf(source.id), 1);
  });

  it('creates version snapshots for both source and target before merge', async () => {
    const target = await insertTestMemory({ name: 'merge-snapshot-target' });
    const source = await insertTestMemory({ name: 'merge-snapshot-source' });
    createdIds.push(target.id, source.id);

    await mergeMemories(source.id, target.id);

    // Target should have a version snapshot from before the merge
    const targetHistory = await getHistory(target.id);
    expect(targetHistory.length).toBeGreaterThanOrEqual(1);
    expect(targetHistory.some((v) => v.name === 'merge-snapshot-target')).toBe(true);

    // Source versions cascade-deleted with the source entity
    // (This is expected behavior — source is gone)
    createdIds.splice(createdIds.indexOf(source.id), 1);
  });

  it('differing slug: merge clears the source markdown orphan + MEMORY.md line', async () => {
    const isoSource = `/tmp/mem-merge-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const projectDir = join(CLAUDE_DIR, 'projects', encodeProjectPath(isoSource));
    const memDir = join(projectDir, 'memory');
    mkdirSync(memDir, { recursive: true });
    try {
      const srcMem = await insertTestMemory({
        name: 'merge orphan source', observations: 'src obs', source: isoSource,
      });
      const tgtMem = await insertTestMemory({
        name: 'merge orphan target', observations: 'tgt obs', source: isoSource,
      });
      createdIds.push(srcMem.id, tgtMem.id);

      const toEntity = (m: typeof srcMem) => ({
        id: m.id, name: m.name, type: m.type,
        observations: m.observations as string, source: m.source as string,
        temperature: 0.5, tier: 'WARM',
      });
      syncToFile(toEntity(srcMem));
      syncToFile(toEntity(tgtMem));

      const srcPath = join(memDir, 'fact_merge-orphan-source.md');
      const tgtPath = join(memDir, 'fact_merge-orphan-target.md');
      expect(existsSync(srcPath)).toBe(true);

      // Capture source BEFORE merge (mergeMemories deletes the row), as the handler does.
      const srcSnapshot = toEntity(srcMem);
      await mergeMemories(srcMem.id, tgtMem.id);
      const current = await getMemory(tgtMem.id);
      syncMerge(srcSnapshot, {
        id: current!.id, name: current!.name, type: current!.type,
        observations: current!.observations as string, source: current!.source as string,
        temperature: 0.5, tier: 'WARM',
      });

      expect(existsSync(srcPath)).toBe(false);
      expect(existsSync(tgtPath)).toBe(true);
      const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      expect(index).not.toContain('merge-orphan-source');
      expect(index).toContain('merge-orphan-target');

      // Source is gone from PG (mergeMemories deleted it) — drop from cleanup list.
      createdIds.splice(createdIds.indexOf(srcMem.id), 1);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('throws when source or target not found', async () => {
    const target = await insertTestMemory({ name: 'merge-notfound-target' });
    createdIds.push(target.id);

    const fakeId = '00000000-0000-0000-0000-000000000000';
    await expect(mergeMemories(fakeId, target.id)).rejects.toThrow('Memory not found');
  });
});

// ── Conflicts ───────────────────────────────────────────────────────────────

describe('getConflicts', () => {
  it('returns pairs connected by contradicts edges', async () => {
    const mem1 = await insertTestMemory({ name: 'conflict-mem-1', observations: 'version A' });
    const mem2 = await insertTestMemory({ name: 'conflict-mem-2', observations: 'version B' });
    createdIds.push(mem1.id, mem2.id);

    await insertTestRelation(mem1.id, mem2.id, 'contradicts');

    const conflicts = await getConflicts();
    const found = conflicts.find(
      (c) =>
        (c.from.id === mem1.id && c.to.id === mem2.id) ||
        (c.from.id === mem2.id && c.to.id === mem1.id),
    );

    expect(found).toBeDefined();
    expect(found!.from.name).toBeTruthy();
    expect(found!.to.name).toBeTruthy();
  });

  it('returns empty when no contradicts edges exist', async () => {
    // Clean up any contradicts edges first
    const mem1 = await insertTestMemory({ name: 'no-conflict-1' });
    const mem2 = await insertTestMemory({ name: 'no-conflict-2' });
    createdIds.push(mem1.id, mem2.id);

    // Only related_to edge, not contradicts
    await insertTestRelation(mem1.id, mem2.id, 'related_to');

    const conflicts = await getConflicts();
    const found = conflicts.find(
      (c) =>
        (c.from.id === mem1.id && c.to.id === mem2.id) ||
        (c.from.id === mem2.id && c.to.id === mem1.id),
    );

    expect(found).toBeUndefined();
  });
});

// ── Dedup detection ─────────────────────────────────────────────────────────

describe('findDedupCandidates', () => {
  it('finds near-duplicate memories with similarity > 0.85', async () => {
    const original = await insertTestMemory({
      name: 'PostgreSQL database connection pooling best practices',
      type: 'fact',
      observations: 'Use connection pooling with PgBouncer for production PostgreSQL deployments',
    });
    createdIds.push(original.id);

    // Search with very similar text
    const candidates = await findDedupCandidates(
      null,
      'PostgreSQL database connection pooling best practices',
      'Use connection pooling with PgBouncer for production PostgreSQL deployments',
      'fact',
    );

    const found = candidates.find((c) => c.id === original.id);
    expect(found).toBeDefined();
    expect(found!.similarity).toBeGreaterThan(0.85);
  });

  it('excludes the entity itself when entityId is provided', async () => {
    const mem = await insertTestMemory({
      name: 'self-exclude-dedup-test',
      type: 'fact',
      observations: 'Some unique observations for dedup self-exclude testing',
    });
    createdIds.push(mem.id);

    const candidates = await findDedupCandidates(
      mem.id,
      'self-exclude-dedup-test',
      'Some unique observations for dedup self-exclude testing',
      'fact',
    );

    expect(candidates.find((c) => c.id === mem.id)).toBeUndefined();
  });

  it('only matches same type', async () => {
    const fact = await insertTestMemory({
      name: 'type-filter-dedup',
      type: 'fact',
      observations: 'This is a fact about type filtering in dedup detection',
    });
    createdIds.push(fact.id);

    // Search with same text but different type
    const candidates = await findDedupCandidates(
      null,
      'type-filter-dedup',
      'This is a fact about type filtering in dedup detection',
      'project', // different type
    );

    expect(candidates.find((c) => c.id === fact.id)).toBeUndefined();
  });
});
