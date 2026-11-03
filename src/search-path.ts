/**
 * The connection `search_path`, and nothing else.
 *
 * ⚠️ THIS MODULE MUST STAY A LEAF: no imports, and NO `process.env` reads, ever.
 *
 * It looks like it belongs in `src/config.ts`, and it deliberately does not.
 * `src/db.ts` consumes it, and ESM evaluates a module's imports BEFORE any
 * statement in its body — including `db.ts`'s `dotenv.config()`. So anything
 * `db.ts` imports has its module scope evaluated against an UNLOADED
 * environment. `config.ts` reads `process.env` at module scope
 * (`EMBED_ON_WRITE_ENABLED`, `CLAUDE_DIR`, `MEMORY_PERSISTOR_DIR`), so putting
 * this constant there and importing it from `db.ts` silently flips
 * `EMBED_ON_WRITE_ENABLED` to false on the primary machines — measured
 * 2026-09-06: `MEMORY_EMBED_ENABLED="true"` in the environment,
 * `EMBED_ON_WRITE_ENABLED === false`. Every remember/update/merge would store a
 * NULL embedding, with no error, decaying the semantic signal as new memories
 * land. `src/schema.ts` imports config type-only, which is why that edge did
 * not already exist.
 *
 * `tests/env-load-order.test.ts` pins the invariant behaviourally.
 *
 * ── Why the search_path is pinned at all ──────────────────────────────────
 *
 * Supabase installs `pg_trgm` into the `extensions` schema. The postgres role
 * carries `ALTER ROLE ... SET search_path = "$user", public, extensions`, and a
 * fresh pooled backend DOES inherit it — measured 2026-09-06, 15 of 15
 * independent connections saw `extensions`.
 *
 * The hazard is not inheritance, it is LEAKAGE. Supavisor transaction mode does
 * not reset session state between clients, so a single `SET search_path` run by
 * ANY client sticks on that backend and every later client that lands on it
 * inherits the override — until the backend recycles. Reproduced deliberately:
 * one `SET` on one connection, then 20 of 20 fresh independent connections saw
 * the injected value and `word_similarity` failed 42883 on them.
 *
 * ⚠️ The pool is therefore a MIXED population, and SEQUENTIAL sampling lies
 * about it: consecutive short-lived connections tend to reuse one backend, so
 * they report a uniform, convincingly "reproducible" result that is really one
 * backend's state. Measured the same day: 25 sequential probes reported 25/25
 * healthy while 30 CONCURRENT probes across 6 backends found 12/30 poisoned.
 * Always sample this pooler concurrently.
 *
 * The consequence was a dead tool, not a degraded signal. The unqualified
 * `word_similarity()` calls in `src/retrieve.ts`, `src/intelligence.ts` and
 * `src/graph.ts` could not resolve, and because one sits in recall's WHERE
 * clause the whole query aborted with
 * `42883 function word_similarity(unknown, unknown) does not exist`.
 *
 * Pinned on the connection rather than schema-qualifying the call sites,
 * because local Docker installs `pg_trgm` into `public` — a hardcoded
 * `extensions.word_similarity(...)` would break the offline fallback and would
 * have to be repeated across three files. One setting is correct for both:
 * Postgres tolerates a missing schema in `search_path` silently, so on local
 * Docker `extensions` simply does not exist and resolution falls through.
 */

/**
 * Schemas searched for unqualified names, IN PRECEDENCE ORDER.
 *
 * `public` MUST stay first: it holds the application's own objects (`entities`,
 * `memory_thermal_decay`), and a schema earlier in the path shadows later ones.
 * With `extensions` first, an object created there could silently take
 * precedence over an app object of the same name.
 *
 * Note this drops the `"$user"` entry that Postgres's own default carries. That
 * is intentional and safe here — the live database has zero user-named schemas
 * — and it narrows the search path, which is the safer direction for the
 * CVE-2018-1058 trojan-function class.
 */
export const SEARCH_PATH_SCHEMAS = ['public', 'extensions'] as const;

/**
 * The libpq `options` string every pool must pass. Derived from
 * SEARCH_PATH_SCHEMAS so the order above is the single source of truth.
 *
 * ⚠️ Passing `options` to a pg Pool SHORT-CIRCUITS `process.env.PGOPTIONS`, and
 * that is deliberate: a stray environment variable must not be able to abort
 * every recall. This repo already learned that lesson in `src/db.ts`, where
 * `DOTENV_CONFIG_QUIET` could defeat the dotenv fix. An `options=` embedded in
 * DATABASE_URL DOES still win (pg's connection-parameters Object.assign order);
 * `db.ts` warns loudly when it sees one rather than failing silently.
 */
export const SEARCH_PATH_OPTIONS = `-c search_path=${SEARCH_PATH_SCHEMAS.join(',')}`;
