/**
 * The point of the whole rebalance: a better textual match outranks a merely
 * popular memory.
 *
 * Mirrors the reported issue's real failure — a hub with every query-independent signal
 * maxed out (temperature 1.0/HOT, high degree, high access, importance 0.9)
 * against a COLD, unimportant, never-accessed, edgeless island whose text
 * actually answers the query. Under the old additive model the hub's 0.55 budget
 * beat the island's relevance; under `relevance × (1 + α·prior)` it cannot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { recall } from '../../src/retrieve.js';
import { PRIOR_ALPHA } from '../../src/config.js';
import {
  insertTestMemory,
  insertTestRelation,
  cleanupMemories,
  closeTestDb,
} from './helpers.js';

const PREFIX = 'relevance-priors-';
const createdIds: string[] = [];
const QUERY = 'quokka husbandry humidity checklist';

describe('relevance outranks query-independent priors', () => {
  let hubId: string;
  let islandId: string;

  beforeAll(async () => {
    // Hub: every prior maxed, only a weak textual relationship to the query.
    const hub = await insertTestMemory({
      name: `${PREFIX}general purpose checklist notes`,
      observations: 'assorted checklist notes about general tooling and process',
      importance: 0.9,
      temperature: 1.0,
      tier: 'HOT',
      accessCount: 500,
    });
    hubId = hub.id;
    createdIds.push(hub.id);

    // Island: every prior at the floor, but it says exactly what was asked.
    const island = await insertTestMemory({
      name: `${PREFIX}quokka husbandry humidity checklist`,
      observations: 'quokka husbandry humidity checklist for the quokka enclosure',
      importance: 0.1,
      temperature: 0.0,
      tier: 'COLD',
      accessCount: 0,
    });
    islandId = island.id;
    createdIds.push(island.id);

    // Real centrality for the hub: satellites on both sides so its total degree
    // is high in the corpus.
    for (let i = 0; i < 6; i++) {
      const sat = await insertTestMemory({
        name: `${PREFIX}satellite ${i}`,
        observations: 'satellite memory',
        temperature: 0.0,
        tier: 'COLD',
      });
      createdIds.push(sat.id);
      await insertTestRelation(hubId, sat.id, 'related_to');
      await insertTestRelation(sat.id, hubId, 'related_to');
    }
  });

  afterAll(async () => {
    await cleanupMemories(createdIds);
    await closeTestDb();
  });

  it('ranks the matching island above the maxed-out hub', async () => {
    const results = (await recall({ query: QUERY, skipSemantic: true })).results;
    const islandIdx = results.findIndex((r) => r.id === islandId);
    const hubIdx = results.findIndex((r) => r.id === hubId);

    expect(islandIdx).toBeGreaterThanOrEqual(0);
    // If the hub is absent from the results at all, the island trivially wins;
    // assert the ordering only when both are present, but require the island.
    if (hubIdx >= 0) expect(islandIdx).toBeLessThan(hubIdx);
  });

  it('reports relevance separately from score', async () => {
    const results = (await recall({ query: QUERY, skipSemantic: true })).results;
    const island = results.find((r) => r.id === islandId);
    expect(island).toBeDefined();
    const rel = (island as { relevance: number }).relevance;
    expect(rel).toBeGreaterThan(0);
    expect(rel).toBeLessThanOrEqual(1);
    // score = relevance × (1 + α·prior), and α, prior ≥ 0, so score ≥ relevance.
    expect((island as { score: number }).score).toBeGreaterThanOrEqual(rel - 1e-9);
  });

  it('keeps every score within [0, 1+alpha]', async () => {
    const results = (await recall({ query: QUERY, skipSemantic: true })).results;
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const score = (r as { score: number }).score;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1 + PRIOR_ALPHA + 1e-9);
    }
  });

  it('lets the prior break a tie between equally relevant memories', async () => {
    /**
     * The other half of the contract, and the half nothing else pins.
     *
     * Every assertion above still passes with PRIOR_ALPHA = 0, because they only
     * require priors NOT to overturn relevance. If α were 0 the priors would be
     * dead weight and the suite would not notice. Two memories with byte-identical
     * text — so identical relevance — must therefore be ordered by their prior.
     */
    const text = 'zzyzx tiebreak corpus marker phrase';
    const cold = await insertTestMemory({
      name: `${PREFIX}tiebreak cold`,
      observations: text,
      temperature: 0.0,
      tier: 'COLD',
      importance: 0.1,
      accessCount: 0,
    });
    createdIds.push(cold.id);
    const warm = await insertTestMemory({
      name: `${PREFIX}tiebreak warm`,
      observations: text,
      temperature: 1.0,
      tier: 'HOT',
      importance: 0.9,
      accessCount: 400,
    });
    createdIds.push(warm.id);

    const results = (await recall({ query: text, skipSemantic: true })).results as unknown as {
      id: string;
      relevance: number;
      score: number;
    }[];
    const c = results.find((r) => r.id === cold.id);
    const w = results.find((r) => r.id === warm.id);
    expect(c, 'cold tiebreak memory missing').toBeDefined();
    expect(w, 'warm tiebreak memory missing').toBeDefined();

    // Same text in `observations`, so relevance should be effectively equal. (Names
    // differ by one word, so allow a small tolerance rather than exact equality.)
    expect(Math.abs(w!.relevance - c!.relevance)).toBeLessThan(0.05);
    // And the hot one must win on score — which is only possible if α > 0.
    expect(w!.score).toBeGreaterThan(c!.score);
    expect(PRIOR_ALPHA).toBeGreaterThan(0);
  });

  it('gives the island a strictly higher relevance than the hub', async () => {
    // Separates the two claims: the island must WIN ON RELEVANCE, not merely end
    // up ahead because the hub's prior happened to be small. If this fails the
    // fixture is not reproducing the hub-ranking bug's shape and the ordering test above proves
    // nothing.
    const results = (await recall({ query: QUERY, skipSemantic: true })).results;
    const island = results.find((r) => r.id === islandId) as { relevance: number };
    const hub = results.find((r) => r.id === hubId) as { relevance: number } | undefined;
    expect(island.relevance).toBeGreaterThan(0);
    if (hub) expect(island.relevance).toBeGreaterThan(hub.relevance);
  });
});
