/**
 * Guards against running the integration suite against a non-local database.
 *
 * Extracted from helpers.ts into its own module so the check is unit-testable
 * without constructing a real `pg.Pool` (helpers.ts pulls in dotenv + drizzle
 * + a live connection just by being imported).
 */

/**
 * True when `url`'s host is localhost or 127.0.0.1.
 *
 * The `//` alternative matters: a credential-less URL like
 * `postgresql://localhost:5432/db` has no `@`, and an `^`/`@`-only anchor
 * would reject it — hard-failing the suite against a perfectly valid local
 * target.
 */
export function isLocalDatabaseUrl(url: string): boolean {
  return /(?:^|@|\/\/)(localhost|127\.0\.0\.1)(?::|\/)/i.test(url);
}

/**
 * True when `url` matches a known managed-Postgres host: Supabase
 * (`supabase.com` / `supabase.co`, including the `db.<ref>.supabase.co`
 * direct host) or a Supavisor-style `pooler`. Narrow and obvious on purpose —
 * this is a blast-radius backstop for the one host class that must never see
 * this suite's unconditional deletes, not a general connection-string
 * validator. Add your own provider's host pattern here if you point this repo
 * at something else.
 */
export function isKnownRemoteDatabaseUrl(url: string): boolean {
  return /supabase\.(com|co)|pooler/i.test(url);
}

/**
 * Strip `user:pass@` credentials out of a connection string before logging it.
 *
 * The `.*` is greedy and deliberately unrestricted: a password may legally
 * contain `/` or `@` (percent-encoding is conventional, not mandatory), and a
 * character-class that excluded them would either miss the match entirely and
 * log the full password, or stop at an embedded `@` and log the tail of it.
 * Matching through to the LAST `@` can only ever over-redact, which is the
 * safe direction for a string headed to a log.
 */
export function redactCredentials(url: string): string {
  return url.replace(/:\/\/.*@/, '://***@');
}

/**
 * Throws unless `databaseUrl` is local or the caller explicitly opted in —
 * UNLESS `databaseUrl` matches a known managed-Postgres host, in which case it
 * always throws, opt-in or not.
 *
 * Why the suite must never point elsewhere: pending.test.ts and
 * pending-crud.test.ts run `testDb.delete(pending)` with no WHERE clause in
 * their afterEach — the suite's only unconditional, table-wide DELETE (every
 * other integration test deletes only rows it created, by id). A stray
 * `DOTENV_CONFIG_PATH=.env.supabase npx vitest run tests/integration/` would
 * wipe a live pending queue.
 *
 * `allowNonLocal` exists for one case: a CI job that provisions an ephemeral
 * Postgres *service container*, reachable by service name rather than
 * localhost. It is deliberately NOT wired to `process.env.CI`. `CI=true` is
 * exported by a long tail of local tooling, so treating it as consent turns a
 * safety guard into a coin flip on a machine that also has a real
 * DATABASE_URL. The opt-in must be a purpose-built variable that nothing sets
 * by accident — see helpers.ts.
 *
 * The denylist above is checked FIRST and is unconditional, so even an
 * explicit opt-in cannot aim this suite at a known managed host.
 */
export function assertSafeIntegrationTarget(
  databaseUrl: string,
  allowNonLocal: boolean,
): void {
  if (isKnownRemoteDatabaseUrl(databaseUrl)) {
    throw new Error(
      'tests/integration/helpers.ts: DATABASE_URL matches a known managed-Postgres ' +
        'host (supabase.com / supabase.co / pooler). This is a hard denial that ' +
        'no opt-in lifts — this integration suite issues unconditional, table-wide ' +
        'DELETEs (see pending.test.ts / pending-crud.test.ts afterEach hooks) ' +
        'and must never run against a shared database. ' +
        `Got: ${redactCredentials(databaseUrl)}`,
    );
  }
  if (isLocalDatabaseUrl(databaseUrl) || allowNonLocal) return;
  throw new Error(
    'tests/integration/helpers.ts: DATABASE_URL must point at localhost or ' +
      '127.0.0.1. This integration suite issues unconditional, table-wide ' +
      'DELETEs (see pending.test.ts / pending-crud.test.ts afterEach hooks) ' +
      'and must never run against a shared database. Set ' +
      'ALLOW_NONLOCAL_INTEGRATION_DB=1 only for an ephemeral CI service container. ' +
      `Got: ${databaseUrl ? redactCredentials(databaseUrl) : '(unset)'}`,
  );
}
