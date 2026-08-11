-- Pending work queue.
--
-- Deliberately NOT part of the memory corpus. Pending items are a queue with a
-- lifecycle (open → done/archived), not thermally-decayed knowledge: no
-- temperature, no embedding, no tier, no graph edges, no markdown mirror.
-- Kept in the same database only so the session-start hook needs one
-- connection.
--
-- Applied MANUALLY via psql, matching the hand-written 0003-0008 pattern.
-- Idempotent — safe to re-run.
CREATE TABLE IF NOT EXISTS public.pending (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    title       text NOT NULL,
    body        text DEFAULT '',
    category    text NOT NULL,                  -- skill | rule | automation | knowledge
    priority    text NOT NULL DEFAULT 'medium', -- low | medium | high
    status      text NOT NULL DEFAULT 'open',   -- open | done | archived
    source      text,                           -- cwd where the item was raised
    origin_host text,
    created_at  timestamptz DEFAULT NOW(),
    resolved_at timestamptz,
    resolution  text
    -- CHECK constraints on category/priority/status are added by the DO block
    -- below, not inline here. See the comment there for why.
);

CREATE INDEX IF NOT EXISTS idx_pending_status_priority ON public.pending(status, priority);

-- ── Vocabulary CHECK constraints ───────────────────────────────────────────
--
-- The MCP tools validate these with zod, but the session-start hook reads this
-- table directly and the migration is applied by hand — so the vocabularies are
-- enforced here too. Without them an out-of-vocabulary priority silently sorts
-- into the ELSE bucket instead of erroring.
--
-- Added here rather than inline in CREATE TABLE above, so each vocabulary is
-- written exactly once AND so existing installs actually receive them. Inline
-- constraints only fire on a FRESH install: `CREATE TABLE IF NOT EXISTS` is a
-- no-op wherever `pending` already exists, so anyone who applied an earlier
-- revision of this file would never get the CHECKs. Writing them in both places
-- instead would leave two copies of each vocabulary to drift apart.
--
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, hence the catalog probe.
-- `conname` is unique per-table, not per-schema, so the probe is scoped by
-- `conrelid` — an unscoped name match would skip the ALTER whenever any other
-- table happened to carry a constraint of the same name.
--
-- Adding a CHECK validates existing rows, so this fails loudly if any row is
-- already out of vocabulary — which is the point.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.pending'::regclass
                     AND conname = 'pending_category_check') THEN
        ALTER TABLE public.pending ADD CONSTRAINT pending_category_check
            CHECK (category IN ('skill', 'rule', 'automation', 'knowledge'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.pending'::regclass
                     AND conname = 'pending_priority_check') THEN
        ALTER TABLE public.pending ADD CONSTRAINT pending_priority_check
            CHECK (priority IN ('low', 'medium', 'high'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.pending'::regclass
                     AND conname = 'pending_status_check') THEN
        ALTER TABLE public.pending ADD CONSTRAINT pending_status_check
            CHECK (status IN ('open', 'done', 'archived'));
    END IF;
END $$;

-- ── Row-level security: enabled, deliberately NO policy ────────────────────
--
-- RLS is enabled explicitly below rather than relying on the provider to do
-- it. Supabase auto-enables RLS on tables created through its dashboard, but a
-- table created by running this file through `psql` — which is how it is meant
-- to be applied — does NOT get that treatment, and neither does local Docker.
-- Since `anon` may hold blanket SELECT/INSERT grants on `public`, leaving this
-- to chance would expose a private work queue on a clean install. Enabling it
-- here is a no-op where it is already on.
ALTER TABLE public.pending ENABLE ROW LEVEL SECURITY;

-- With RLS on, `pending` is left with ZERO policies. Unlike the four memory
-- tables, that divergence is intentional — do not "fix" it by adding one.
--
--   entities / memory_relations / memory_versions / events
--       -> each has an `anon_read_*` policy: GRANT SELECT TO anon USING (true)
--   pending
--       -> no policy, so `anon` is default-denied entirely
--
-- Rationale: `pending` is a private work queue. Nothing needs anonymous read
-- access to it, and default-deny is the safer posture for a table that will
-- hold unfiltered notes about in-flight work. The MCP server and the
-- session-start hook are unaffected: both connect as `postgres`, which OWNS
-- this table, and an owner bypasses RLS while `relforcerowsecurity` is false.
-- (Note that on a managed provider `postgres` is typically NOT a superuser —
-- ownership, not superuser status, is what makes this work.)
--
-- If a future reader needs `anon` reads here, that is a security decision to
-- take deliberately, not a consistency cleanup.
