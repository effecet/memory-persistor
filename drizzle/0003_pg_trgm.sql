-- Phase 1: Enable pg_trgm extension and add trigram index for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on name || observations for similarity() queries
CREATE INDEX IF NOT EXISTS idx_entities_trgm
  ON public.entities
  USING gin ((COALESCE(name, '') || ' ' || COALESCE(observations, '')) gin_trgm_ops);
