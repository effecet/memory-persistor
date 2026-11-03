-- Pending rows need a SCOPE, not just an origin.
--
-- `origin_host` records which machine WROTE an item. It cannot answer the
-- reader's actual question — "is this mine?" — because plenty of items written
-- on one machine are fleet-wide. A finding that was true on one host only was
-- read as fleet-wide on another, where it is false.
--
-- `applies_to` is that missing axis. EMPTY MEANS FLEET-WIDE.
--
-- NOT NULL DEFAULT '{}' rather than a nullable column: NULL and '{}' would be
-- two spellings of the same state, and every predicate downstream would have to
-- handle both forever. The default also backfills every existing row to
-- fleet-wide, which is the correct reading of anything written before scope
-- existed.
--
-- Applied MANUALLY via psql (local Docker first, then Supabase), matching the
-- hand-written 0003-0010 pattern. Idempotent — safe to re-run.
-- ⚠️ `ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT` is NOT sufficient on its
-- own, and the failure is silent. If the column already exists in ANY shape,
-- the whole clause is skipped with a NOTICE — not an error — so `NOT NULL` and
-- the default are quietly dropped and `ON_ERROR_STOP=1` does not fire. Proven
-- on local Docker:
--
--   ALTER TABLE t ADD COLUMN applies_to text[];                 -- nullable
--   ALTER TABLE t ADD COLUMN IF NOT EXISTS applies_to text[]
--       NOT NULL DEFAULT '{}';
--   NOTICE:  column "applies_to" of relation "t" already exists, skipping
--   -> is_nullable: YES, column_default: (none)
--
-- That would defeat this migration's own premise: a NULL row has
-- `cardinality(NULL) = 0` evaluating to NULL, so it matches NEITHER branch of
-- the scope filter and the item is invisible on EVERY machine — precisely the
-- failure host scoping exists to fix.
--
-- This is the same trap 0009 documents for inline CHECK constraints under
-- `CREATE TABLE IF NOT EXISTS`. The four statements below converge on the
-- intended end state from any starting point, and each is individually
-- idempotent, so they are preferred over a catalog probe here.
ALTER TABLE public.pending
    ADD COLUMN IF NOT EXISTS applies_to text[];

UPDATE public.pending SET applies_to = '{}' WHERE applies_to IS NULL;

ALTER TABLE public.pending
    ALTER COLUMN applies_to SET DEFAULT '{}';

ALTER TABLE public.pending
    ALTER COLUMN applies_to SET NOT NULL;

-- The default list filter is
--   cardinality(applies_to) = 0 OR <host> = ANY(applies_to)
-- The `= ANY` half is a containment test over a small array column, which is
-- what GIN indexes. The cardinality half is not indexable and does not need to
-- be: it matches the overwhelming majority of rows (all 187 at migration time),
-- so the planner is right to seq-scan for it on a table this size. The index
-- earns its keep only once host-scoped items are common.
CREATE INDEX IF NOT EXISTS idx_pending_applies_to
    ON public.pending USING GIN (applies_to);

-- No CHECK constraint on the contents. Unlike category/priority/status, the
-- host vocabulary is OPEN — a new machine must be scopable before it has ever
-- written a row, so there is no closed set to validate against. A typo'd host
-- is therefore accepted by the database, which is exactly why `listPending`
-- reports `hiddenByHost`: a misscoped item is invisible on every machine, and
-- without that count it would be indistinguishable from a resolved one.
