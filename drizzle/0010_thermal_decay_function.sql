-- 0010_thermal_decay_function.sql
--
-- Version-controls the nightly thermal decay.
--
-- WHY: the decay query was previously duplicated as raw SQL at each place that
-- ran it, so the definition that actually executed nightly depended on which
-- environment you were in. On a managed instance it typically lived ONLY as a
-- live `cron.job` row — in no migration and no script — where it could drift
-- from src/config.ts with nothing to catch it. This migration makes the
-- function the single definition and points the schedule at it.
--
-- KNOWN REMAINING COPIES (local Docker only — see initdb/01-pg-cron.sql):
--   1. That file's own `cron.schedule('memory-thermal-decay', ...)` seeds the
--      job with an inline CTE at container-init time, before any migration has
--      run. Applying this migration afterwards unschedules and replaces it, so
--      the function wins — but on a container where 0010 was never applied, the
--      inline copy is what runs.
--   2. `public.decay_catchup()` in the same file mirrors the decay SQL inline
--      for its `@reboot` catch-up pass and is NOT replaced by this migration.
-- Both are pinned to the same constants by tests/test_thermal_decay_migration.py
-- only insofar as that guard covers THIS file; a change to the decay maths must
-- still be applied to initdb/01-pg-cron.sql by hand.
--
-- Constants below are duplicated from src/config.ts and pinned by
-- tests/test_thermal_decay_migration.py. Note that 0.1 encodes
-- PATTERN_MULTIPLIER_BASE (1.1) - 1.0 — a naive substring check would miss it,
-- so the guard asserts the encoded form explicitly.
--
-- WHY plpgsql AND NOT A SINGLE SQL STATEMENT: the decay UPDATE and the
-- stale-flag UPDATE must run as two SEPARATE statements. Folded into one
-- statement as sibling data-modifying CTEs they would share a snapshot, so the
-- stale pass would not see the tiers the decay pass just wrote — and two CTEs
-- updating public.entities in the same statement can also collide outright.
-- The live cron command ran them as two statements; this preserves that.
--
-- WHY THE FUNCTION RETURNS ROWS: Postgres cannot reach any machine's
-- filesystem, which is exactly why the scheduled path leaves markdown
-- frontmatter stale. decayAll() in src/thermal.ts calls this function and then
-- runs its syncToFile loop over the returned rows, so the TypeScript keeps the
-- file-sync half that SQL structurally cannot own.
--
-- Idempotent: CREATE OR REPLACE, plus an unschedule guard before cron.schedule
-- (pg_cron only made schedule upsert-by-name in 1.4; the guard makes this safe
-- on older builds too). Apply local Docker first, then the managed instance.
-- Never run `make migrate` or `npx drizzle-kit generate` — migrations here are
-- hand-written and drizzle/meta/ is gitignored, so the generator would emit a
-- destructive from-scratch schema.

CREATE OR REPLACE FUNCTION public.memory_thermal_decay()
RETURNS TABLE (
  id            uuid,
  name          text,
  type          text,
  observations  text,
  temperature   real,
  tier          text,
  source        text,
  importance    real,
  access_count  integer
)
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- Pass 1 — pattern-aware decay + auto-importance drift.
  -- Inner aliases are deliberately distinct (d_*) from the RETURNS TABLE output
  -- parameter names: bare `id` / `name` inside the body would resolve to the
  -- output parameters, not the columns, and error as ambiguous.
  RETURN QUERY
  WITH decay_rates AS (
    SELECT
      src.id AS ent_id,
      CASE
        WHEN bit_count(COALESCE(src.access_bitmap, 0)::bit(7))::real >= 3::real
        THEN LEAST(1.0::real, 0.85::real + (1.0::real - 0.85::real) * (
          0.1::real
          + (bit_count(COALESCE(src.access_bitmap, 0)::bit(7))::real - 3::real)
            * 0.02::real
        ))
        ELSE 0.85::real
      END AS effective_rate
    FROM public.entities src
    WHERE src.last_accessed_at < NOW() - (INTERVAL '1 hour' * 24)
  ),
  decayed AS (
    UPDATE public.entities e
    SET
      temperature = GREATEST(0.0, e.temperature * dr.effective_rate),
      tier = CASE
        WHEN GREATEST(0.0, e.temperature * dr.effective_rate) > 0.7 THEN 'HOT'
        WHEN GREATEST(0.0, e.temperature * dr.effective_rate) > 0.3 THEN 'WARM'
        ELSE 'COLD'
      END,
      importance = CASE
        WHEN e.access_count >= 5
          THEN LEAST(0.9::real, e.importance + 0.05::real)
        WHEN e.last_accessed_at < NOW() - (INTERVAL '1 day' * 60)
          THEN GREATEST(0.1::real, e.importance - 0.05::real)
        ELSE e.importance
      END
    FROM decay_rates dr
    WHERE e.id = dr.ent_id
    RETURNING
      e.id           AS d_id,
      e.name         AS d_name,
      e.type         AS d_type,
      e.observations AS d_observations,
      e.temperature  AS d_temperature,
      e.tier         AS d_tier,
      e.source       AS d_source,
      e.importance   AS d_importance,
      e.access_count AS d_access_count
  )
  SELECT d_id, d_name, d_type, d_observations, d_temperature,
         d_tier, d_source, d_importance, d_access_count
  FROM decayed;

  -- Pass 2 — flag memories COLD for 30+ days as stale. Separate statement so it
  -- sees the tiers pass 1 just wrote.
  --
  -- Every column is alias-qualified for the same reason pass 1 uses d_* aliases:
  -- a bare `tier` here resolves to the RETURNS TABLE output parameter, not the
  -- column, and Postgres rejects it as ambiguous at runtime (not at CREATE time,
  -- so only executing the function surfaces it).
  UPDATE public.entities upd
  SET stale = true
  WHERE upd.tier = 'COLD'
    AND upd.last_accessed_at < NOW() - (INTERVAL '1 day' * 30)
    AND upd.stale = false;
END;
$fn$;

-- Schedule in the CURRENT database, whose name and role differ by environment
-- (a managed instance typically runs as postgres/postgres; local Docker uses
-- whatever POSTGRES_DB/POSTGRES_USER you configured). Not hardcoded, so the one
-- migration stays portable.
--
-- GUARDED ON THE cron SCHEMA EXISTING. pg_cron is installed per-database, and
-- the ephemeral databases this migration also runs against do NOT have it:
-- `make test-integration` builds a fresh test database and applies every
-- drizzle/0*.sql to it, and CI does the same against a bare postgres service.
-- Unguarded, `SELECT cron.unschedule(...)` fails with
-- `ERROR: schema "cron" does not exist` and aborts the WHOLE migration run,
-- taking the integration suite down with it.
--
-- The scheduling is a deployment concern, not a schema concern — a database
-- without pg_cron still gets the function, which is all the tests need.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'memory-thermal-decay') THEN
      PERFORM cron.unschedule('memory-thermal-decay');
    END IF;
    PERFORM cron.schedule(
      'memory-thermal-decay',
      '0 6 * * *',
      $job$SELECT public.memory_thermal_decay();$job$
    );
  ELSE
    RAISE NOTICE 'pg_cron not installed in this database; skipping decay schedule';
  END IF;
END
$sched$;
