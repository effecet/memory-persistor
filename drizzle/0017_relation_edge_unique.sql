-- 0017_relation_edge_unique.sql
--
-- One row per (from_id, to_id, relation_type). The relate guard from
-- 2026-10-23 stops repeat claims in the handler, but it is
-- check-then-insert, so two concurrent identical relates can still both
-- insert, and machines on older code keep writing duplicates. A duplicate
-- double-counts in centrality. Measured on a production database 2026-10-25: 2,162 edges,
-- 31 duplicated groups of exactly 2 rows, 1 with mixed provenance, 0 with
-- differing weights, 0 self-loops.
--
-- Rollout order does not matter. Every insert in src/ uses ON CONFLICT DO
-- NOTHING with no conflict target, which is valid with or without this index.
-- Code that predates it gets a 23505 when it writes an existing edge, reported
-- as a `validation` error and never losing anything, since the edge exists:
-- relate before 5c1022d on every repeat, relate after it only in the race.
--
-- No CHECK (from_id <> to_id): `relate` rejects self-links, and tests plant
-- one on purpose to prove the centrality and supersedes predicates skip it.
--
-- Idempotent. Apply to local Docker first, then Supabase via the Supabase MCP
-- (DDL must not go through the pooler). Never `make migrate`
-- against Supabase; never drizzle-kit generate.

BEGIN;

-- Fail fast rather than queue every write to the table behind a LOCK that is
-- itself waiting on a long transaction. Re-running is safe.
SET LOCAL lock_timeout = '5s';

-- Blocks concurrent writes between the dedupe and the index build, so no
-- duplicate can land in between and fail the CREATE. Reads continue.
LOCK TABLE public.memory_relations IN SHARE ROW EXCLUSIVE MODE;

-- Keep one row per edge: an asserted row over an inferred one (never downgrade
-- a claim, edge provenance), then the heavier weight, then the oldest row.
DELETE FROM public.memory_relations r
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY from_id, to_id, relation_type
           ORDER BY (provenance = 'asserted') DESC,
                    weight DESC NULLS LAST,
                    created_at ASC NULLS LAST,
                    id
         ) AS rn
  FROM public.memory_relations
) ranked
WHERE r.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS memory_relations_edge_unique
  ON public.memory_relations (from_id, to_id, relation_type);

COMMIT;
