-- Semantic embeddings (pgvector).
--
-- Additive nullable column beside entities.observations. Stores fp32 384-d
-- bge-small-en-v1.5 vectors (L2-normalized), used as a 9th retrieval signal
-- and for cosine near-dupe detection.
--
-- No ANN index at small corpus sizes (a few thousand rows) — exact brute-force
-- cosine (`<=>`) is sub-millisecond. Revisit HNSW past ~10k rows.
--
-- Applied MANUALLY via psql (local Docker first, then your managed instance),
-- matching the hand-written 0003-0007 pattern (drizzle's generate/migrate flow
-- is not used past 0002 in this repo). Idempotent — safe to re-run.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "embedding" vector(384);
