/**
 * Unit tests for tests/integration/db-guard.ts — the guard that stops the
 * integration suite from ever running its unconditional `DELETE FROM pending`
 * against a shared managed database.
 */
import { describe, it, expect } from 'vitest';
import {
  isLocalDatabaseUrl,
  isKnownRemoteDatabaseUrl,
  redactCredentials,
  assertSafeIntegrationTarget,
} from './integration/db-guard.js';

describe('isLocalDatabaseUrl', () => {
  it('accepts localhost', () => {
    expect(isLocalDatabaseUrl('postgresql://user:pw@localhost:5432/db')).toBe(true);
  });

  it('accepts 127.0.0.1', () => {
    expect(isLocalDatabaseUrl('postgres://user:pw@127.0.0.1:5432/db')).toBe(true);
  });

  it('rejects a Supabase pooler host', () => {
    expect(
      isLocalDatabaseUrl(
        'postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      ),
    ).toBe(false);
  });

  it('accepts a credential-less local URL', () => {
    // No `@` in the URL — an `^`/`@`-only anchor would reject these and
    // hard-fail the suite against a valid local target.
    expect(isLocalDatabaseUrl('postgresql://localhost:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://127.0.0.1:5432/db')).toBe(true);
  });

  it('rejects the CI service hostname', () => {
    expect(isLocalDatabaseUrl('postgres://postgres:postgres@postgres:5432/test')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isLocalDatabaseUrl('')).toBe(false);
  });
});

describe('isKnownRemoteDatabaseUrl', () => {
  it('matches the db.<ref>.supabase.co direct host', () => {
    expect(
      isKnownRemoteDatabaseUrl(
        'postgresql://postgres:pw@db.exampleprojectref.supabase.co:5432/postgres',
      ),
    ).toBe(true);
  });

  it('matches a pooler host', () => {
    expect(
      isKnownRemoteDatabaseUrl(
        'postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      ),
    ).toBe(true);
  });

  it('matches any host containing "pooler"', () => {
    expect(isKnownRemoteDatabaseUrl('postgresql://a:b@some-other-pooler-host:6543/db')).toBe(true);
  });

  it('does not match localhost or the CI service hostname', () => {
    expect(isKnownRemoteDatabaseUrl('postgresql://a:b@localhost:5432/db')).toBe(false);
    expect(isKnownRemoteDatabaseUrl('postgres://postgres:postgres@postgres:5432/test')).toBe(
      false,
    );
  });
});

describe('redactCredentials', () => {
  it('strips user:pass@ from a connection string', () => {
    const out = redactCredentials('postgresql://postgres:s3cr3t@localhost:5432/memory_persistor');
    expect(out).toBe('postgresql://***@localhost:5432/memory_persistor');
    expect(out).not.toContain('s3cr3t');
  });

  it('redacts a password containing a slash', () => {
    // A non-greedy [^@/]* class never matches here, logging the whole password.
    const out = redactCredentials('postgres://user:pa/ss@localhost:5432/db');
    expect(out).not.toContain('pa/ss');
    expect(out).toContain('***@');
  });

  it('redacts a password containing an at-sign', () => {
    // Must consume through to the LAST @, not stop at the embedded one.
    const out = redactCredentials('postgres://user:p@ss@localhost:5432/db');
    expect(out).not.toContain('p@ss');
    expect(out).toBe('postgres://***@localhost:5432/db');
  });
});

describe('assertSafeIntegrationTarget', () => {
  it('does not throw for a localhost URL', () => {
    expect(() =>
      assertSafeIntegrationTarget('postgresql://a:b@localhost:5432/db', false),
    ).not.toThrow();
  });

  it('does not throw for a non-local URL when the explicit opt-in is passed', () => {
    expect(() =>
      assertSafeIntegrationTarget('postgres://postgres:postgres@postgres:5432/test', true),
    ).not.toThrow();
  });

  it('throws for a Supabase-shaped (pooler) URL without opt-in', () => {
    // This URL matches the isKnownRemoteDatabaseUrl denylist, which fires
    // before the localhost/opt-in check — so the message is the hard-denial one,
    // not the generic "must point at localhost" refusal.
    expect(() =>
      assertSafeIntegrationTarget(
        'postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
        false,
      ),
    ).toThrow(/hard denial that no opt-in lifts/);
  });

  it('throws for an unset DATABASE_URL without opt-in', () => {
    expect(() => assertSafeIntegrationTarget('', false)).toThrow(/\(unset\)/);
  });

  it('never leaks the password in the thrown message', () => {
    try {
      assertSafeIntegrationTarget('postgresql://user:s3cr3t@example.com:5432/db', false);
      throw new Error('expected assertSafeIntegrationTarget to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('s3cr3t');
    }
  });

  // The explicit opt-in must not be able to bypass the block on a known
  // managed host. The denylist fires before the opt-in check.
  describe('the opt-in cannot bypass the denylist for known-remote hosts', () => {
    it('(a) throws on the db.<ref>.supabase.co direct host even with opt-in', () => {
      expect(() =>
        assertSafeIntegrationTarget(
          'postgresql://postgres:pw@db.exampleprojectref.supabase.co:5432/postgres',
          true,
        ),
      ).toThrow(/hard denial that no opt-in lifts/);
    });

    it('(b) throws on a pooler URL even with opt-in', () => {
      expect(() =>
        assertSafeIntegrationTarget(
          'postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
          true,
        ),
      ).toThrow(/hard denial that no opt-in lifts/);
    });

    it('(c) still allows an ephemeral CI service hostname under explicit opt-in', () => {
      expect(() =>
        assertSafeIntegrationTarget(
          'postgres://postgres:postgres@postgres:5432/memory_persistor_test?sslmode=disable',
          true,
        ),
      ).not.toThrow();
    });

    it('(d) plain localhost still passes without opt-in', () => {
      expect(() =>
        assertSafeIntegrationTarget('postgresql://postgres:localdev@localhost:5432/memory_persistor', false),
      ).not.toThrow();
    });
  });
});
