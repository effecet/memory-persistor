# memory-persistor

[![ci](https://github.com/effecet/memory-persistor/actions/workflows/ci.yml/badge.svg)](https://github.com/effecet/memory-persistor/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-24%2B-brightgreen?logo=nodedotjs)](https://nodejs.org/)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](./tsconfig.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![MCP](https://img.shields.io/badge/MCP-server-f97316)](https://modelcontextprotocol.io/)
[![🧠 thermal memory](https://img.shields.io/badge/%F0%9F%A7%A0-thermal%20memory-7C3AED)](./src/thermal.ts)
[![live demo](https://img.shields.io/badge/live%20demo-3D%20graph-f97316?logo=github&logoColor=white)](https://effecet.github.io/memory-persistor/)
[![explore the graph](https://img.shields.io/badge/%E2%96%B6%20explore-the%20live%20graph-7c3aed?logoColor=white)](https://effecet.github.io/memory-persistor/)

A PostgreSQL-backed **MCP memory server** with thermal decay, a knowledge graph,
and 9-signal hybrid retrieval — including **local semantic embeddings** (bge-small
via ONNX, in-process, offline) — a long-term memory for AI agents (e.g. Claude
Code). Runs against any Postgres: a managed cloud instance (Supabase) or a local
Docker container.

<p align="center">
  <a href="https://effecet.github.io/memory-persistor/">
    <img src="assets/graph-preview.gif" width="720"
         alt="Interactive 3D knowledge graph — memories as nodes coloured by thermal tier (hot / warm / cold), linked by five typed relations, with activation flowing along the edges">
  </a>
</p>

<p align="center">
  <b><a href="https://effecet.github.io/memory-persistor/">▶ Explore the brain in 3D →</a></b><br>
  <sub>drag to orbit · scroll / pinch to zoom · hover to inspect · <kbd>space</kbd> to pause · <em>sample data, fully anonymized</em></sub>
</p>

> A reusable scaffold. Point it at your own Postgres, run the migrations, and wire
> it into your MCP client.

> 🛠️ **Companion:** [claude-craft-kit](https://github.com/effecet/claude-craft-kit) — an
> opinionated Claude Code workflow harness (pre-tool guards · a tiered validation gate ·
> a wrap-up gate) that wires this in as its optional long-term memory backend.

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
| `recall` | 9-signal hybrid search (FTS + trigram + **semantic vector** + temperature + importance + graph centrality + recency + access frequency). `output_mode: "summary"` returns lean triage rows — no observations body, and at most 5 `related` edges with `related_total` when truncated |
| `recall_by_ids` | Fetch full bodies for specific ids (no search) — drill-down after a capped or summary recall |
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
| `health` | Orphan count, stale count, **cosine near-duplicate pairs** (similarity scores + proposed canonical), contradictions, type coverage |
| `pending_add` | Add an item to the pending work queue (title, category, priority, body) |
| `pending_list` | List queue items, priority-ordered; `status` / `category` / `limit` / `titlesOnly` filters |
| `pending_resolve` | Close an item as `done` or `archived`, with an optional resolution note |

### Memory Types

`user` · `project` · `decision` · `fact` · `pattern` · `feedback` · `reference`

## Architecture

For the runtime data-flow and a full schema ER diagram, see
[docs/architecture.md](docs/architecture.md).

```mermaid
graph TD
    CC[MCP Client] -->|MCP| SERVER[mcp-server.ts]

    subgraph Core["Core Modules"]
        SERVER --> RET[retrieve.ts<br/>9-signal hybrid scoring]
        SERVER --> GRP[graph.ts<br/>BFS traverse, community]
        SERVER --> INT[intelligence.ts<br/>Dedup, merge, versioning]
        SERVER --> OBS[observability.ts<br/>Analytics, health, dedup pairs]
        EMB[embed.ts<br/>local ONNX embeddings] --> RET
        EMB --> OBS
    end

    subgraph Queue["Work queue — not memory"]
        PEND[pending.ts<br/>add, list, resolve]
    end

    subgraph DB["PostgreSQL 17 + pg_trgm + pgvector + pg_cron"]
        PG[(Entities + embedding<br/>+ Relations + Versions + Events)]
        PQ[(Pending)]
        CRON["pg_cron<br/>memory_thermal_decay()<br/>drizzle/0010"]
    end

    subgraph Sync["Optional"]
        FS[file-sync.ts<br/>mirror memories to markdown]
        IDX[MEMORY.md index<br/>170-line budget<br/>ranked on live thermal state]
        CAN[events_canary.py<br/>event-freshness check]
    end

    RET -->|pooled SSL connection| PG
    GRP --> PG
    INT --> PG
    OBS --> PG
    SERVER --> FS
    FS --> IDX
    PG -.->|batched pg_id &rarr; tier, temp| IDX
    CRON --> PG
    SERVER --> PEND
    PEND --> PQ
    CAN -.->|polls events<br/>alert on silence| PG

    style Core fill:#1e293b,stroke:#f97316,color:#fff
    style Queue fill:#1e293b,stroke:#facc15,color:#fff
    style DB fill:#1e293b,stroke:#22d3ee,color:#fff
    style Sync fill:#1e293b,stroke:#a78bfa,color:#fff
```

### Retrieval Scoring (9 signals)

| Signal | Weight | Source |
|--------|--------|--------|
| Full-text rank | 0.13 | `ts_rank` on `tsvector` |
| Trigram similarity | 0.10 | `pg_trgm` |
| Semantic similarity | 0.12 | `pgvector` cosine over bge-small-384 embeddings |
| Tag match | 0.10 | Array overlap |
| Temperature | 0.15 | Thermal model |
| Importance | 0.10 | Auto-drifting (0.1–0.9) |
| Graph centrality | 0.15 | Relation edge count |
| Recency boost | 0.10 | Time since last access |
| Access frequency | 0.05 | Cumulative access count |

Weights are configurable in `src/config.ts`.

### Semantic Embeddings

`recall` and the `health` dedup detector run over **local semantic embeddings** —
no text ever leaves the machine:

- **Model** — [`bge-small-en-v1.5`](https://huggingface.co/Xenova/bge-small-en-v1.5)
  (384-d) via [`@huggingface/transformers`](https://github.com/huggingface/transformers.js),
  ONNX, in-process, offline. First call loads the model (~1–2 s, warmed at boot);
  subsequent embeds are ~10–30 ms.
- **Storage** — an additive nullable `entities.embedding vector(384)` column
  ([`pgvector`](https://github.com/pgvector/pgvector)). No ANN index at small
  corpus sizes — exact brute-force cosine (`<=>`) is sub-millisecond.
- **Semantic recall** — a paraphrase with zero shared keywords can still surface,
  not just re-rank among lexical matches (the cosine arm widens the `WHERE`).
- **Cosine dedup** — `health` surfaces near-duplicate pairs above a cosine
  threshold for human-approved `merge` (never auto-merged).
- **Pinned** — model + quantization (`fp32`) are fixed; changing either
  invalidates every stored vector and requires a re-embed. A one-time
  `scripts/backfill-embeddings.ts` embeds any rows written before embeddings
  were enabled.
- **`MEMORY_EMBED_ENABLED`** — machines with the flag set embed on write; others
  store `NULL` (always safe) and let a primary backfill. Query-time embedding is
  always available so semantic recall works everywhere.

### Thermal Model

Memories have a **temperature** (0.0–1.0) that decays daily with a 0.85 multiplier:

- **Pattern-aware decay** — memories accessed 3+ days/week decay slower (access bitmap detection)
- **Cascade bumps** — accessing a memory warms its graph neighbors proportionally to edge weight
- **Auto-importance drift** — frequently accessed memories gain importance; neglected ones (60+ days) lose it
- **Tier classification** — HOT (>0.7), WARM (0.3–0.7), COLD (<0.3)
- **Stale flagging** — COLD memories untouched for 30+ days are marked stale

### Pending Work Queue

`pending_add` / `pending_list` / `pending_resolve` back a small work queue for
deferred improvements — the things an agent notices mid-task but shouldn't stop to
do. A session-start hook can read the open items and surface them as a brief.

It lives in the same database but is **deliberately not part of the memory corpus**:
no temperature, no embedding, no graph edges, no markdown mirror. Memories decay;
queue items have a lifecycle (`open → done / archived`) and are either finished or
not. Sharing the database only means a session-start hook needs one connection.

| Field | Values |
|-------|--------|
| `category` | `skill` · `rule` · `automation` · `knowledge` |
| `priority` | `low` · `medium` · `high` (ordered high → low, newest first) |
| `status` | `open` · `done` · `archived` |

`pending_list` takes `titlesOnly` for cheap triage — it blanks bodies rather than
omitting items, so a title-only listing never implies an empty body. Nothing is
ever deleted: `pending_resolve` flips `status` and stamps `resolved_at`, which is
reversible.

> **Note on RLS** — `drizzle/0009_pending.sql` creates `pending` with **no** row-level
> security policy, unlike the four memory tables which grant `anon` read access.
> That divergence is intentional (`anon` is default-denied on a private work queue),
> and the migration documents it so it doesn't get "fixed" for consistency.

### Persistence

1. **PostgreSQL** — primary store (entities, relations, versions, events, pending)
2. **Markdown files** *(optional)* — `file-sync.ts` mirrors memories to a directory of `.md` files (set `MEMORY_PERSISTOR_DIR` / `CLAUDE_DIR`), handy for agents with a file-based memory convention. The index it maintains lists one line per memory as `- <type>: <name> — <description>`.

#### Index budget

An auto-loaded index file is only useful if an agent can afford to read it, so
the index is bounded at **170 lines**. Under budget, every memory is listed.
Over it, entries are ranked and the overflow is replaced by a
`- …and N more — use \`recall\`` footer — the dropped memories are still fully
searchable, just not pre-loaded.

Retention order when the budget bites:

1. `user` and `feedback` entries first — standing instructions and identity
2. then tier: `HOT` > `WARM` > `COLD` (an unknown tier sorts as `WARM`, never dropped blind)
3. then temperature, descending
4. then filename, in **codepoint** order (not `localeCompare`, which disagrees with the display sort)

Step 1 is a priority tier, not an exemption: if protected entries alone exceeded
the budget they would still be cut among themselves, so the file cannot breach.

Temperature and tier come from **Postgres at emit time**, keyed by each file's
`pg_id` — one batched lookup per rebuild, never one per file. Frontmatter is only
rewritten when that memory is written, so ranking on it would go stale between
decays and degrade to roughly alphabetical. Two contract details follow from
that: if the database is unreachable the **whole** index falls back to
frontmatter ranking (never a mix of fresh and stale values), while a `pg_id` that
the database does not know is an **orphan** and ranks at temperature 0, so it can
never outrank a live memory.

### pg_cron Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `memory-thermal-decay` | `0 6 * * *` UTC | Nightly pattern-aware decay + importance drift + stale flagging |
| `memory-decay-startup-catchup` | `@reboot` (local Docker) | Runs `decay_catchup()` on container start if last decay was >24h ago |

The decay contract is version-controlled in
`drizzle/0010_thermal_decay_function.sql`, which creates
`public.memory_thermal_decay()` and points the schedule at it. Keeping it in a
migration rather than only as a live `cron.job` row is what makes it reviewable
and reproducible — `make cron-verify` asserts the live job still matches the
committed migration, and `tests/test_thermal_decay_migration.py` fails if a
constant in `src/config.ts` moves without the SQL.

> **Local Docker has two other inline copies of the decay SQL.**
> `initdb/01-pg-cron.sql` runs at container init, *before* any migration, so it
> seeds `memory-thermal-decay` with its own inline CTE; applying `0010`
> afterwards unschedules and replaces it, so the function wins on any container
> where migrations ran. Its `decay_catchup()` (`@reboot` catch-up) keeps a
> separate inline copy that `0010` does **not** replace. If you change the decay
> maths, change `initdb/01-pg-cron.sql` too — the migration guard does not cover
> it. A managed instance is unaffected: it never runs `initdb/`.

`decayAll()` in `src/thermal.ts` calls that same function and then does the
markdown half, which SQL structurally cannot: Postgres has no access to any
machine's filesystem, which is exactly why the scheduled path alone leaves
frontmatter stale. Run `make decay-remote` on a machine that has the memory
directory to reconcile it.

The function is **plpgsql, not a single statement**, deliberately: the decay pass
and the stale-flag pass must be separate statements, or the stale pass would
share a snapshot and not see the tiers the decay pass just wrote. Its
`cron.schedule` call is guarded on the `cron` schema existing, so the migration
still applies to ephemeral test databases that have no pg_cron.

## Development

```bash
make help              # show all targets
make test              # unit tests (Vitest + pytest for scripts)
make test-integration  # integration tests against real Postgres
make status            # local DB + pg_cron status
make decay             # run thermal decay (local)
make backfill-embeddings  # embed any rows with a NULL embedding (ARGS=--dry-run to count)
make canary            # events-pipeline freshness check (local)
make cron-status       # pg_cron schedule and recent runs
make cron-verify       # assert the live decay job matches the committed migration
make graph             # Mermaid graph of memory network
make seed              # import existing markdown memories (optional file-sync)
make clean             # remove volumes and generated files
```

Each command has a `-remote` variant (`dev-remote`, `status-remote`, `decay-remote`,
`canary-remote`, `cron-status-remote`) that targets the connection in `.env.supabase`.

> **`make test-integration` refuses a non-local database.** The suite issues
> unconditional, table-wide `DELETE`s, so `tests/integration/db-guard.ts` requires
> `DATABASE_URL` to point at localhost. A CI job whose Postgres is a *service
> container* (reachable by service name, not localhost) can opt in with
> `ALLOW_NONLOCAL_INTEGRATION_DB=1`. That opt-in is deliberately **not** wired to
> `CI=true` — plenty of local tooling exports that, and treating it as consent
> would silently disarm the guard on a developer machine. Managed hosts
> (`supabase.com` / `supabase.co` / any `pooler`) are on an unconditional denylist
> that no opt-in lifts.

### Project Structure

```
src/
  mcp-server.ts       # MCP tool definitions and handlers
  retrieve.ts         # 9-signal hybrid retrieval scoring
  embed.ts            # Local bge-small ONNX embeddings (in-process, offline)
  thermal.ts          # Cascade bumps, pattern-aware decay, importance drift
  graph.ts            # BFS traversal, community detection, auto-relate
  intelligence.ts     # Dedup detection, confidence scoring, merge, versioning
  observability.ts    # Analytics, health metrics, cosine dedup pairs
  events.ts           # Fire-and-forget event logging
  file-sync.ts        # Optional dual-write to markdown files
  pending.ts          # Work queue: add, list, resolve (not part of the memory corpus)
  schema.ts           # Drizzle ORM schema (entities, relations, versions, events, pending)
  config.ts           # Scoring weights, decay rates, tier boundaries, embed pins
  db.ts               # Database connection (auto-SSL for remote)
  import.ts           # Seed script for existing markdown memories
scripts/
  memory-decay.py            # Python decay runner (Docker exec fallback)
  events_canary.py           # Event-freshness check (exits 1 if pipeline silent)
  backfill-edges.ts          # One-time auto-relate backfill
  backfill-embeddings.ts     # One-time embedding backfill for NULL rows
  decay-remote.ts            # Manual decay pass (SQL half + the markdown half)
tests/
  *.test.ts           # Unit tests (Vitest)
  *.py                # Python tests (pytest)
  integration/        # Integration suites against real Postgres
  integration/db-guard.ts  # Refuses to run the suite against a shared database
docs/
  architecture.md     # Data-flow + schema ER diagrams
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
- **Database**: PostgreSQL 17/16 + `pg_trgm` + `pgvector` + `pg_cron`
- **Embeddings**: `@huggingface/transformers` (bge-small-en-v1.5, 384-d, ONNX, in-process)
- **Testing**: Vitest (TS) + pytest (Python) · **Container**: Docker Compose

## License

MIT — see [LICENSE](./LICENSE).
