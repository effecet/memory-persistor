/**
 * Write-path embedding helpers: embedText() builds the text
 * fed to the model; embedForWrite() gates on EMBED_ON_WRITE_ENABLED (dev-only-embed)
 * and is non-fatal on failure (covered separately in embed-write-failure.test.ts,
 * which mocks the model loader — kept out of this file so the real-model tests
 * here aren't affected by that mock).
 *
 * EMBED_ON_WRITE_ENABLED is a config.ts constant read from process.env at module load,
 * so toggling it per-test requires vi.resetModules() + a fresh dynamic import
 * (ESM caches the first evaluation otherwise).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { EMBED_DIMS } from '../src/config.js';

const ENV_KEY = 'MEMORY_EMBED_ENABLED';
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
  vi.resetModules();
});

beforeAll(async () => {
  const { env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
});

describe('embedText', () => {
  it('joins name and observations with a newline', async () => {
    const { embedText } = await import('../src/embed.js');
    expect(embedText('foo', 'bar')).toBe('foo\nbar');
  });

  it('treats null/undefined observations as empty', async () => {
    const { embedText } = await import('../src/embed.js');
    expect(embedText('foo', null)).toBe('foo\n');
    expect(embedText('foo', undefined)).toBe('foo\n');
  });
});

describe('embedForWrite', () => {
  it('returns null without embedding when EMBED_ON_WRITE_ENABLED is off', async () => {
    delete process.env[ENV_KEY];
    vi.resetModules();
    const { embedForWrite } = await import('../src/embed.js');
    const result = await embedForWrite('name', 'observations');
    expect(result).toBeNull();
  });

  it('returns an EMBED_DIMS-length vector when EMBED_ON_WRITE_ENABLED is on', async () => {
    process.env[ENV_KEY] = 'true';
    vi.resetModules();
    const { embedForWrite } = await import('../src/embed.js');
    const result = await embedForWrite('embed-write-test', 'some real observations to embed');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(EMBED_DIMS);
  }, 30_000);
});

describe('resolveEmbeddingForTextChange', () => {
  it('returns null (invalidate) when EMBED_ON_WRITE_ENABLED is off', async () => {
    delete process.env[ENV_KEY];
    vi.resetModules();
    const { resolveEmbeddingForTextChange } = await import('../src/embed.js');
    const result = await resolveEmbeddingForTextChange('name', 'observations');
    expect(result).toBeNull();
  });

  it('returns a vector when EMBED_ON_WRITE_ENABLED is on and embedding succeeds', async () => {
    process.env[ENV_KEY] = 'true';
    vi.resetModules();
    const { resolveEmbeddingForTextChange } = await import('../src/embed.js');
    const result = await resolveEmbeddingForTextChange('resolve-test', 'some real observations');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(result).toHaveLength(EMBED_DIMS);
  }, 30_000);
});
