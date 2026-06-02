/**
 * Integration tests for graph (Mermaid) generation logic.
 * Verifies that DB queries produce correct data and that the Mermaid
 * output format matches expectations for nodes, edges, and tier classes.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { entities, memoryRelations } from '../../src/schema.js';
import {
  testDb,
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  closeTestDb,
} from './helpers.js';

// Replicate the graph-building logic from mcp-server.ts so we can verify
// the Mermaid output end-to-end without importing the MCP handler.
function buildMermaid(
  allEntities: Array<{ id: string; name: string; type: string; tier: string | null }>,
  allRelations: Array<{ fromId: string; toId: string; relationType: string }>,
): string {
  const lines: string[] = ['flowchart LR'];
  lines.push('  classDef hot fill:#ff6b6b,stroke:#c0392b,color:#fff');
  lines.push('  classDef warm fill:#f39c12,stroke:#e67e22,color:#fff');
  lines.push('  classDef cold fill:#3498db,stroke:#2980b9,color:#fff');

  const idMap = new Map<string, string>();
  for (const e of allEntities) {
    const shortId = e.id.replace(/-/g, '').slice(0, 8);
    idMap.set(e.id, shortId);
    const safeName = (e.name || '').replace(/"/g, "'").slice(0, 40);
    const label = `${safeName}\\n(${e.type})`;
    lines.push(`  ${shortId}["${label}"]`);
    const tierClass = (e.tier || 'COLD').toLowerCase();
    lines.push(`  class ${shortId} ${tierClass}`);
  }

  for (const r of allRelations) {
    const from = idMap.get(r.fromId);
    const to = idMap.get(r.toId);
    if (from && to) {
      lines.push(`  ${from} -->|${r.relationType}| ${to}`);
    }
  }

  return lines.join('\n');
}

describe('graph', () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    if (createdIds.length > 0) {
      await cleanupMemories([...createdIds]);
      createdIds.length = 0;
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('Mermaid output includes test entities as nodes', async () => {
    const memoryA = await insertTestMemory({
      name: 'graph-node-alpha',
      type: 'fact',
      observations: 'First node for graph test',
    });
    createdIds.push(memoryA.id);

    const memoryB = await insertTestMemory({
      name: 'graph-node-beta',
      type: 'decision',
      observations: 'Second node for graph test',
    });
    createdIds.push(memoryB.id);

    // Query the same way mcp-server.ts does
    const allEntities = await testDb
      .select({
        id: entities.id,
        name: entities.name,
        type: entities.type,
        tier: entities.tier,
      })
      .from(entities);

    const allRelations = await testDb
      .select({
        fromId: memoryRelations.fromId,
        toId: memoryRelations.toId,
        relationType: memoryRelations.relationType,
      })
      .from(memoryRelations);

    const mermaid = buildMermaid(allEntities, allRelations);

    // Verify header
    expect(mermaid).toContain('flowchart LR');

    // Verify both test entities appear as nodes with correct format
    const shortA = memoryA.id.replace(/-/g, '').slice(0, 8);
    const shortB = memoryB.id.replace(/-/g, '').slice(0, 8);

    expect(mermaid).toContain(`${shortA}["graph-node-alpha\\n(fact)"]`);
    expect(mermaid).toContain(`${shortB}["graph-node-beta\\n(decision)"]`);
  });

  it('Mermaid output includes relations as edges', async () => {
    const memoryA = await insertTestMemory({
      name: 'graph-edge-src',
      type: 'project',
      observations: 'Source for edge test',
    });
    createdIds.push(memoryA.id);

    const memoryB = await insertTestMemory({
      name: 'graph-edge-dst',
      type: 'project',
      observations: 'Target for edge test',
    });
    createdIds.push(memoryB.id);

    await insertTestRelation(memoryA.id, memoryB.id, 'depends_on', 1.0);

    const allEntities = await testDb
      .select({
        id: entities.id,
        name: entities.name,
        type: entities.type,
        tier: entities.tier,
      })
      .from(entities);

    const allRelations = await testDb
      .select({
        fromId: memoryRelations.fromId,
        toId: memoryRelations.toId,
        relationType: memoryRelations.relationType,
      })
      .from(memoryRelations);

    const mermaid = buildMermaid(allEntities, allRelations);

    const shortA = memoryA.id.replace(/-/g, '').slice(0, 8);
    const shortB = memoryB.id.replace(/-/g, '').slice(0, 8);

    expect(mermaid).toContain(`${shortA} -->|depends_on| ${shortB}`);
  });

  it('node classes match entity tiers', async () => {
    const hotMemory = await insertTestMemory({
      name: 'graph-tier-hot',
      type: 'fact',
      observations: 'Hot tier entity',
      temperature: 1.0,
      tier: 'HOT',
    });
    createdIds.push(hotMemory.id);

    const coldMemory = await insertTestMemory({
      name: 'graph-tier-cold',
      type: 'fact',
      observations: 'Cold tier entity',
      temperature: 0.1,
      tier: 'COLD',
    });
    createdIds.push(coldMemory.id);

    const allEntities = await testDb
      .select({
        id: entities.id,
        name: entities.name,
        type: entities.type,
        tier: entities.tier,
      })
      .from(entities);

    const allRelations = await testDb
      .select({
        fromId: memoryRelations.fromId,
        toId: memoryRelations.toId,
        relationType: memoryRelations.relationType,
      })
      .from(memoryRelations);

    const mermaid = buildMermaid(allEntities, allRelations);

    const shortHot = hotMemory.id.replace(/-/g, '').slice(0, 8);
    const shortCold = coldMemory.id.replace(/-/g, '').slice(0, 8);

    // HOT tier -> "class <id> hot"
    expect(mermaid).toContain(`class ${shortHot} hot`);
    // COLD tier -> "class <id> cold"
    expect(mermaid).toContain(`class ${shortCold} cold`);
  });
});
