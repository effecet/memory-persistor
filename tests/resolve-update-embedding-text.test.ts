/**
 * resolveUpdateEmbeddingText — which (name, observations) pair a partial
 * `update` embeds.
 *
 * A separate pure function so this decision is unit-testable without a
 * database. (The `update` handler that consumes it lives in src/mcp-tools.ts
 * and is now also reachable end-to-end via tests/integration/mcp-harness.ts.)
 *
 * The four combinations below are the ones the handler actually reaches — it
 * only calls this when at least one of the two fields was provided.
 */
import { describe, it, expect } from 'vitest';
import { resolveUpdateEmbeddingText } from '../src/embed.js';

const existing = { name: 'stored name', observations: 'stored observations' };

describe('resolveUpdateEmbeddingText', () => {
  it('takes both halves from the request when both are provided', () => {
    expect(resolveUpdateEmbeddingText('new name', 'new obs', existing)).toEqual({
      name: 'new name',
      observations: 'new obs',
    });
  });

  it('falls back to the stored observations when only the name changed', () => {
    expect(resolveUpdateEmbeddingText('new name', undefined, existing)).toEqual({
      name: 'new name',
      observations: 'stored observations',
    });
  });

  it('falls back to the stored name when only the observations changed', () => {
    expect(resolveUpdateEmbeddingText(undefined, 'new obs', existing)).toEqual({
      name: 'stored name',
      observations: 'new obs',
    });
  });

  it('preserves an explicit empty-string observations instead of restoring the stored text', () => {
    // The regression `||` would cause: clearing a memory's observations is a
    // real edit, and the embedding must reflect the cleared text, not resurrect
    // what was there before. `??` is what makes this pass.
    expect(resolveUpdateEmbeddingText(undefined, '', existing)).toEqual({
      name: 'stored name',
      observations: '',
    });
  });

  it('passes a stored NULL observations through unchanged', () => {
    // entities.observations is nullable; embedText/embedForWrite accept null.
    expect(
      resolveUpdateEmbeddingText('new name', undefined, { name: 'stored name', observations: null }),
    ).toEqual({ name: 'new name', observations: null });
  });
});
