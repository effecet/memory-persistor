-- 0015_thermal_decay_floor_is_cold.sql
--
-- The decay floor is COLD by construction. Supersedes 0014's body;
-- everything below the signature is 0014 verbatim apart from pass 2.
--
-- WHY: pass 2 ranked the WHOLE corpus with cume_dist(), which gives a tied
-- group its HIGHEST cumulative fraction. That is correct at the cap, where
-- bump()'s LEAST(1.0::real, ...) manufactures a tie on every read, and it is
-- the whole reason percentile tiering chose cume_dist over percent_rank. It is wrong at the
-- FLOOR, where pass 1 writes exactly 0 below epsilon: a tie mass at 0 takes
-- cume_dist = group/N, so once more than ~70% of the corpus is floored that
-- entire DEAD group is tiered WARM and COLD is empty.
--
-- 0014's own comment called that "deliberately accepted" and pointed at a
-- secondary sort key if it ever bit. A secondary key is the wrong instrument:
-- it splits the tie at the CAP too, so a corpus with more than ~30% of rows at
-- exactly 1.0 — which 0014 itself describes as the normal steady state — puts
-- both the HOT and WARM band minima at 1.0, writes hot_cutoff <= warm_cutoff,
-- and degrades bump() to the earlier seeds. It would trade the cold pole for
-- the hot one.
--
-- Excluding the floor from the ranking population instead leaves the cap
-- behaviour byte-identical (the tie there still takes 1.0 and is still HOT)
-- and makes the failure structurally unreachable rather than merely guarded:
--   * a floored row gets temperature_rank 0 and tier COLD, so COLD is always
--     reachable no matter how much of the corpus is dead;
--   * every WARM row is drawn from the positive population, so
--     MIN(temperature) over the WARM band is > 0 by construction and pass 3
--     can no longer write warm_cutoff = 0. That row was the real damage: it
--     is non-degenerate (hot > warm) and non-empty, so pass 3's
--     all-or-nothing guard never fired and resolveCutoffs() read it as
--     `measured` — while bump()'s `temperature >= 0` made COLD unreachable
--     there too and health reported the corpus as healthy. Same failure shape
--     percentile tiering existed to close, at the other end.
--
-- WHY THIS ALSO FIXES NULL: entities.temperature is nullable, and ORDER BY
-- sorts NULLS LAST on ASC, so a NULL-temperature row previously took the
-- HIGHEST rank and was tiered HOT — the hottest memory in the brain being the
-- one with no temperature at all. `NULL > 0` is not true, so it now falls to
-- the floor branch and tiers COLD. Pinned by 'tiers a NULL temperature COLD
-- rather than HOT' in tests/integration/isolated/thermal-percentile-decay.test.ts.
--
-- WHAT THE QUANTILES NOW MEASURE: HOT is the top decile of the LIVING
-- population, not of the whole table. On a corpus with few floored rows that
-- is the same set; on a mostly-dead corpus it is the intended reading — a
-- tenth of what is still warm, rather than a tenth of a graveyard.
--
-- temperature_rank is ALSO the recall temperature prior (TEMPERATURE_EXPR in
-- src/retrieve.ts), so this is not only a tiering fix: before it, a fully
-- decayed row in a large floored mass carried a prior of up to 0.70 into
-- ranking. It now carries 0, which is what a temperature of 0 means.
--
-- CREATE OR REPLACE is enough here, unlike 0014: the RETURNS TABLE signature
-- is unchanged, so this is a body-only replacement. Idempotent; the pg_cron
-- job scheduled in 0010 is unaffected (it stores the call as text and resolves
-- it at run time).

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
  access_count  integer,
  origin_host   text
)
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- Pass 0 — snapshot temperature/tier/importance BEFORE anything moves, so the
  -- final RETURN QUERY can be filtered to rows that ACTUALLY changed.
  --
  -- The snapshot covers exactly the mutable columns syncToFile() writes into
  -- markdown frontmatter (src/file-sync.ts) — NOT just the ones pass 2 touches.
  -- importance is easy to forget and load-bearing: pass 1 drifts it
  -- independently of temperature, so a floored row (temperature pinned at 0,
  -- tier stable) still changes nightly. Omitting it silently drops that row
  -- from decayAll()'s sync set and its frontmatter goes permanently stale,
  -- breaking CLAUDE.md's "every Postgres write must also sync to markdown"
  -- invariant. 0010's RETURNING covered it; the first version of this filter
  -- regressed past it. If a future column joins the frontmatter, add it here
  -- AND to the filter at the bottom — the two lists must stay in step.
  --
  -- This is not bookkeeping: decayAll() in src/thermal.ts runs syncToFile()
  -- over EVERY returned row, so returning the whole corpus rewrites ~900
  -- markdown files on every nightly run. 0010 returned only its `decayed` CTE;
  -- pass 2 here touches all rows, so "rows the function wrote" is no longer a
  -- useful proxy for "rows whose file content changed".
  --
  -- A temp table rather than a CTE because the passes are separate statements
  -- (see the header) — a CTE cannot outlive its own statement. Column names are
  -- prefixed prev_* for the same reason every other alias in this body is
  -- prefixed: a bare `id`/`tier`/`temperature`/`importance` resolves to the
  -- RETURNS TABLE output parameter and errors as ambiguous AT EXECUTION TIME.
  --
  -- IF NOT EXISTS + TRUNCATE rather than CREATE alone: ON COMMIT DROP fires at
  -- commit, so two calls inside one transaction would otherwise collide.
  CREATE TEMP TABLE IF NOT EXISTS thermal_decay_prev (
    prev_id           uuid PRIMARY KEY,
    prev_temperature  real,
    prev_tier         text,
    prev_importance   real
  ) ON COMMIT DROP;
  TRUNCATE TABLE thermal_decay_prev;
  INSERT INTO thermal_decay_prev (prev_id, prev_temperature, prev_tier, prev_importance)
  SELECT snap.id, snap.temperature, snap.tier, snap.importance FROM public.entities snap;

  -- Pass 1 — pattern-aware decay + importance drift, with a hard floor.
  -- Inner aliases are d_*/upd. deliberately: a bare `id` or `tier` in this body
  -- resolves to the RETURNS TABLE output parameter and errors as ambiguous AT
  -- EXECUTION TIME, not at CREATE time.
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
  )
  UPDATE public.entities e
  SET
    -- FLOOR: below epsilon write exactly 0. Multiplicative decay otherwise
    -- asymptotes without arriving, producing float4 denormals (7 rows at
    -- 2026-09-08, min 7.28675e-43). float4 multiply raises 22003 underflow when
    -- a NON-ZERO product flushes to zero, aborting the WHOLE recall query — so
    -- the guard tests e.temperature (the OPERAND) directly, not the product.
    -- Testing `e.temperature * dr.effective_rate < 1e-6` would still perform
    -- that multiply before the CASE ever short-circuits, and a row in roughly
    -- [1.4e-45, 1.65e-45) triggers 22003 right there — the exact failure class
    -- this migration exists to close, so it must never be reachable even
    -- though no live row is in that range today (min measured 7.28675e-43,
    -- which already floors to 0 on the operand check below).
    temperature = CASE
      WHEN e.temperature < 1e-6::real THEN 0.0::real
      ELSE GREATEST(0.0::real, e.temperature * dr.effective_rate)
    END,
    importance = CASE
      WHEN e.access_count >= 5
        THEN LEAST(0.9::real, e.importance + 0.05::real)
      WHEN e.last_accessed_at < NOW() - (INTERVAL '1 day' * 60)
        THEN GREATEST(0.1::real, e.importance - 0.05::real)
      ELSE e.importance
    END
  FROM decay_rates dr
  WHERE e.id = dr.ent_id;

  -- Pass 2 — assign tier and temperature_rank across the WHOLE corpus.
  --
  -- cume_dist, NOT percent_rank. Both are tie-safe in the sense that tied rows
  -- share a value and therefore share a tier, but they resolve a tie in
  -- OPPOSITE directions, and the direction decides whether HOT can be empty:
  --   percent_rank gives a tied group the group's LOWEST rank
  --   cume_dist    gives a tied group the group's HIGHEST cumulative fraction
  -- bump() manufactures a tie at exactly 1.0 on EVERY read (LEAST(1.0::real,
  -- ...) in src/thermal.ts), so a tie mass at the TOP is the normal steady
  -- state, not an edge case. Under percent_rank that whole group takes
  -- (N - group)/(N - 1), which drops below 0.90 as soon as the group exceeds
  -- ~10% of the corpus — and with nothing ranked above it, HOT is EMPTY.
  -- Measured on a 905-row corpus: 0 tied → HOT 91; 100 tied at 1.0 → HOT 0;
  -- 300 tied → HOT 0 and WARM 0. Pass 3's fallbacks then write the seeds and
  -- resolveCutoffs() reports `measured`, so the fleet reverts to earlier
  -- absolute thresholds while health calls it healthy. cume_dist gives that
  -- group 1.0, which is also the semantically right answer: those rows ARE the
  -- hottest. Pinned by tests/integration/isolated/thermal-percentile-decay.test.ts
  -- ('keeps HOT non-empty when a tie mass sits at exactly the cap'), which goes
  -- RED under percent_rank.
  --
  -- The mirrored risk at the OTHER pole was accepted by 0013/0014 and is now
  -- CLOSED by the cold-pole fix: a tie mass at exactly 0 took cume_dist = group/N, so a
  -- corpus more than 70% floored tiered that whole dead group WARM and emptied
  -- COLD. 0014 suggested a secondary sort key; that is the wrong instrument
  -- (see this file's header — it splits the cap tie too and degrades bump() to
  -- the seeds on a normal corpus). The floor is excluded from the ranking
  -- population instead, which leaves everything in this comment about the cap
  -- exactly as it was.
  --
  -- THE RANKING POPULATION IS temperature > 0, NOT THE WHOLE TABLE.
  -- A floored row is dead by definition, so it is COLD by definition: it takes
  -- rank 0 through the COALESCE below rather than a share of the distribution.
  -- Do NOT "simplify" this back to a single window over public.entities — that
  -- is precisely the shape that tiers a >70% floored corpus WARM and writes
  -- warm_cutoff = 0. `NULL > 0` is also not true, so a NULL temperature falls
  -- to the same branch instead of sorting NULLS LAST into HOT.
  --
  -- COUPLED TO PASS 1: this predicate is `> 0` because pass 1 writes EXACTLY
  -- 0.0::real below epsilon, not a small non-zero residue. If that floor is
  -- ever changed to a non-zero value, change this predicate with it — the dead
  -- mass would otherwise be re-admitted to the ranking and the cold-pole fix returns, and the
  -- integration test would not notice because it seeds literal 0.0.
  WITH live AS (
    SELECT r.id AS r_id,
           cume_dist() OVER (ORDER BY r.temperature)::real AS pr
    FROM public.entities r
    WHERE r.temperature > 0::real
  ),
  ranked AS (
    SELECT dead.id AS r_id, COALESCE(live.pr, 0::real) AS pr
    FROM public.entities dead
    LEFT JOIN live ON live.r_id = dead.id
  )
  UPDATE public.entities e
  SET
    temperature_rank = ranked.pr,
    tier = CASE
      WHEN ranked.pr >= 0.90::real THEN 'HOT'
      WHEN ranked.pr >= 0.70::real THEN 'WARM'
      ELSE 'COLD'
    END
  FROM ranked
  WHERE e.id = ranked.r_id;

  -- Pass 3 — derive the value cutoffs bump() uses intra-day FROM pass 2's
  -- assignment, so the two can never disagree.
  --
  -- ALL-OR-NOTHING. If EITHER band is empty the row is written as a pure seed:
  -- 0.7 / 0.3 AND corpus_size = 0, which resolveCutoffs() reads as
  -- `source: 'seed'`. A PER-BAND COALESCE was the earlier shape and it is what
  -- manufactures a degenerate row: an empty HOT band with a populated WARM band
  -- writes hot_cutoff 0.7 alongside a measured warm_cutoff that can sit ABOVE
  -- it, i.e. hot <= warm. Mixing one seeded value with one measured value is
  -- never meaningful — the two describe different distributions — so the row is
  -- either wholly measured or wholly seed.
  --
  -- corpus_size stays COUNT(*) over the WHOLE table even though, since then,
  -- the cutoffs above are derived from the LIVING subset. That is deliberate:
  -- its only consumer is `corpus_size <= 0`, the seed marker, and both readers
  -- treat 0 as authoritative proof the row was never measured. Narrowing it to
  -- the living count would make a fully-floored corpus write corpus_size = 0
  -- alongside genuinely measured cutoffs — re-introducing the mixed row this
  -- pass exists to prevent. Read it as "rows in the table", not "rows the
  -- cutoffs were measured over".
  WITH bands AS (
    SELECT
      MIN(c.temperature) FILTER (WHERE c.tier = 'HOT')  AS min_hot,
      MIN(c.temperature) FILTER (WHERE c.tier = 'WARM') AS min_warm,
      COUNT(*)::int                                     AS n
    FROM public.entities c
  )
  INSERT INTO public.thermal_cutoffs (id, hot_cutoff, warm_cutoff, corpus_size, computed_at)
  SELECT
    1,
    CASE WHEN b.min_hot IS NULL OR b.min_warm IS NULL THEN 0.7::real ELSE b.min_hot END,
    CASE WHEN b.min_hot IS NULL OR b.min_warm IS NULL THEN 0.3::real ELSE b.min_warm END,
    CASE WHEN b.min_hot IS NULL OR b.min_warm IS NULL THEN 0        ELSE b.n        END,
    NOW()
  FROM bands b
  -- ON CONFLICT (id) would repeat the exact trap this file's header describes:
  -- a bare `id` in the target-column-list position is still a column reference
  -- plpgsql's variable-substitution pass rewrites, and it collides with the
  -- RETURNS TABLE `id` output parameter — CREATE OR REPLACE succeeds, and it
  -- errors ONLY at execution time with "column reference \"id\" is ambiguous"
  -- (verified 2026-09-09). Naming the constraint sidesteps the bare identifier
  -- entirely.
  ON CONFLICT ON CONSTRAINT thermal_cutoffs_pkey DO UPDATE SET
    hot_cutoff  = EXCLUDED.hot_cutoff,
    warm_cutoff = EXCLUDED.warm_cutoff,
    corpus_size = EXCLUDED.corpus_size,
    computed_at = EXCLUDED.computed_at;

  -- Pass 4 — stale flag. Separate statement so it sees pass 2's tiers.
  UPDATE public.entities upd
  SET stale = true
  WHERE upd.tier = 'COLD'
    AND upd.last_accessed_at < NOW() - (INTERVAL '1 day' * 30)
    AND upd.stale = false;

  -- Return ONLY rows whose tier, temperature or importance actually moved, for
  -- the file-sync half decayAll() owns. Compared against pass 0's snapshot with
  -- IS DISTINCT FROM so a NULL on either side counts as a change rather than
  -- silently dropping the row.
  --
  -- importance is in the comparison because pass 1 drifts it on its own axis:
  -- a row floored at temperature 0 with a stable tier still gets +/-0.05 when
  -- access_count >= 5 or after 60 days of neglect, and importance IS written to
  -- markdown frontmatter. Dropping it left that file permanently stale.
  --
  -- temperature_rank is deliberately NOT part of the comparison: it is not
  -- written to markdown frontmatter, so a rank-only move is not a reason to
  -- rewrite a file. Neither is `stale` (pass 4), for the same reason.
  --
  -- LEFT JOIN, not JOIN: a row inserted by another transaction after pass 0's
  -- snapshot has no `prev` and is treated as changed. That is the safe
  -- direction — an unnecessary file sync, never a skipped one.
  RETURN QUERY
  SELECT ret.id, ret.name, ret.type, ret.observations, ret.temperature,
         ret.tier, ret.source, ret.importance, ret.access_count,
         ret.origin_host
  FROM public.entities ret
  LEFT JOIN thermal_decay_prev prev ON prev.prev_id = ret.id
  WHERE ret.temperature IS DISTINCT FROM prev.prev_temperature
     OR ret.tier        IS DISTINCT FROM prev.prev_tier
     OR ret.importance  IS DISTINCT FROM prev.prev_importance;
END;
$fn$;
