.PHONY: help install up down rebuild migrate seed dev dev-remote test test-integration status status-remote decay decay-remote backfill-embeddings backfill-embeddings-remote canary canary-remote cron-status graph clean

DOCKER_COMPOSE = docker compose
MCP_SERVER = npx tsx src/mcp-server.ts
PG_USER = postgres
PG_DB = memory_persistor

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install Node dependencies
	npm install

up: ## Start Postgres container (builds if needed)
	$(DOCKER_COMPOSE) up -d --build
	@echo "Waiting for Postgres to be ready..."
	@$(DOCKER_COMPOSE) exec postgres pg_isready -U $(PG_USER) -d $(PG_DB) --timeout=30

down: ## Stop Postgres container
	$(DOCKER_COMPOSE) down

rebuild: ## Force rebuild Postgres image (after Dockerfile changes)
	$(DOCKER_COMPOSE) up -d --build --force-recreate
	@echo "Waiting for Postgres to be ready..."
	@$(DOCKER_COMPOSE) exec postgres pg_isready -U $(PG_USER) -d $(PG_DB) --timeout=30

# Applies the hand-written SQL in drizzle/ IN ORDER, via psql.
#
# This deliberately does NOT run `drizzle-kit generate`. `drizzle/meta/` is
# gitignored, so the generator has no snapshot history and emits a from-scratch
# schema — correct against an empty database, destructive against a populated
# one. Every file in drizzle/ is hand-written and individually idempotent
# (IF NOT EXISTS / CREATE OR REPLACE / DROP+CREATE), so replaying them all is
# safe and is what makes this target re-runnable.
migrate: ## Apply the hand-written SQL migrations in order (local Docker)
	@set -e; for f in drizzle/0*.sql; do \
		echo "→ $$f"; \
		$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DB) \
			-v ON_ERROR_STOP=1 -q -f - < "$$f"; \
	done
	@echo "migrations applied"

seed: ## Seed memories from $CLAUDE_DIR/projects/*/memory/ (optional file-sync)
	npx tsx src/import.ts

dev: ## Start MCP server in dev mode (local Docker)
	$(MCP_SERVER)

dev-remote: ## Start MCP server against Supabase
	@test -f .env.supabase || (echo "Missing .env.supabase" && exit 1)
	. ./.env.supabase && DATABASE_URL="$$DATABASE_URL" $(MCP_SERVER)

test: ## Run unit tests (vitest + pytest for scripts)
	npx vitest run --exclude 'tests/integration/**'
	@if command -v pytest >/dev/null 2>&1; then pytest tests/ -q || test $$? -eq 5; fi

test-integration: ## Run integration tests against real Postgres (sequential)
	npx vitest run tests/integration/ --fileParallelism=false

status: ## Show Docker + DB tier counts (local)
	$(DOCKER_COMPOSE) ps
	@echo ""
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DB) -c \
		"SELECT tier, COUNT(*) FROM public.entities GROUP BY tier ORDER BY tier;" 2>/dev/null \
		|| echo "Database not reachable"

status-remote: ## Show Supabase DB tier counts
	@test -f .env.supabase || (echo "Missing .env.supabase" && exit 1)
	@set -a && . ./.env.supabase && set +a && node --input-type=module -e " \
		import pg from 'pg'; \
		const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); \
		await c.connect(); \
		const r = await c.query('SELECT tier, COUNT(*) as cnt FROM entities GROUP BY tier ORDER BY tier'); \
		console.table(r.rows); \
		await c.end();"

decay: ## Run thermal decay + snapshot manually (local Docker)
	DOTENV_CONFIG_PATH=.env python3 scripts/memory-decay.py

decay-remote: ## Run thermal decay against a managed instance
	@test -f .env.supabase || (echo "Missing .env.supabase" && exit 1)
	DOTENV_CONFIG_PATH=.env.supabase npx tsx scripts/decay-remote.ts

backfill-embeddings: ## Backfill NULL embeddings (local Docker). Add ARGS=--dry-run for a count only
	npx tsx scripts/backfill-embeddings.ts $(ARGS)

backfill-embeddings-remote: ## Backfill NULL embeddings against a managed instance. Add ARGS=--dry-run for a count only
	@test -f .env.supabase || (echo "Missing .env.supabase" && exit 1)
	. ./.env.supabase && DATABASE_URL="$$DATABASE_URL" npx tsx scripts/backfill-embeddings.ts $(ARGS)

canary: ## Check events pipeline freshness (local Docker); exits 1 if stale
	python3 scripts/events_canary.py

canary-remote: ## Check events freshness against Supabase; exits 1 if stale
	@test -f .env.supabase || (echo "Missing .env.supabase" && exit 1)
	. ./.env.supabase && DATABASE_URL="$$DATABASE_URL" python3 scripts/events_canary.py

cron-status: ## Show pg_cron job schedule and recent runs
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DB) -c \
		"SELECT jobid, jobname, schedule, command FROM cron.job;" 2>/dev/null \
		|| echo "pg_cron not available"
	@echo ""
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DB) -c \
		"SELECT jobid, job_pid, status, return_message, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;" 2>/dev/null \
		|| echo "No run history"

cron-status-remote: ## Show pg_cron job schedule and recent runs (managed instance)
	@DOTENV_CONFIG_PATH=.env.supabase node --import "file://$(PWD)/node_modules/tsx/dist/loader.mjs" --input-type=module -e "\
import { db } from '$(PWD)/src/db.ts'; import { sql } from 'drizzle-orm';\
const j = await db.execute(sql\`SELECT jobid, jobname, schedule, active FROM cron.job\`);\
console.table(j.rows);\
const r = await db.execute(sql\`SELECT jobid, status, return_message, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5\`);\
console.table(r.rows); process.exit(0);"

cron-verify: ## Assert the live decay job matches the committed migration
	@DOTENV_CONFIG_PATH=.env.supabase node --import "file://$(PWD)/node_modules/tsx/dist/loader.mjs" --input-type=module -e "\
import { db } from '$(PWD)/src/db.ts'; import { sql } from 'drizzle-orm';\
const r = await db.execute(sql\`SELECT command FROM cron.job WHERE jobname = 'memory-thermal-decay'\`);\
if (r.rows.length !== 1) { console.error('FAIL: expected exactly 1 job, got ' + r.rows.length); process.exit(1); }\
const live = String(r.rows[0].command).replace(/\\s+/g, ' ').trim();\
const want = 'SELECT public.memory_thermal_decay();';\
if (live !== want) { console.error('FAIL: live cron command drifted from the committed migration'); console.error('  live: ' + live); console.error('  want: ' + want); process.exit(1); }\
console.log('OK: live cron job matches the committed migration'); process.exit(0);"

graph: ## Generate Mermaid graph of memory network
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DB) -t -c \
		"SELECT 'graph LR' UNION ALL SELECT '  ' || e1.name || ' -->|' || r.relation_type || '| ' || e2.name FROM public.memory_relations r JOIN public.entities e1 ON r.from_id = e1.id JOIN public.entities e2 ON r.to_id = e2.id;"

clean: ## Remove generated files and volumes
	$(DOCKER_COMPOSE) down -v
	rm -rf dist/ node_modules/
