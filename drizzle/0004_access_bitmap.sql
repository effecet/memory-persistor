-- Phase 3: Add access_bitmap column for pattern-aware thermal decay.
-- 7-bit integer where each bit represents a day-of-week (0=Sun, 6=Sat).
-- Used to detect regular access patterns and slow decay for frequently used memories.
ALTER TABLE public.entities ADD COLUMN IF NOT EXISTS access_bitmap integer DEFAULT 0;
