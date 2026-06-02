-- Phase 4: Memory Intelligence — version history table
-- Stores snapshots of memory state before each update.
CREATE TABLE IF NOT EXISTS public.memory_versions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    memory_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
    name text NOT NULL,
    observations text DEFAULT '',
    tags text[] DEFAULT '{}',
    importance real DEFAULT 0.5,
    changed_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_versions_memory_id ON public.memory_versions(memory_id);
CREATE INDEX IF NOT EXISTS idx_versions_changed_at ON public.memory_versions(changed_at);
