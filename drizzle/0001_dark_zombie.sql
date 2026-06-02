ALTER TABLE "entities" ALTER COLUMN "observations" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "observations" SET DEFAULT '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entities_fts" ON "entities" USING gin(to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(observations, '')));