/**
 * Unit tests for the pending module's pure helpers.
 * DB-touching functions are covered in tests/integration/pending-crud.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { priorityRank } from '../src/pending.js';
import {
  PENDING_CATEGORIES,
  PENDING_PRIORITIES,
  PENDING_STATUSES,
  PENDING_BRIEF_LIMIT,
} from '../src/config.js';

describe('priorityRank', () => {
  it('ranks high above medium above low', () => {
    expect(priorityRank('high')).toBe(0);
    expect(priorityRank('medium')).toBe(1);
    expect(priorityRank('low')).toBe(2);
  });

  it('ranks an unknown priority last, same as low', () => {
    expect(priorityRank('bogus')).toBe(2);
  });

  it('sorts a mixed list into high, medium, low order', () => {
    const input = ['low', 'high', 'medium', 'high'];
    const sorted = [...input].sort((a, b) => priorityRank(a) - priorityRank(b));
    expect(sorted).toEqual(['high', 'high', 'medium', 'low']);
  });
});

describe('pending vocabularies', () => {
  it('exposes the exact category vocabulary', () => {
    expect([...PENDING_CATEGORIES]).toEqual(['skill', 'rule', 'automation', 'knowledge']);
  });

  it('exposes the exact priority vocabulary', () => {
    expect([...PENDING_PRIORITIES]).toEqual(['low', 'medium', 'high']);
  });

  it('exposes the exact status vocabulary', () => {
    expect([...PENDING_STATUSES]).toEqual(['open', 'done', 'archived']);
  });

  it('caps the session brief at 10 items', () => {
    expect(PENDING_BRIEF_LIMIT).toBe(10);
  });
});
