import { describe, it, expect, beforeAll } from 'vitest';
import { embed, toPgVector } from '../src/embed.js';
import { EMBED_DIMS } from '../src/config.js';

// The bge-small model is cached locally after its first download.
// Force cache-only so this unit test needs no network.
beforeAll(async () => {
  const { env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
});

describe('toPgVector', () => {
  it('formats a number[] as a pgvector literal', () => {
    expect(toPgVector([0.1, 0.2, -0.3])).toBe('[0.1,0.2,-0.3]');
  });

  it('formats an empty vector', () => {
    expect(toPgVector([])).toBe('[]');
  });
});

describe('embed', () => {
  it('returns an EMBED_DIMS-length vector', async () => {
    const v = await embed('hello world');
    expect(v).toHaveLength(EMBED_DIMS);
  }, 30_000);

  it('is L2-normalized (norm ~ 1.0)', async () => {
    const v = await embed('refresh docs and badges before pushing');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  }, 30_000);

  it('is deterministic for the same input', async () => {
    const a = await embed('deterministic check');
    const b = await embed('deterministic check');
    expect(a).toEqual(b);
  }, 30_000);

  it('produces different vectors for different inputs', async () => {
    const a = await embed('the DualSense controller will not bind over bluetooth');
    const b = await embed('Supabase pooler hostname varies by region');
    expect(a).not.toEqual(b);
  }, 30_000);

  it('handles the empty string without throwing', async () => {
    const v = await embed('');
    expect(v).toHaveLength(EMBED_DIMS);
  }, 30_000);
});
