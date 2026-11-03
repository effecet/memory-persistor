/**
 * Unit tests for the pending module's pure helpers.
 * DB-touching functions are covered in tests/integration/pending-crud.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { priorityRank, normalizeHost, normalizeScope } from '../src/pending.js';
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

/**
 * Source-level guard: drizzle/0009_pending.sql declares three CHECK
 * constraints, but the migrations here are hand-written and drizzle/meta/ is
 * gitignored, so the generator has no snapshot to learn them from. Declaring
 * them in schema.ts too is the only way a future `drizzle-kit generate` can
 * know they exist rather than silently dropping them.
 */
describe('schema.ts mirrors the 0009 CHECK constraints', () => {
  const schemaSrc = readFileSync(
    fileURLToPath(new URL('../src/schema.ts', import.meta.url)),
    'utf8',
  );

  it('declares all three pending CHECK constraints', () => {
    expect(schemaSrc).toContain('pending_category_check');
    expect(schemaSrc).toContain('pending_priority_check');
    expect(schemaSrc).toContain('pending_status_check');
  });

  it('narrows the vocabulary columns with $type<>', () => {
    expect(schemaSrc).toMatch(/\$type<PendingCategory>/);
    expect(schemaSrc).toMatch(/\$type<PendingPriority>/);
    expect(schemaSrc).toMatch(/\$type<PendingStatus>/);
  });
});

describe('normalizeHost', () => {
  it('strips a domain suffix', () => {
    expect(normalizeHost('Laptop-A.local')).toBe('laptop-a');
    expect(normalizeHost('server-b.lan')).toBe('server-b');
  });

  it('folds case', () => {
    expect(normalizeHost('SERVER-B')).toBe('server-b');
    expect(normalizeHost('Laptop-A')).toBe('laptop-a');
  });

  it('is idempotent', () => {
    // A value round-trips through a write on every update; if normalizing an
    // already-normalized host changed it, scope would drift silently.
    for (const host of ['laptop-a', 'server-b']) {
      expect(normalizeHost(normalizeHost(host))).toBe(normalizeHost(host));
    }
  });

  it('keeps the two hostnames actually present in the table distinct', () => {
    // Measured 2026-09-07: pending.origin_host is Laptop-A (160) and server-b (27).
    expect(normalizeHost('Laptop-A')).not.toBe(normalizeHost('server-b'));
  });
});

describe('schema.ts and drizzle/0011 agree on applies_to', () => {
  const schemaSrc = readFileSync(
    fileURLToPath(new URL('../src/schema.ts', import.meta.url)),
    'utf8',
  );
  const migrationSrc = readFileSync(
    fileURLToPath(new URL('../drizzle/0011_pending_applies_to.sql', import.meta.url)),
    'utf8',
  );
  // Assertions about what the migration DOES must read executable SQL only.
  // This file documents the `ADD COLUMN IF NOT EXISTS ... NOT NULL` trap by
  // quoting it, so a naive source-text match finds the very shape it is
  // asserting the absence of — the comment would fail the test it explains.
  const migrationSql = migrationSrc
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

  it('declares applies_to as a NOT NULL text[] defaulting to empty', () => {
    // NOT NULL + default is load-bearing: NULL and '{}' would be two spellings
    // of "fleet-wide" and every predicate would have to handle both forever.
    expect(schemaSrc).toContain("text('applies_to').array().notNull().default([])");
    expect(migrationSrc).toMatch(/ALTER COLUMN applies_to SET DEFAULT '\{\}'/);
    expect(migrationSrc).toMatch(/ALTER COLUMN applies_to SET NOT NULL/);
    expect(migrationSrc).toMatch(/UPDATE public\.pending SET applies_to = '\{\}'/);
  });

  it('does NOT put NOT NULL or DEFAULT on the ADD COLUMN itself', () => {
    // The trap 0009 documents, one statement over. Proven on local Docker:
    // if the column already exists in any shape, `ADD COLUMN IF NOT EXISTS
    // ... NOT NULL DEFAULT '{}'` skips the WHOLE clause with a NOTICE — not an
    // error, so ON_ERROR_STOP does not fire — leaving the column nullable with
    // no default. A NULL row then has `cardinality(NULL) = 0` evaluating to
    // NULL, matching neither branch of the scope filter: invisible everywhere.
    expect(migrationSql).not.toMatch(
      /ADD COLUMN IF NOT EXISTS applies_to[^;]*NOT NULL/,
    );
    expect(migrationSql).not.toMatch(/ADD COLUMN IF NOT EXISTS applies_to[^;]*DEFAULT/);
    // …and the ADD COLUMN really is present, so this cannot pass by the
    // statement having been renamed or removed entirely.
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS applies_to text\[\];/);
  });

  it('is an idempotent ADD COLUMN, per this repo\'s hand-written migration rule', () => {
    expect(migrationSrc).toContain('ADD COLUMN IF NOT EXISTS');
    expect(migrationSrc).toContain('CREATE INDEX IF NOT EXISTS');
  });

  it('declares the GIN index in both places', () => {
    expect(migrationSrc).toContain('USING GIN (applies_to)');
    expect(schemaSrc).toContain("index('idx_pending_applies_to').using('gin'");
  });
});

describe('normalizeScope', () => {
  it('drops entries that normalize to empty', () => {
    // `['.']` used to store `['']`: cardinality 1, matching no host, so the
    // item was invisible on EVERY machine while looking deliberately scoped.
    // The MCP layer's z.string().min(1) validates the INPUT, not the result.
    expect(normalizeScope(['.'])).toEqual([]);
    expect(normalizeScope(['.local'])).toEqual([]);
    expect(normalizeScope(['!!!'])).toEqual([]);
    expect(normalizeScope(['server-b', '...'])).toEqual(['server-b']);
  });

  it('de-duplicates spellings that normalize together', () => {
    expect(normalizeScope(['Laptop-A', 'laptop-a.local', 'LAPTOP-A'])).toEqual([
      'laptop-a',
    ]);
  });

  it('keeps an empty list empty — that is fleet-wide, not a scope', () => {
    expect(normalizeScope([])).toEqual([]);
  });

  it('never yields a value outside the SQL-safe alphabet', () => {
    const nasty = ["a'; DROP TABLE pending; --", 'x" OR 1=1', 'back\\slash'];
    for (const h of normalizeScope(nasty)) {
      expect(h).toMatch(/^[a-z0-9_-]+$/);
    }
  });
});

describe('normalizeHost strips to the SQL-safe alphabet', () => {
  it('matches the Python twin on shapes the strip changes', () => {
    // tests/test_host_normalization_parity.py runs BOTH implementations and
    // compares; these pin the TS side so a change here fails fast too.
    expect(normalizeHost('LAPTOP A')).toBe('laptopa');
    expect(normalizeHost("Fede's MacBook Pro")).toBe('fedesmacbookpro');
    expect(normalizeHost('...')).toBe('');
  });
});
