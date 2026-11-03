.PHONY: help install up down rebuild migrate seed dev dev-remote test test-integration test-thermal status status-remote decay decay-remote backfill-embeddings backfill-embeddings-remote canary canary-remote cron-status cron-status-remote cron-verify pending-verify graph clean reset-guard-db ranking-guard ranking-baseline ranking-snapshot

DOCKER_COMPOSE = docker compose
MCP_SERVER = npx tsx src/mcp-server.ts
PG_USER = postgres
PG_DEV_DB = memory_persistor
PG_TEST_DB = memory_persistor_test
PG_GUARD_DB = memory_persistor_guard
PG_ISOLATED_DB = memory_persistor_isolated_test

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install Node dependencies
	npm install

up: ## Start Postgres container (builds if needed)
	$(DOCKER_COMPOSE) up -d --build
	@echo "Waiting for Postgres to be ready..."
	@$(DOCKER_COMPOSE) exec postgres pg_isready -U $(PG_USER) -d $(PG_DEV_DB) --timeout=30

down: ## Stop Postgres container
	$(DOCKER_COMPOSE) down

rebuild: ## Force rebuild Postgres image (after Dockerfile changes)
	$(DOCKER_COMPOSE) up -d --build --force-recreate
	@echo "Waiting for Postgres to be ready..."
	@$(DOCKER_COMPOSE) exec postgres pg_isready -U $(PG_USER) -d $(PG_DEV_DB) --timeout=30

# Applies the hand-written SQL in drizzle/ IN ORDER, via psql. NEVER drizzle-kit:
# drizzle/meta/ is gitignored, so `generate` has no snapshot history and emits a
# from-scratch schema that silently skips every extension, index, constraint,
# pg_cron schedule and SQL function the later files add.
#
# This runs through `docker compose exec`, so it reaches ONLY the local
# container. Migrate a managed database by hand, one file at a time:
#   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/<NNNN>_*.sql
#
# FRESH DATABASE ONLY. 0008+ are idempotent, but 0000-0007 are drizzle-generated
# CREATE/ALTER statements, so on a database that already has the schema this
# aborts at 0000 ('set -e' is load-bearing) and applies nothing. To add ONE new
# migration to an existing database, apply just that file by hand.
migrate: ## Apply the hand-written SQL migrations in order (local Docker, FRESH db only)
	@set -e; for f in drizzle/*.sql; do \
		echo "→ $$f"; \
		$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) \
			-q -v ON_ERROR_STOP=1 -f - < "$$f"; \
	done
	@echo "migrations applied to $(PG_DEV_DB)"

seed: ## Seed memories from $CLAUDE_DIR/projects/*/memory/ (optional file-sync)
	npx tsx src/import.ts

dev: ## Start MCP server in dev mode (local Docker)
	$(MCP_SERVER)

dev-remote: ## Start MCP server against Supabase
	@test -f .env.supabase || (echo "Missing .env.supabase" && exit 1)
	DOTENV_CONFIG_PATH=.env.supabase $(MCP_SERVER)

test: ## Run unit tests (vitest + pytest for scripts)
	npx vitest run --exclude 'tests/integration/**'
	@if command -v pytest >/dev/null 2>&1; then pytest tests/ --ignore=tests/integration -q || test $$? -eq 5; fi

# Reset one throwaway database: drop, recreate, apply every drizzle/*.sql in
# filename order. $(1) is the database name.
#
# 'set -e' is load-bearing: without it a migration failing mid-chain is
# swallowed and the rest still apply, leaving a half-built schema the suite
# then tests against.
define reset_db
	@echo "Resetting $(1) (throwaway; isolated from $(PG_DEV_DB) and from every other test DB)..."
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -c \
		"DROP DATABASE IF EXISTS $(1) WITH (FORCE);" >/dev/null
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -c \
		"CREATE DATABASE $(1) OWNER $(PG_USER);" >/dev/null
	@echo "Applying every drizzle/*.sql in order to $(1)..."
	@set -e; for f in drizzle/*.sql; do \
		$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(1) -q -v ON_ERROR_STOP=1 < "$$f" >/dev/null; \
	done
endef

test-integration: up ## Run integration tests — main set, then the isolated thermal set, each on its own fresh DB
	$(call reset_db,$(PG_TEST_DB))
	@# Build a throwaway dotenv pointing at the test DB — both helpers.ts and
	@# src/db.ts (dotenv.config({path:DOTENV_CONFIG_PATH})) honor
	@# DOTENV_CONFIG_PATH, so recall() and the seeders hit the SAME clean DB.
	@# mktemp keeps the derived connection string off the repo tree.
	@ENVFILE=$$(mktemp); \
		grep -E '^DATABASE_URL' .env | sed 's#/$(PG_DEV_DB)#/$(PG_TEST_DB)#' > $$ENVFILE; \
		printf 'NODE_ENV=test\n' >> $$ENVFILE; \
		DOTENV_CONFIG_PATH=$$ENVFILE npm run test:integration; \
		STATUS=$$?; rm -f $$ENVFILE; exit $$STATUS
	@# Phase 2. A recursive make, not an inlined copy, so `make test-thermal`
	@# stands alone AND tests/test_thermal_test_isolation.py can assert this
	@# very line. The `up` prerequisite runs twice; docker compose up -d is
	@# idempotent, so the second one is a no-op.
	@$(MAKE) test-thermal

test-thermal: up ## Thermal + cutoffs suite on a corpus it owns — decay is table-wide
	@# These tests call the corpus-wide memory_thermal_decay() or write the
	@# single-row thermal_cutoffs table, so in a shared DB they would rewrite
	@# the fixtures of every other suite. tests/test_thermal_test_isolation.py
	@# keeps them here. (No apostrophes in this comment on purpose: an
	@# apostrophe in a shell comment desynchronises the quote parser in
	@# tests/test_dsn_argv_interpolation.py.)
	$(call reset_db,$(PG_ISOLATED_DB))
	@ENVFILE=$$(mktemp); \
		grep -E '^DATABASE_URL' .env | sed 's#/$(PG_DEV_DB)#/$(PG_ISOLATED_DB)#' > $$ENVFILE; \
		printf 'NODE_ENV=test\n' >> $$ENVFILE; \
		DOTENV_CONFIG_PATH=$$ENVFILE npm run test:integration:isolated; \
		STATUS=$$?; rm -f $$ENVFILE; exit $$STATUS

reset-guard-db: up
	$(call reset_db,$(PG_GUARD_DB))

ranking-guard: reset-guard-db ## Ranking-regression guard against a fresh DB (skips without a golden corpus)
	@ENVFILE=$$(mktemp); \
		grep -E '^DATABASE_URL' .env | sed 's#/$(PG_DEV_DB)#/$(PG_GUARD_DB)#' > $$ENVFILE; \
		DOTENV_CONFIG_PATH=$$ENVFILE node --import tsx scripts/ranking-guard.ts; \
		STATUS=$$?; rm -f $$ENVFILE; exit $$STATUS

ranking-baseline: reset-guard-db ## Re-record the ranking baseline — REVIEW THE DIFF before committing
	@ENVFILE=$$(mktemp); \
		grep -E '^DATABASE_URL' .env | sed 's#/$(PG_DEV_DB)#/$(PG_GUARD_DB)#' > $$ENVFILE; \
		DOTENV_CONFIG_PATH=$$ENVFILE node --import tsx scripts/ranking-guard.ts --update-baseline; \
		STATUS=$$?; rm -f $$ENVFILE; exit $$STATUS

ranking-snapshot: ## Snapshot YOUR corpus into tests/fixtures (read-only on the source; DOTENV_CONFIG_PATH picks it, default .env)
	DOTENV_CONFIG_PATH=$${DOTENV_CONFIG_PATH:-.env} node --import tsx scripts/snapshot-golden-corpus.ts
	@echo "Now record a baseline: make ranking-baseline"

status: ## Show Docker + DB tier counts (local)
	$(DOCKER_COMPOSE) ps
	@echo ""
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -c \
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
	DOTENV_CONFIG_PATH=.env.supabase npx tsx scripts/backfill-embeddings.ts $(ARGS)

canary: ## Check events pipeline freshness (local Docker); exits 1 if stale
	python3 scripts/events_canary.py

canary-remote: ## Check events freshness against Supabase; exits 1 if stale
	@test -f .env.supabase || (echo "Missing .env.supabase" && exit 1)
	. ./.env.supabase && DATABASE_URL="$$DATABASE_URL" python3 scripts/events_canary.py

cron-status: ## Show pg_cron job schedule and recent runs
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -c \
		"SELECT jobid, jobname, schedule, command FROM cron.job;" 2>/dev/null \
		|| echo "pg_cron not available"
	@echo ""
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -c \
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

pending-verify: ## Assert pending.applies_to has the right SHAPE on the local dev DB
	@# Checks SHAPE, not mere presence: `ADD COLUMN IF NOT EXISTS ... NOT NULL
	@# DEFAULT` on a column that already exists skips the whole clause with a
	@# NOTICE (not an error, so ON_ERROR_STOP does not fire), leaving the column
	@# nullable and defaultless. `table_schema = 'public'` is load-bearing:
	@# without it a `pending` table in another schema could satisfy the match.
	@set -e; \
	OUT=$$($(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -tA -c \
		"SELECT coalesce(( \
		   SELECT is_nullable || ' ' || coalesce(column_default, 'NODEFAULT') \
		   FROM information_schema.columns \
		   WHERE table_schema = 'public' AND table_name = 'pending' \
		     AND column_name = 'applies_to'), 'ABSENT');") \
	  || { echo "ERROR  cannot reach the dev database — is the container up? (make up)"; exit 2; }; \
	case "$$OUT" in \
	  "NO '{}'::text[]") echo "OK     applies_to: NOT NULL, DEFAULT '{}'" ;; \
	  ABSENT) echo "DRIFT  applies_to is ABSENT — apply drizzle/0011"; exit 1 ;; \
	  *) echo "DRIFT  applies_to shape is [$$OUT], expected [NO '{}'::text[]] — re-apply drizzle/0011"; exit 1 ;; \
	esac
	@set -e; \
	IDX=$$($(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -tA -c \
		"SELECT count(*) FROM pg_indexes \
		 WHERE schemaname = 'public' AND tablename = 'pending' \
		   AND indexname = 'idx_pending_applies_to';"); \
	[ "$$IDX" = "1" ] && echo "OK     idx_pending_applies_to present" \
	  || { echo "DRIFT  idx_pending_applies_to missing — re-apply drizzle/0011"; exit 1; }
	@set -e; \
	NULLS=$$($(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -tA -c \
		"SELECT count(*) FROM public.pending WHERE applies_to IS NULL;"); \
	[ "$$NULLS" = "0" ] && echo "OK     rows with NULL applies_to: 0" \
	  || { echo "DRIFT  $$NULLS rows have NULL applies_to — they are invisible on every machine"; exit 1; }

graph: ## Generate Mermaid graph of memory network
	@$(DOCKER_COMPOSE) exec -T postgres psql -U $(PG_USER) -d $(PG_DEV_DB) -t -c \
		"SELECT 'graph LR' UNION ALL SELECT '  ' || e1.name || ' -->|' || r.relation_type || '| ' || e2.name FROM public.memory_relations r JOIN public.entities e1 ON r.from_id = e1.id JOIN public.entities e2 ON r.to_id = e2.id;"

clean: ## Remove generated files and volumes
	$(DOCKER_COMPOSE) down -v
	rm -rf dist/ node_modules/
