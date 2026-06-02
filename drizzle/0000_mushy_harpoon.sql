CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"observations" jsonb DEFAULT '""',
	"tags" text[] DEFAULT '{}',
	"source" text NOT NULL,
	"importance" real DEFAULT 0.5,
	"temperature" real DEFAULT 1,
	"tier" text DEFAULT 'HOT',
	"access_count" integer DEFAULT 0,
	"last_accessed_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "memory_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"weight" real DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_from_id_entities_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_to_id_entities_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_entities_type" ON "entities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_entities_temperature" ON "entities" USING btree ("temperature");--> statement-breakpoint
CREATE INDEX "idx_entities_tags" ON "entities" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "idx_relations_from" ON "memory_relations" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "idx_relations_to" ON "memory_relations" USING btree ("to_id");