-- 0016_relation_provenance.sql
--
-- Edge provenance. memory_relations could not tell an edge somebody
-- ASSERTED (an explicit `relate` call, `remember`'s `relatedTo`) from one the
-- server INFERRED (`remember`'s auto-relate, a guess from text similarity) —
-- and graph centrality, a recall prior, paid both the same.
--
-- Vocabulary is deliberately two values. edge provenance also proposed 'merged' for edges
-- `merge` transfers; that would DOWNGRADE an asserted edge to a weaker label
-- and lose exactly the fact this column exists to keep. `merge` preserves the
-- provenance of each edge it moves instead.
--
-- Idempotent. Apply to local Docker first, then Supabase via the Supabase MCP
-- (DDL must not go through the pooler). Never `make migrate`
-- against Supabase; never drizzle-kit generate.

-- Existing rows default to 'inferred': auto-relate created most of them, and
-- the backfill below promotes the ones that history shows were asserted.
ALTER TABLE public.memory_relations
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'inferred';

-- The CHECK is added on its own, NOT as a clause of the ADD COLUMN above:
-- `ADD COLUMN IF NOT EXISTS` skips EVERY clause attached to it when the column
-- already exists, so a CHECK written there would be silently withheld on any
-- database that got the column some other way.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'memory_relations_provenance_check'
      AND conrelid = 'public.memory_relations'::regclass
  ) THEN
    ALTER TABLE public.memory_relations
      ADD CONSTRAINT memory_relations_provenance_check
      CHECK (provenance IN ('asserted', 'inferred'));
  END IF;
END $$;

-- Backfill from the event log. Every `relate` tool call has been logged since
-- 2026-03-22 as event_type 'relate', memory_id = fromId, payload {toId,
-- relationType}. An edge matching one of those on all three fields was
-- asserted. Measured on a production database 2026-09-30: 310 relate events matching 334 of
-- 2,027 edges (duplicates of one pair match one event).
--
-- Known undercount, accepted: `remember`'s `relatedTo` edges were never logged
-- with their target, so pre-0016 ones stay 'inferred'; and 38 edges predate the
-- event log entirely. Erring toward 'inferred' is the honest direction.
--
-- Re-running is safe: it only ever promotes rows that match a logged relate.
UPDATE public.memory_relations r
SET provenance = 'asserted'
WHERE r.provenance = 'inferred'
  AND EXISTS (
    SELECT 1 FROM public.events ev
    WHERE ev.event_type = 'relate'
      AND ev.memory_id = r.from_id
      -- lower(): zod's .uuid() accepts upper-case input, while uuid::text is
      -- always lower-case, so a raw comparison would silently miss those.
      AND lower(ev.payload->>'toId') = r.to_id::text
      AND ev.payload->>'relationType' = r.relation_type
  );
