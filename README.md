# memory-persistor

[![ci](https://github.com/effecet/memory-persistor/actions/workflows/ci.yml/badge.svg)](https://github.com/effecet/memory-persistor/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-24%2B-brightgreen?logo=nodedotjs)](https://nodejs.org/)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](./tsconfig.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![MCP](https://img.shields.io/badge/MCP-server-f97316)](https://modelcontextprotocol.io/)
[![🧠 thermal memory](https://img.shields.io/badge/%F0%9F%A7%A0-thermal%20memory-7C3AED)](./src/thermal.ts)

A PostgreSQL-backed **MCP memory server** with thermal decay, a knowledge graph,
and 8-signal hybrid retrieval — a long-term memory for AI agents (e.g. Claude
Code). Runs against any Postgres: a managed cloud instance (Supabase) or a local
Docker container.

> A reusable scaffold. Point it at your own Postgres, run the migrations, and wire
> it into your MCP client.

## Quick Start

```bash
# Local Docker (easiest to try)
cp .env.example .env          # configure credentials
make up                       # start Postgres + pg_cron (Docker)
make migrate                  # run Drizzle schema migrations
make dev                      # start the MCP server

# Managed Postgres (e.g. Supabase)
cp .env.supabase.example .env.supabase   # add your pooler connection string
make dev-remote                          # start the MCP server against it
```

## MCP Tools

The server exposes these tools to an MCP client:

| Tool | Purpose |
|------|---------|
| `remember` | Store a memory with tags, type, importance — auto-relates to top-3 FTS matches, dedup-checks |
| `recall` | 8-signal hybrid search (FTS + trigram + temperature + importance + graph centrality + recency + access frequency) |
| `forget` | Delete a memory, cascade its relations, remove the synced markdown file |
| `update` | Partial update with automatic version snapshot before changes |
| `relate` | Create typed edges: `related_to`, `supersedes`, `contradicts`, `elaborates`, `depends_on` |
| `status` | Dashboard — tier/type breakdown, hottest/coldest memories, stale count |
| `graph` | Mermaid flowchart of the memory network |
| `traverse` | Multi-hop BFS graph traversal (depth 1–5, filterable by relation type) |
| `history` | Version chain for a memory (snapshots before each update) |
| `merge` | Combine duplicates — append observations, union tags, transfer edges |
| `conflicts` | List all `contradicts` edge pairs |
| `analytics` | Recall hit rate, top accessed, temperature distribution, events/day, graph density |
| `health` | Orphan count, stale count, dedup candidate pairs (similarity scores + proposed canonical), contradictions, type coverage |

### Memory Types

`user` · `project` · `decision` · `fact` · `pattern` · `feedback` · `reference`

## Architecture

```mermaid
graph TD
    CC[MCP Client] -->|MCP| SERVER[mcp-server.ts]

    subgraph Core["Core Modules"]
        SERVER --> RET[retrieve.ts<br/>8-signal hybrid scoring]
        SERVER --> GRP[graph.ts<br/>BFS traverse, community]
        SERVER --> INT[intelligence.ts<br/>Dedup, merge, versioning]
        SERVER --> OBS[observability.ts<br/>Analytics, health, dedup pairs]
    end

    subgraph DB["PostgreSQL 17 + pg_trgm + pg_cron"]
        PG[(Entities + Relations<br/>+ Versions + Events)]
        CRON[pg_cron<br/>Nightly decay]
    end

    subgraph Sync["Optional"]
        FS[file-sync.ts<br/>mirror memories to markdown]
        CAN[events_canary.py<br/>event-freshness check]
    end

    RET -->|pooled SSL connection| PG
    GRP --> PG
    INT --> PG
    OBS --> PG
    SERVER --> FS
    CAN -.->|polls events<br/>alert on silence| PG

    style Core fill:#1e293b,stroke:#f97316,color:#fff
    style DB fill:#1e293b,stroke:#22d3ee,color:#fff
    style Sync fill:#1e293b,stroke:#a78bfa,color:#fff
```

### Retrieval Scoring (8 signals)

| Signal | Weight | Source |
|--------|--------|--------|
| Full-text rank | 0.20 | `ts_rank` on `tsvector` |
| Trigram similarity | 0.15 | `pg_trgm` |
| Tag match | 0.10 | Array overlap |
| Temperature | 0.15 | Thermal model |
| Importance | 0.10 | Auto-drifting (0.1–0.9) |
| Graph centrality | 0.15 | Relation edge count |
| Recency boost | 0.10 | Time since last access |
| Access frequency | 0.05 | Cumulative access count |

Weights are configurable in `src/config.ts`.

### Thermal Model

Memories have a **temperature** (0.0–1.0) that decays daily with a 0.85 multiplier:

- **Pattern-aware decay** — memories accessed 3+ days/week decay slower (access bitmap detection)
- **Cascade bumps** — accessing a memory warms its graph neighbors proportionally to edge weight
- **Auto-importance drift** — frequently accessed memories gain importance; neglected ones (60+ days) lose it
- **Tier classification** — HOT (>0.7), WARM (0.3–0.7), COLD (<0.3)
- **Stale flagging** — COLD memories untouched for 30+ days are marked stale

### Persistence

1. **PostgreSQL** — primary store (entities, relations, versions, events)
2. **Markdown files** *(optional)* — `file-sync.ts` mirrors memories to a directory of `.md` files (set `MEMORY_PERSISTOR_DIR` / `CLAUDE_DIR`), handy for agents with a file-based memory convention.

### pg_cron Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `memory-thermal-decay` | `0 6 * * *` UTC | Nightly pattern-aware decay + importance drift + stale flagging |
| `memory-decay-startup-catchup` | `@reboot` (local Docker) | Runs `decay_catchup()` on container start if last decay was >24h ago |

## Development

```bash
make help              # show all targets
make test              # unit tests (Vitest + pytest for scripts)
make test-integration  # integration tests against real Postgres
make status            # local DB + pg_cron status
make decay             # run thermal decay (local)
make canary            # events-pipeline freshness check (local)
make cron-status       # pg_cron schedule and recent runs
make graph             # Mermaid graph of memory network
make seed              # import existing markdown memories (optional file-sync)
make clean             # remove volumes and generated files
```

Each command has a `-remote` variant (`dev-remote`, `status-remote`, `decay-remote`,
`canary-remote`) that targets the connection in `.env.supabase`.

### Project Structure

```
src/
  mcp-server.ts       # MCP tool definitions and handlers
  retrieve.ts         # 8-signal hybrid retrieval scoring
  thermal.ts          # Cascade bumps, pattern-aware decay, importance drift
  graph.ts            # BFS traversal, community detection, auto-relate
  intelligence.ts     # Dedup detection, confidence scoring, merge, versioning
  observability.ts    # Analytics, health metrics, dedup candidate pairs
  events.ts           # Fire-and-forget event logging
  file-sync.ts        # Optional dual-write to markdown files
  schema.ts           # Drizzle ORM schema (entities, relations, versions, events)
  config.ts           # Scoring weights, decay rates, tier boundaries
  db.ts               # Database connection (auto-SSL for remote)
  import.ts           # Seed script for existing markdown memories
scripts/
  memory-decay.py     # Python decay runner (Docker exec fallback)
  events_canary.py    # Event-freshness check (exits 1 if pipeline silent)
  backfill-edges.ts   # One-time auto-relate backfill
tests/
  *.test.ts           # Unit tests (Vitest)
  *.py                # Python tests (pytest)
  integration/        # Integration suites against real Postgres
drizzle/              # Migration files
initdb/
  01-pg-cron.sql      # pg_cron setup, decay job, startup catchup function
docker-compose.yml    # Local Postgres 16 + pg_cron + pg_trgm
LICENSE               # MIT
```

## Configuration

### Local Docker (fallback)

Copy `.env.example` and adjust:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/memory_persistor` | Postgres connection string |
| `POSTGRES_PASSWORD` | `postgres` | Docker Compose Postgres password |
| `MEMORY_PERSISTOR_DIR` | project root | Base path for optional markdown mirror |
| `CLAUDE_DIR` | `~/.claude` | Directory for optional markdown mirror |

### Managed Postgres (e.g. Supabase)

Create `.env.supabase` with a pooler connection string (transaction mode, port 6543):

```
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

`src/db.ts` auto-detects a remote host and enables SSL. It respects an explicit
`sslmode=...` query param, so a no-SSL service container (CI) and a forced-SSL
managed instance can coexist.

## CI

GitHub Actions (`.github/workflows/ci.yml`, `ubuntu-latest`) on every push and PR:
`npm ci` → `npm run build` → Vitest unit suite → pytest (scripts) → gitleaks.
The integration suite (`make test-integration`) runs against a real Postgres and
is intended to be run locally / against your own instance.

Secrets scanning uses `.gitleaks.toml` (built-in rules + an allowlist for local
files and documentation placeholders).

## Stack

- **Runtime**: Node.js 24+ (ESM) · **Language**: TypeScript 5.9 (strict)
- **ORM**: Drizzle ORM · **MCP SDK**: `@modelcontextprotocol/sdk` · **Validation**: Zod
- **Database**: PostgreSQL 17/16 + `pg_trgm` + `pg_cron`
- **Testing**: Vitest (TS) + pytest (Python) · **Container**: Docker Compose

## License

MIT — see [LICENSE](./LICENSE).
