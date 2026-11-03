-- 0012_thermal_cutoffs.sql
--
-- Percentile-assigned thermal tiers.
--
-- Absolute tier thresholds were applied to a signal whose scale is not stable.
-- Measured 2026-09-01: 62% of the corpus HOT (avg temp 0.9976). Measured
-- 2026-09-08 on the same corpus: 0.9% HOT, 96.6% COLD (avg 0.0397). Tier failed
-- to discriminate at BOTH poles within eight days.
--
-- This migration is SCHEMA ONLY and changes no behaviour: the seeded row holds
-- 0.7 / 0.3, which are TIER_HOT / TIER_WARM from src/config.ts, so any code
-- reading it reproduces today's tiering exactly. 0013 replaces the decay
-- function that starts writing measured values.
--
-- Idempotent. Apply to local Docker first, then Supabase by hand from the
-- primary. Never `make migrate` against Supabase; never drizzle-kit generate.

-- Single-row table. The CHECK pins it to one row so an accidental second
-- INSERT errors instead of making "which cutoffs are live?" ambiguous.
CREATE TABLE IF NOT EXISTS public.thermal_cutoffs (
  id           smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hot_cutoff   real         NOT NULL,
  warm_cutoff  real         NOT NULL,
  -- Corpus size the cutoffs were derived from. 0 marks the seed row: it was
  -- never measured against a distribution.
  corpus_size  integer      NOT NULL DEFAULT 0,
  computed_at  timestamptz  NOT NULL DEFAULT NOW()
);

-- Seed = TIER_HOT / TIER_WARM. Pinned by tests/test_thermal_decay_migration.py.
INSERT INTO public.thermal_cutoffs (id, hot_cutoff, warm_cutoff, corpus_size)
VALUES (1, 0.7, 0.3, 0)
ON CONFLICT (id) DO NOTHING;

-- cume_dist of this row's temperature over the live distribution, written by
-- memory_thermal_decay(). Nullable: rows written between nightly runs have no
-- rank until the next pass. Additive, exactly like entities.embedding.
ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS temperature_rank real;
