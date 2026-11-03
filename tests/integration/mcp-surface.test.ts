import { closeTestDb } from './helpers.js';
import { connectHarness, parseOk, resultText, type Harness } from './mcp-harness.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const EXPECTED_TOOLS = [
  'analytics', 'conflicts', 'forget', 'graph', 'health', 'history', 'merge',
  'pending_add', 'pending_list', 'pending_resolve', 'pending_update',
  'recall', 'recall_by_ids', 'relate', 'remember', 'status', 'traverse', 'update',
];

let h: Harness;
beforeAll(async () => {
  h = await connectHarness();
});
afterAll(async () => {
  await h.close();
  await closeTestDb();
});

describe('MCP surface through a real client', () => {
  it('lists exactly the 18 tools, names unchanged', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it('every tool advertises its description and an object input schema', async () => {
    const { tools } = await h.client.listTools();
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type, t.name).toBe('object');
    }
  });

  it('a no-argument tool round-trips (status)', async () => {
    const body = parseOk(await h.client.callTool({ name: 'status', arguments: {} }));
    expect(body).toHaveProperty('total');
  });

  it('health serializes indented, as the handler emits it', async () => {
    const text = resultText(await h.client.callTool({ name: 'health', arguments: {} }));
    expect(text).toContain('\n');
  });
});
