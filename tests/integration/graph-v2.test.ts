/**
 * Phase 2 TDD tests: Knowledge Graph (integration tests).
 *
 * Tests traverse, auto-detect (supersedes/contradicts), and community detection
 * against a real Postgres database.
 *
 * Expected to FAIL until Phase 2 implementation is complete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  getRelations,
  closeTestDb,
} from './helpers.js';

// These will be exported from src/graph.ts once created
import { traverse, detectCommunities } from '../../src/graph.js';

// Auto-detect will be exported from a detect function
import { detectRelationType } from '../../src/graph.js';

const PREFIX = 'v2-graph-';
const createdIds: string[] = [];

afterAll(async () => {
  await cleanupMemories(createdIds);
  await closeTestDb();
});

// ── Traverse (recursive CTE) ──────────────────────────────────────────────

describe('traverse', () => {
  let memA: { id: string };
  let memB: { id: string };
  let memC: { id: string };
  let memD: { id: string };

  beforeAll(async () => {
    // Build a chain: A -> B -> C -> D
    memA = await insertTestMemory({
      name: `${PREFIX}traverse node A`,
      type: 'fact',
      observations: 'Root node for traverse test',
    });
    createdIds.push(memA.id);

    memB = await insertTestMemory({
      name: `${PREFIX}traverse node B`,
      type: 'fact',
      observations: 'Second node in traverse chain',
    });
    createdIds.push(memB.id);

    memC = await insertTestMemory({
      name: `${PREFIX}traverse node C`,
      type: 'fact',
      observations: 'Third node in traverse chain',
    });
    createdIds.push(memC.id);

    memD = await insertTestMemory({
      name: `${PREFIX}traverse node D`,
      type: 'fact',
      observations: 'Leaf node in traverse chain',
    });
    createdIds.push(memD.id);

    await insertTestRelation(memA.id, memB.id, 'related_to');
    await insertTestRelation(memB.id, memC.id, 'depends_on');
    await insertTestRelation(memC.id, memD.id, 'elaborates');
  });

  it('returns direct neighbors at depth 1', async () => {
    const result = await traverse(memA.id, { depth: 1 });

    const nodeIds = result.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain(memA.id); // root included
    expect(nodeIds).toContain(memB.id); // direct neighbor
    expect(nodeIds).not.toContain(memC.id); // 2 hops away
    expect(nodeIds).not.toContain(memD.id); // 3 hops away
  });

  it('returns 2-hop subgraph at depth 2 (default)', async () => {
    const result = await traverse(memA.id, { depth: 2 });

    const nodeIds = result.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain(memA.id);
    expect(nodeIds).toContain(memB.id);
    expect(nodeIds).toContain(memC.id);
    expect(nodeIds).not.toContain(memD.id); // 3 hops
  });

  it('returns full chain at depth 3', async () => {
    const result = await traverse(memA.id, { depth: 3 });

    const nodeIds = result.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain(memA.id);
    expect(nodeIds).toContain(memB.id);
    expect(nodeIds).toContain(memC.id);
    expect(nodeIds).toContain(memD.id);
  });

  it('includes edges in result', async () => {
    const result = await traverse(memA.id, { depth: 2 });

    expect(result.edges.length).toBeGreaterThanOrEqual(2);
    const edgeTypes = result.edges.map((e: { relationType: string }) => e.relationType);
    expect(edgeTypes).toContain('related_to');
    expect(edgeTypes).toContain('depends_on');
  });

  it('filters by relation type', async () => {
    const result = await traverse(memA.id, {
      depth: 3,
      relationTypes: ['related_to'],
    });

    // Only follows 'related_to' edges: A -> B (but B->C is 'depends_on', so stops)
    const nodeIds = result.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain(memA.id);
    expect(nodeIds).toContain(memB.id);
    expect(nodeIds).not.toContain(memC.id); // depends_on edge not followed
  });

  it('returns Mermaid subgraph', async () => {
    const result = await traverse(memA.id, { depth: 2 });

    expect(result.mermaid).toContain('flowchart LR');
    expect(result.mermaid).toContain('related_to');
  });
});

// ── Auto-detect relation types ─────────────────────────────────────────────

describe('auto-detect relation types', () => {
  it('detects supersedes when name is very similar, same type, newer', async () => {
    const oldMemory = await insertTestMemory({
      name: `${PREFIX}deployment process v1`,
      type: 'project',
      observations: 'Deploy via SSH to production server manually',
    });
    createdIds.push(oldMemory.id);

    const newMemory = await insertTestMemory({
      name: `${PREFIX}deployment process v2`,
      type: 'project',
      observations: 'Deploy via docker compose with CI/CD pipeline',
    });
    createdIds.push(newMemory.id);

    const detectedType = await detectRelationType(newMemory, oldMemory);
    expect(detectedType).toBe('supersedes');
  });

  it('detects contradicts when name similar but observations differ', async () => {
    const memX = await insertTestMemory({
      name: `${PREFIX}python version policy`,
      type: 'decision',
      observations: 'We standardize on Python 3.11 for all projects',
    });
    createdIds.push(memX.id);

    const memY = await insertTestMemory({
      name: `${PREFIX}python version policy update`,
      type: 'decision',
      observations: 'We require Python 3.13 minimum going forward',
    });
    createdIds.push(memY.id);

    const detectedType = await detectRelationType(memY, memX);
    expect(detectedType).toBe('contradicts');
  });

  it('returns related_to for general similarity', async () => {
    const memP = await insertTestMemory({
      name: `${PREFIX}docker setup guide`,
      type: 'project',
      observations: 'Use docker compose for local development',
    });
    createdIds.push(memP.id);

    const memQ = await insertTestMemory({
      name: `${PREFIX}kubernetes deployment`,
      type: 'project',
      observations: 'Deploy containers to k8s cluster in production',
    });
    createdIds.push(memQ.id);

    const detectedType = await detectRelationType(memQ, memP);
    expect(detectedType).toBe('related_to');
  });
});

// ── Community detection ────────────────────────────────────────────────────

describe('community detection', () => {
  let cluster1A: { id: string };
  let cluster1B: { id: string };
  let cluster1C: { id: string };
  let cluster2A: { id: string };
  let cluster2B: { id: string };
  let orphan: { id: string };

  beforeAll(async () => {
    // Cluster 1: three connected nodes
    cluster1A = await insertTestMemory({
      name: `${PREFIX}community cluster1 A`,
      type: 'fact',
      observations: 'Community detection test cluster 1 node A',
    });
    createdIds.push(cluster1A.id);

    cluster1B = await insertTestMemory({
      name: `${PREFIX}community cluster1 B`,
      type: 'fact',
      observations: 'Community detection test cluster 1 node B',
    });
    createdIds.push(cluster1B.id);

    cluster1C = await insertTestMemory({
      name: `${PREFIX}community cluster1 C`,
      type: 'fact',
      observations: 'Community detection test cluster 1 node C',
    });
    createdIds.push(cluster1C.id);

    // Cluster 2: two connected nodes (separate from cluster 1)
    cluster2A = await insertTestMemory({
      name: `${PREFIX}community cluster2 A`,
      type: 'fact',
      observations: 'Community detection test cluster 2 node A',
    });
    createdIds.push(cluster2A.id);

    cluster2B = await insertTestMemory({
      name: `${PREFIX}community cluster2 B`,
      type: 'fact',
      observations: 'Community detection test cluster 2 node B',
    });
    createdIds.push(cluster2B.id);

    // Orphan: no edges
    orphan = await insertTestMemory({
      name: `${PREFIX}community orphan`,
      type: 'fact',
      observations: 'Community detection test orphan node',
    });
    createdIds.push(orphan.id);

    // Wire up cluster 1
    await insertTestRelation(cluster1A.id, cluster1B.id, 'related_to');
    await insertTestRelation(cluster1B.id, cluster1C.id, 'related_to');

    // Wire up cluster 2
    await insertTestRelation(cluster2A.id, cluster2B.id, 'related_to');
  });

  it('groups connected nodes into clusters', async () => {
    const communities = await detectCommunities();

    // Find the cluster containing cluster1A
    const c1 = communities.find((c: { members: string[] }) =>
      c.members.includes(cluster1A.id),
    );
    expect(c1).toBeDefined();
    expect(c1!.members).toContain(cluster1B.id);
    expect(c1!.members).toContain(cluster1C.id);
    // Should NOT contain cluster 2 or orphan nodes
    expect(c1!.members).not.toContain(cluster2A.id);
    expect(c1!.members).not.toContain(orphan.id);
  });

  it('separates disconnected clusters', async () => {
    const communities = await detectCommunities();

    const c1 = communities.find((c: { members: string[] }) =>
      c.members.includes(cluster1A.id),
    );
    const c2 = communities.find((c: { members: string[] }) =>
      c.members.includes(cluster2A.id),
    );

    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    // They should be different clusters
    expect(c1!.members).not.toContain(cluster2A.id);
    expect(c2!.members).not.toContain(cluster1A.id);
  });

  it('orphan nodes are their own cluster or excluded', async () => {
    const communities = await detectCommunities();

    // Orphan either forms its own single-member cluster or is absent
    const orphanCluster = communities.find((c: { members: string[] }) =>
      c.members.includes(orphan.id),
    );

    if (orphanCluster) {
      // If included, should be alone
      expect(orphanCluster.members).toHaveLength(1);
    }
    // Either way is acceptable — just shouldn't be in another cluster
  });
});
