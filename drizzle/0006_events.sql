-- Phase 5: Observability — events table for audit logging and analytics.
CREATE TABLE IF NOT EXISTS public.events (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_type text NOT NULL,
    memory_id uuid,  -- nullable: some events aren't tied to a specific memory
    payload jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_type ON public.events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_memory_id ON public.events(memory_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON public.events(created_at);
