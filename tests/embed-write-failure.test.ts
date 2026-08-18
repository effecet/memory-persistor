/**
 * Non-fatal behavior of embedForWrite: a model-load/inference
 * failure must never fail remember/update — it logs to stderr and returns
 * null so the row gets embedding=NULL (the canary catches persistent NULLs).
 *
 * Mocks @huggingface/transformers so the pipeline load rejects deterministically.
 * Kept in its own file — mocking this module here would break the real-model
 * assertions in embed.test.ts / embed-write.test.ts if they shared a module registry.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockRejectedValue(new Error('simulated model-load failure')),
}));

const ENV_KEY = 'MEMORY_EMBED_ENABLED';
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe('embedForWrite failure handling', () => {
  it('returns null instead of throwing when the model fails to load', async () => {
    process.env[ENV_KEY] = 'true';
    const { embedForWrite } = await import('../src/embed.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await embedForWrite('name', 'observations');

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('resolveEmbeddingForTextChange failure handling', () => {
  it('returns undefined (preserve existing) instead of null when the model fails to load', async () => {
    process.env[ENV_KEY] = 'true';
    const { resolveEmbeddingForTextChange } = await import('../src/embed.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await resolveEmbeddingForTextChange('name', 'observations');

    // undefined (not null) tells the caller to leave the column untouched —
    // a previously-good embedding must survive a one-off model hiccup rather
    // than being clobbered to NULL.
    expect(result).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
