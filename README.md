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
make migrate                  # apply the hand-written SQL migrations (psql)
make dev                      # start the MCP server

# Managed Postgres (e.g. Supabase)
cp .env.supabase.example .env.supabase   # add your pooler connection string
make dev-remote                          # start the MCP server against it
```

## MCP Tools

The server exposes 18 tools, 6 resources and 1 prompt via the Model Context Protocol:

| Tool | Purpose |
|------|---------|
| `remember` | Store a memory with tags, type, importance — auto-relates to top-3 FTS matches, dedup-checks. Rejects a conversation transcript; tags an undated volatile figure `volatile` and reports it in `flags` (claim contract) |
| `recall` | Hybrid search scored as `relevance × (1 + α·prior)` — relevance (FTS + trigram + **semantic cosine** + tag) modulated by a query-independent prior (temperature + importance + graph centrality + recency + access frequency). `output_mode: full\|summary` with a 30 KB response cap — summary rows drop the observations body and keep at most 5 `related` edges, adding `related_total` when truncated. A memory with an incoming asserted `supersedes` edge always ranks below every live match and carries `superseded_by: [{id, name}]` |
| `recall_by_ids` | Fetch full bodies for specific ids (no search) — drill-down after a summary-mode recall |
| `forget` | Delete a memory, cascade its relations, remove the synced markdown file |
| `update` | Partial update with automatic version snapshot before changes; a new body is re-checked against the claim contract. `append_observations` adds text to the end of the stored body instead of replacing it (not atomic, not idempotent) |
| `relate` | Create typed edges: `related_to`, `supersedes`, `contradicts`, `elaborates`, `depends_on`. Stored with provenance `asserted`; `remember`'s auto-relate edges are `inferred`, and graph centrality pays an inferred edge half. A self-link is rejected; repeating an existing edge returns it (`existing: true`) instead of writing a duplicate |
| `status` | Dashboard — tier/type breakdown, hottest/coldest memories, stale count |
| `graph` | Mermaid flowchart of the memory network |
| `traverse` | Multi-hop BFS graph traversal (depth 1–5, filterable by relation type) |
| `history` | Version chain for a memory (snapshots before each update) |
| `merge` | Combine duplicates — append observations, union tags (the `volatile` tag is recomputed over the merged body), transfer edges |
| `conflicts` | List all `contradicts` edge pairs |
| `analytics` | Recall hit rate, top accessed, temperature distribution, events/day, graph density |
| `health` | Orphan count, stale count, **cosine near-duplicate pairs** (similarity scores + proposed canonical), contradictions, type coverage, asserted/inferred edge split. Lists are row-capped and the response is byte-capped in the units the server emits |
| `pending_add` | Add an item to the pending work queue (title, category, priority, body, `appliesTo` host scope — empty = fleet-wide) |
| `pending_list` | List queue items, priority-ordered, **scoped to this host** by default; `status` / `category` / `limit` / `titlesOnly` / `allHosts` filters. `total` counts in-scope items only; `hiddenByHost` counts those scoped elsewhere |
| `pending_resolve` | Close an item as `done` or `archived`, with an optional resolution note |
| `pending_update` | Correct an open queue item in place (title, body, priority, category, `appliesTo`) — no archive + re-add |

**Toolsets.** Set `MEMORY_PERSISTOR_TOOLSETS` (comma-separated: `core`, `maintenance`, `queue`, or `all`) to register only some tools — `core` gives the 9 read/write tools. Unset means all 18. An unknown name warns on stderr; a value naming only unknown sets falls back to every tool. A prompt is offered only when its tools are. Resources are always exposed, so `status`, `graph`, the queue and entity bodies stay readable whatever is set. Toolsets narrow what a model chooses among — they are not access control.

**Error contract.** A failed tool call returns `isError: true` with a JSON body `{error, errorCategory, isRetryable}`. `errorCategory` is one of `validation`, `business`, `permission`, `transient` or `internal`, and `isRetryable` is true only for `transient`. A call that succeeded but had a non-fatal step fail (an embedding, an auto-relate) still succeeds and reports the step in `warnings`.

### MCP Resources

Read-only and side-effect-free: reading one never bumps temperature (unlike `recall` / `recall_by_ids`).

| URI | Contents |
|-----|----------|
| `memory://index` | Counts per type and tier, linking each type's listing |
| `memory://index/{type}` | One line per memory of that type → `memory://entity/{id}`, hottest first; capped at 30 KB with an "…and N more" footer |
| `memory://entity/{id}` | One memory's full body and edges, in `recall_by_ids`' shape — never capped or bumped |
| `memory://pending` | The top 10 open queue items for this host, plus `total` and `hiddenByHost` |
| `memory://status` | The `status` dashboard |
| `memory://graph` | The `graph` Mermaid flowchart |

### MCP Prompts

User-started workflows. A prompt reads its procedure from a markdown file under `prompts/` on every request, so the file is the single source of truth and an edit needs no restart. In Claude Code a prompt appears as `/mcp__memory-persistor__<name>`.

| Prompt | Source | Arguments |
|--------|--------|-----------|
| `clear_pending` | `prompts/clear-pending.md` | `category` (optional) |

To add your own, put a markdown file under `prompts/` and register it in `PROMPT_SOURCES` and `PROMPTS` in `src/mcp-prompts.ts`. A prompt whose file is missing is not offered at all (the server logs a warning to stderr), rather than failing when a client fetches it.

### Memory Types

`user` · `project` · `decision` · `fact` · `pattern` · `feedback` · `reference`

## Architecture

For the runtime data-flow and a full schema ER diagram, see
[docs/architecture.md](docs/architecture.md).

```mermaid
graph TD
    CC[MCP Client] -->|MCP stdio| BOOT[mcp-server.ts<br/>startup only]
    BOOT --> SERVER[mcp-tools.ts<br/>18 tools · error contract · toolsets]
    SERVER --> RES[mcp-resources.ts<br/>6 read-only resources]
    SERVER --> PRM[mcp-prompts.ts<br/>prompts from prompts/*.md]
    SERVER --> ERR[errors.ts<br/>categorised errors · leaf]

    subgraph Core["Core Modules"]
        SERVER --> RET[retrieve.ts<br/>relevance × 1+α·prior]
        SERVER --> GRP[graph.ts<br/>BFS traverse, community]
        SERVER --> INT[intelligence.ts<br/>Dedup, merge, versioning]
        SERVER --> OBS[observability.ts<br/>Analytics, capped health]
        SERVER --> THM[thermal.ts<br/>bump, decay, percentile tiers]
        EMB[embed.ts<br/>local ONNX embeddings] --> RET
        EMB --> OBS
    end

    subgraph Queue["Work queue — not memory"]
        PEND[pending.ts<br/>add, list, resolve, update<br/>host-scoped]
    end

    subgraph DB["PostgreSQL 17 + pg_trgm + pgvector + pg_cron"]
        PG[(Entities + embedding<br/>+ Relations with provenance<br/>+ Versions + Events)]
        PQ[(Pending + applies_to)]
        TC[(thermal_cutoffs)]
        CRON["pg_cron<br/>memory_thermal_decay()<br/>drizzle/0015"]
    end

    subgraph Sync["Optional"]
        FS[file-sync.ts<br/>mirror memories to markdown]
        IDX[MEMORY.md index<br/>170-line budget<br/>ranked on live thermal state]
        CAN[events_canary.py<br/>event-freshness check]
    end

    RET -->|"pooled connection<br/>search_path pinned public,extensions"| PG
    GRP --> PG
    INT --> PG
    OBS --> PG
    THM --> PG
    THM -.->|reads cutoffs| TC
    SERVER --> FS
    FS --> IDX
    PG -.->|batched pg_id &rarr; tier, temp| IDX
    CRON --> PG
    CRON --> TC
    SERVER --> PEND
    PEND --> PQ
    CAN -.->|polls events<br/>alert on silence| PG

    style Core fill:#1e293b,stroke:#f97316,color:#fff
    style Queue fill:#1e293b,stroke:#facc15,color:#fff
    style DB fill:#1e293b,stroke:#22d3ee,color:#fff
    style Sync fill:#1e293b,stroke:#a78bfa,color:#fff
```

### Retrieval Scoring

```
score = relevance x (1 + PRIOR_ALPHA * prior)
```

Nine signals in two groups, each **normalized to sum to 1.0** and each evaluating to `[0,1]`.

| Group | Signal | Weight (share of group) | Source |
|-------|--------|------------------------|--------|
| relevance (query-dependent) | Full-text rank | 0.289 | `ts_rank` on `tsvector` |
| | Trigram similarity | 0.222 | `pg_trgm` |
| | Semantic similarity | 0.267 | `pgvector` cosine on `embedding vector(384)` |
| | Tag match | 0.222 | Array overlap (distinct) |
| prior (query-independent) | Temperature | 0.273 | Thermal model |
| | Graph centrality | 0.273 | Normalized node degree, weighted by edge provenance (inferred = 0.5 of asserted) |
| | Importance | 0.182 | Auto-drifting (0.1–0.9) |
| | Recency boost | 0.182 | Time since last access |
| | Access frequency | 0.091 | Cumulative access count |

`PRIOR_ALPHA` is **0.2**, so a maximal prior lifts a score by 20% — enough to break a
near-tie, not enough to overturn a better match. `score` therefore spans `[0, 1.2]`, and
each result also carries `relevance` on its own. `PRIOR_ALPHA = 0` disables priors.

Priors **modulate** relevance rather than adding to it. Under the earlier flat additive
model the five query-independent signals held 0.55 of the score against relevance's
0.45, and they are mutually correlated — a frequently-recalled hub is hot, central,
recent and well-accessed at once — so one popular memory could outrank an exact match.
Weights and α live in `src/config.ts`.

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
- **Percentile tiers** — tier comes from a memory's rank in the live temperature distribution, not a fixed threshold: HOT is the top decile, WARM the next two deciles, COLD the rest. The nightly decay writes the cutoffs to `thermal_cutoffs`; `bump()` reads them, and falls back to the 0.7 / 0.3 seeds if they are missing or more than 48 h old
- **Cold floor** — decay writes exactly 0 below `1e-6` (a float4 product that underflows aborts the query), and memories at 0 are always COLD, whatever their rank
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

**Host scope.** `origin_host` records where an item was written; `applies_to` records where it is TRUE (empty = fleet-wide). `pending_list` shows fleet-wide items plus those scoped to this host, and reports `hiddenByHost` for the rest; `allHosts: true` lists everything. Host names are normalized (lower-cased, cut at the first dot, only `[a-z0-9_-]` kept) on both write and read; `tests/test_host_normalization_parity.py` is the reference table a client that filters by host must match. `pending_update` corrects an item in place, so fixing a title or a scope never resets its age or id.

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

The decay contract is version-controlled as a migration. `drizzle/0010` created
`public.memory_thermal_decay()` and pointed the schedule at it; later migrations
replaced the function body (percentile tiers, `origin_host`, the cold floor), and the
last one to define it — `drizzle/0015_thermal_decay_floor_is_cold.sql` today — is
what runs. The schedule still lives only in `0010`. Keeping it in a
migration rather than only as a live `cron.job` row is what makes it reviewable
and reproducible — `make cron-verify` asserts the live job still matches the
committed migration, and `tests/test_thermal_decay_migration.py` finds the last
defining migration and fails if a constant in `src/config.ts` moves without the SQL.

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
make test-integration  # integration tests, then the isolated thermal suite, each on a fresh throwaway DB
make test-thermal      # only the isolated thermal suite (corpus-wide decay, on its own DB)
make status            # local DB + pg_cron status
make decay             # run thermal decay (local)
make backfill-embeddings  # embed any rows with a NULL embedding (ARGS=--dry-run to count)
make canary            # events-pipeline freshness check (local)
make cron-status       # pg_cron schedule and recent runs
make cron-verify       # assert the live decay job matches the committed migration
make pending-verify    # assert pending.applies_to has the right shape
make ranking-guard     # ranking-regression guard (skips without a golden corpus)
make graph             # Mermaid graph of memory network
make seed              # import existing markdown memories (optional file-sync)
make clean             # remove volumes and generated files
```

Each command has a `-remote` variant (`dev-remote`, `status-remote`, `decay-remote`,
`canary-remote`, `cron-status-remote`) that targets the connection in `.env.supabase`.

The integration targets create and drop their own databases (`memory_persistor_test`,
`memory_persistor_isolated_test`, `memory_persistor_guard`) in the local container and
never touch `memory_persistor`. The thermal suite gets a database of its own because it
calls the corpus-wide decay function, which would re-tier every other suite's fixtures.

### Ranking guard

`scripts/ranking-guard.ts` seeds a frozen corpus into a throwaway database, runs a set
of golden queries, and fails when a target memory's rank moves the wrong way against a
recorded baseline. It is a regression guard, not a quality bar: it says whether a change
moved ranking, not whether ranking is good. `scripts/score-benchmark.ts` uses the same
queries to choose `PRIOR_ALPHA` from measurement.

**No corpus ships with this repository.** The guard only means something on a corpus
with a real shape (hubs, a thermal spread, a power-law degree distribution), and a
snapshot of a real memory database is someone's memories. Without one, both scripts print
a skip line and exit 0, and the fixture-bound tests skip with that reason. To guard your
own deployment:

1. `make ranking-snapshot` — snapshot a slice of your database (read-only on the source)
   into `tests/fixtures/golden-corpus.json`. `DOTENV_CONFIG_PATH` picks the database,
   default `.env`.
2. Write `tests/fixtures/golden-queries.json`: queries with `expect_top` /
   `expect_not_top` memory names and a `source` note for each.
3. `make ranking-baseline`, then review the baseline diff before committing.
4. `make ranking-guard` from then on (CI runs it too).

Keep those fixtures out of a public fork.

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
  mcp-server.ts       # Process startup only (stdio transport)
  mcp-tools.ts        # Tool definitions and handlers, error contract, toolsets
  mcp-resources.ts    # Read-only memory:// resources
  mcp-prompts.ts      # User-started prompts, read from prompts/*.md
  errors.ts           # Error categories and the wire shape (leaf module)
  claim-contract.ts   # Write-time checks on what a memory body claims
  retrieve.ts         # relevance × (1 + α·prior) hybrid retrieval
  embed.ts            # Local bge-small ONNX embeddings (in-process, offline)
  thermal.ts          # Cascade bumps, pattern-aware decay, importance drift
  thermal-cutoffs.ts  # Percentile tier cutoffs, with seed fallback
  graph.ts            # BFS traversal, community detection, auto-relate
  intelligence.ts     # Dedup detection, confidence scoring, merge, versioning
  observability.ts    # Analytics, capped health metrics, cosine dedup pairs
  events.ts           # Fire-and-forget event logging
  file-sync.ts        # Optional dual-write to markdown files
  pending.ts          # Host-scoped work queue (not part of the memory corpus)
  schema.ts           # Drizzle ORM schema
  config.ts           # Scoring weights, decay rates, tier quantiles, embed pins, toolsets
  db.ts               # Database connection (auto-SSL for remote, pinned search_path)
  search-path.ts      # search_path pin shared by every pool
  import.ts           # Seed script for existing markdown memories
prompts/
  clear-pending.md    # Procedure behind the clear_pending prompt
scripts/
  memory-decay.py            # Python decay runner (Docker exec fallback)
  events_canary.py           # Event-freshness check (exits 1 if pipeline silent)
  memory_dedup.py            # Reconcile a markdown mirror against Postgres
  import_pending.py          # One-shot pending.md → pending table importer
  psql_dsn.py                # Split a DSN so the password never reaches argv
  ranking-guard.ts           # Ranking-regression guard (needs your own corpus)
  score-benchmark.ts         # Read-only scoring benchmark for choosing α
  golden-corpus.ts           # Golden corpus fixture contract
  snapshot-golden-corpus.ts  # Snapshot your corpus into a fixture
  backfill-edges.ts          # One-time auto-relate backfill
  backfill-embeddings.ts     # One-time embedding backfill for NULL rows
  decay-remote.ts            # Manual decay pass (SQL half + the markdown half)
  precache-embed-model.ts    # CI helper: warm the bge-small model cache
  spike/                     # Cross-machine embedding parity check
tests/
  *.test.ts           # Unit tests (Vitest)
  test_*.py           # Python tests (pytest)
  integration/        # Integration suites against real Postgres
  integration/isolated/  # Suites that change database-wide state, on their own DB
  integration/db-guard.ts  # Refuses to run the suite against a shared database
docs/
  architecture.md     # Data-flow + schema ER diagrams
drizzle/              # Migration files
initdb/
  01-pg-cron.sql      # pg_cron setup, decay job, startup catchup function
docker-compose.yml    # Local Postgres 16 + pg_cron + pg_trgm + pgvector
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
| `MEMORY_EMBED_ENABLED` | unset | `true` embeds on write; unset stores `NULL` for a primary to backfill |
| `MEMORY_PERSISTOR_TOOLSETS` | unset (all) | Comma-separated toolsets to register: `core`, `maintenance`, `queue`, `all` |

### Managed Postgres (e.g. Supabase)

Create `.env.supabase` with a pooler connection string (transaction mode, port 6543):

```
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

`src/db.ts` auto-detects a remote host and enables SSL. It respects an explicit
`sslmode=...` query param, so a no-SSL service container (CI) and a forced-SSL
managed instance can coexist.

## CI

GitHub Actions (`.github/workflows/ci.yml`) on every push and PR, two jobs:

- **build-test** — `npm ci` → `npm run build` (TypeScript build + typecheck of `scripts/`) → Vitest unit suite → pytest → gitleaks.
- **integration** — a `pgvector/pgvector:pg17` service container; applies `drizzle/*.sql` in order, runs the integration suite, then the isolated thermal suite on its own database, then the ranking guard on a third (which skips without a golden corpus).

Secrets scanning uses `.gitleaks.toml` (built-in rules + an allowlist for local
files and documentation placeholders).

## Stack

- **Runtime**: Node.js 24+ (ESM) · **Language**: TypeScript 7 (strict)
- **ORM**: Drizzle ORM · **MCP SDK**: `@modelcontextprotocol/sdk` · **Validation**: Zod
- **Database**: PostgreSQL 17/16 + `pg_trgm` + `pgvector` + `pg_cron`
- **Embeddings**: `@huggingface/transformers` (bge-small-en-v1.5, 384-d, ONNX, in-process)
- **Testing**: Vitest (TS) + pytest (Python) · **Container**: Docker Compose

## License

MIT — see [LICENSE](./LICENSE).
