-- Enable pg_cron extension (requires shared_preload_libraries = 'pg_cron')
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage to the app user
GRANT USAGE ON SCHEMA cron TO postgres;

-- ─── Job 1: Nightly thermal decay ──────────────────────────────────────────
-- Schedule: 06:00 UTC ≈ 03:00 ADT (Atlantic Daylight Time, UTC-3)
-- Note: this pg_cron build has no timezone column — UTC offset is hardcoded.
--       Drifts 1h in winter (AST = UTC-4). Upgrade image for DST-aware scheduling.
-- v3: pattern-aware decay + access bitmap shift + auto-importance drift
SELECT cron.schedule(
    'memory-thermal-decay',
    '0 6 * * *',
    $$
    -- Pattern-aware decay: regular access patterns (3+ days/week) slow decay.
    -- bit_count on access_bitmap determines pattern strength.
    WITH decay_rates AS (
        SELECT
            e.id,
            CASE
                WHEN bit_count(COALESCE(e.access_bitmap, 0)::bit(7))::real >= 3
                THEN LEAST(1.0::real, 0.85::real + (1.0::real - 0.85::real) * (
                    0.1::real
                    + (bit_count(COALESCE(e.access_bitmap, 0)::bit(7))::real - 3.0::real) * 0.02::real
                ))
                ELSE 0.85::real
            END AS effective_rate
        FROM public.entities e
        WHERE e.last_accessed_at < NOW() - INTERVAL '24 hours'
    )
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
            WHEN e.last_accessed_at < NOW() - INTERVAL '60 days'
                THEN GREATEST(0.1::real, e.importance - 0.05::real)
            ELSE e.importance
        END
    FROM decay_rates dr
    WHERE e.id = dr.id;

    -- Flag stale memories (COLD for 30+ days)
    UPDATE public.entities
    SET stale = true
    WHERE tier = 'COLD'
      AND last_accessed_at < NOW() - INTERVAL '30 days'
      AND stale = false;
    $$
);

-- ─── Job 2: Startup catch-up failsafe ──────────────────────────────────────
-- Fires on every postgres/container start via @reboot.
-- Checks if memory-thermal-decay ran in the last 24h.
-- If not (container was down, machine was sleeping), runs decay inline
-- and writes a record to cron.job_run_details so history stays consistent.
--
-- Note: cron.run_job() is not available in this pg_cron build.
--       Inline SQL is used instead; it mirrors job 1's logic exactly.
--       Keep this function in sync with the memory-thermal-decay command above.

CREATE OR REPLACE FUNCTION public.decay_catchup()
RETURNS void
LANGUAGE plpgsql
AS $func$
DECLARE
    v_job_id   bigint;
    v_hours    numeric;
    v_start    timestamptz;
    v_affected bigint;
BEGIN
    SELECT jobid INTO v_job_id
    FROM cron.job
    WHERE jobname = 'memory-thermal-decay'
    LIMIT 1;

    IF v_job_id IS NULL THEN
        RAISE NOTICE 'decay_catchup: scheduled job not found, skipping';
        RETURN;
    END IF;

    -- Hours since last successful run (filter by jobid — no jobname in job_run_details)
    SELECT round(EXTRACT(EPOCH FROM (NOW() - MAX(end_time))) / 3600.0, 1)
    INTO v_hours
    FROM cron.job_run_details
    WHERE jobid = v_job_id
      AND status = 'succeeded';

    IF v_hours IS NOT NULL AND v_hours <= 24 THEN
        RAISE NOTICE 'decay_catchup: last run %h ago — within 24h, skipping', v_hours;
        RETURN;
    END IF;

    IF v_hours IS NULL THEN
        RAISE NOTICE 'decay_catchup: no prior run — running inline decay now';
    ELSE
        RAISE NOTICE 'decay_catchup: last run %h ago (>24h) — running inline decay now', v_hours;
    END IF;

    v_start := clock_timestamp();

    -- Mirror memory-thermal-decay SQL (pattern-aware version)
    WITH decay_rates AS (
        SELECT
            e.id,
            CASE
                WHEN bit_count(COALESCE(e.access_bitmap, 0)::bit(7))::real >= 3
                THEN LEAST(1.0::real, 0.85::real + (1.0::real - 0.85::real) * (
                    0.1::real
                    + (bit_count(COALESCE(e.access_bitmap, 0)::bit(7))::real - 3.0::real) * 0.02::real
                ))
                ELSE 0.85::real
            END AS effective_rate
        FROM public.entities e
        WHERE e.last_accessed_at < NOW() - INTERVAL '24 hours'
    )
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
            WHEN e.last_accessed_at < NOW() - INTERVAL '60 days'
                THEN GREATEST(0.1::real, e.importance - 0.05::real)
            ELSE e.importance
        END
    FROM decay_rates dr
    WHERE e.id = dr.id;

    GET DIAGNOSTICS v_affected = ROW_COUNT;

    UPDATE public.entities
    SET stale = true
    WHERE tier = 'COLD'
      AND last_accessed_at < NOW() - INTERVAL '30 days'
      AND stale = false;

    -- Write to job_run_details so next check sees this as a real run
    INSERT INTO cron.job_run_details
        (jobid, database, username, command, status, return_message, start_time, end_time)
    SELECT
        v_job_id,
        current_database(),
        current_user,
        command,
        'succeeded',
        format('catchup inline: %s entities decayed', v_affected),
        v_start,
        clock_timestamp()
    FROM cron.job
    WHERE jobid = v_job_id;

    RAISE NOTICE 'decay_catchup: done — % entities decayed', v_affected;
END;
$func$;

SELECT cron.schedule(
    'memory-decay-startup-catchup',
    '@reboot',
    'SELECT public.decay_catchup()'
);
