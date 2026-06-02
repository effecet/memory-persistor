.PHONY: help install up down rebuild migrate seed dev dev-remote test test-integration status status-remote decay decay-remote canary canary-remote cron-status graph clean

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

migrate: ## Run Drizzle migrations (generate + migrate)
	npx drizzle-kit generate
	npx drizzle-kit migrate

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

decay-remote: ## Run thermal decay against Supabase
	@test -f .env.supabase || (echo "Missing .env.supabase" && exit 1)
	. ./.env.supabase && DATABASE_URL="$$DATABASE_URL" npx tsx -e "import { decayAll } from './src/thermal.js'; const r = await decayAll(); console.log('Decayed', r.count, 'entities, synced', r.synced); process.exit(0);"

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

graph: ## Generate Mermaid graph of memory network
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DB) -t -c \
		"SELECT 'graph LR' UNION ALL SELECT '  ' || e1.name || ' -->|' || r.relation_type || '| ' || e2.name FROM public.memory_relations r JOIN public.entities e1 ON r.from_id = e1.id JOIN public.entities e2 ON r.to_id = e2.id;"

clean: ## Remove generated files and volumes
	$(DOCKER_COMPOSE) down -v
	rm -rf dist/ node_modules/
