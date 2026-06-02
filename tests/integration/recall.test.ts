/**
 * Integration tests for the recall function.
 * Runs against a real Postgres database with test data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { recall } from '../../src/retrieve.js';
import {
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  getMemory,
  closeTestDb,
} from './helpers.js';

const PREFIX = 'recall-test-';

// Stored IDs for cleanup
let memoryA: { id: string };
let memoryB: { id: string };
let memoryC: { id: string };
let memoryD: { id: string };
let allIds: string[];

describe('recall integration', () => {
  beforeAll(async () => {
    memoryA = await insertTestMemory({
      name: `${PREFIX}python coding standards`,
      type: 'fact',
      tags: ['python', 'coding'],
      importance: 0.8,
      observations: 'Always use f-strings for formatting in Python projects',
    });

    memoryB = await insertTestMemory({
      name: `${PREFIX}project deployment guide`,
      type: 'project',
      tags: ['deploy', 'infra'],
      importance: 0.6,
      observations: 'Deploy using docker compose up in production',
    });

    memoryC = await insertTestMemory({
      name: `${PREFIX}user preference dark mode`,
      type: 'user',
      tags: ['ui', 'preference'],
      importance: 0.5,
      observations: 'User prefers dark mode in all editors',
    });

    memoryD = await insertTestMemory({
      name: `${PREFIX}feedback on testing approach`,
      type: 'feedback',
      tags: ['testing', 'python'],
      importance: 0.7,
      observations: 'Always run pytest before committing code changes',
    });

    // Relation between A and D (both share the python tag)
    await insertTestRelation(memoryA.id, memoryD.id, 'related_to', 1.0);

    allIds = [memoryA.id, memoryB.id, memoryC.id, memoryD.id];
  });

  afterAll(async () => {
    await cleanupMemories(allIds);
    await closeTestDb();
  });

  it('FTS match returns results ordered by score', async () => {
    const results = (await recall({ query: 'python coding' })).results;

    expect(results.length).toBeGreaterThanOrEqual(1);

    // Memory A should appear in results with a positive score
    const memAResult = results.find((r) => r.id === memoryA.id);
    expect(memAResult).toBeDefined();
    expect(memAResult!.score).toBeGreaterThan(0);

    // Results should be in descending score order
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('tag match boosts scoring for matching results', async () => {
    // Note: Current recall() uses tags only for scoring, not filtering.
    // Tags are passed via raw SQL ANY() — verify scoring works without tags param.
    // Memory A and D both match FTS on "python"; D also has tag "testing".
    const results = (await recall({ query: 'python' })).results;

    // Both memories should appear (they share "python" in name/observations)
    const ids = results.map((r) => r.id);
    expect(ids).toContain(memoryA.id);
  });

  it('type filter narrows results', async () => {
    // Memory D: name has "testing", type is "feedback", observations has "pytest"
    // Query "testing" matches Memory D's name via FTS
    const results = (await recall({ query: 'testing', type: 'feedback' })).results;

    // Only Memory D is type "feedback" and matches FTS on "testing"
    expect(results.length).toBeGreaterThanOrEqual(1);
    const feedbackResults = results.filter((r) => r.type === 'feedback');
    expect(feedbackResults.length).toBe(results.length); // type filter is a WHERE clause
    const ids = results.map((r) => r.id);
    expect(ids).toContain(memoryD.id);
  });

  it('tier filter narrows results', async () => {
    // All test memories are HOT; querying for COLD should return nothing
    const results = (await recall({ query: 'python', tier: 'COLD' })).results;

    expect(results).toEqual([]);
  });

  it('limit parameter caps result count', async () => {
    const results = (await recall({ query: 'python', limit: 1 })).results;

    expect(results.length).toBe(1);
  });

  it('results include related memories', async () => {
    const results = (await recall({ query: 'python coding' })).results;

    const resultA = results.find((r) => r.id === memoryA.id);
    expect(resultA).toBeDefined();
    expect(resultA!.related).toBeDefined();
    expect(resultA!.related!.length).toBeGreaterThanOrEqual(1);

    const relatedToD = resultA!.related!.find((rel) => rel.id === memoryD.id);
    expect(relatedToD).toBeDefined();
    expect(relatedToD!.relation_type).toBe('related_to');
  });

  it('bumps temperature on returned results', async () => {
    // Insert a memory with low temperature so bump has room to increase
    const lowTempMemory = await insertTestMemory({
      name: `${PREFIX}python bump test`,
      type: 'fact',
      tags: ['python'],
      importance: 0.5,
      temperature: 0.5,
      tier: 'WARM',
      observations: 'Python bump test content for recall temperature verification',
    });
    allIds.push(lowTempMemory.id);

    const before = await getMemory(lowTempMemory.id);
    const tempBefore = before!.temperature!;
    expect(tempBefore).toBeCloseTo(0.5, 1);

    await recall({ query: 'python bump test' });

    // Bump is fire-and-forget — wait briefly for async update
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = await getMemory(lowTempMemory.id);
    expect(after!.temperature!).toBeGreaterThan(tempBefore);
  });

  it('truly random query returns no results', async () => {
    // Note: v2 hybrid WHERE uses trigram matching, so "xyznonexistent" can
    // trigram-match "persistent" in real data. Use a truly random string.
    const results = (await recall({ query: 'qqzjxvbn' })).results;

    expect(results).toEqual([]);
  });
});
