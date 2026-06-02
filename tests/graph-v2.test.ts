/**
 * Phase 2 TDD tests: Relation ontology validation (unit tests).
 *
 * Expected to FAIL until Phase 2 implementation is complete.
 */
import { describe, it, expect } from 'vitest';

// These will be exported from src/graph.ts once created
// For now, import will fail — that's the TDD red phase
import { RELATION_TYPES, isValidRelationType } from '../src/graph.js';

describe('relation ontology', () => {
  it('defines all 5 relation types', () => {
    expect(RELATION_TYPES).toContain('related_to');
    expect(RELATION_TYPES).toContain('supersedes');
    expect(RELATION_TYPES).toContain('contradicts');
    expect(RELATION_TYPES).toContain('elaborates');
    expect(RELATION_TYPES).toContain('depends_on');
    expect(RELATION_TYPES).toHaveLength(5);
  });

  it('validates known relation types', () => {
    expect(isValidRelationType('related_to')).toBe(true);
    expect(isValidRelationType('supersedes')).toBe(true);
    expect(isValidRelationType('contradicts')).toBe(true);
    expect(isValidRelationType('elaborates')).toBe(true);
    expect(isValidRelationType('depends_on')).toBe(true);
  });

  it('rejects unknown relation types', () => {
    expect(isValidRelationType('foo')).toBe(false);
    expect(isValidRelationType('')).toBe(false);
  });
});
