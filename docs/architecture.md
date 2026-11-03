# Architecture

`memory-persistor` is an MCP memory server: a PostgreSQL-backed store with thermal
decay, a knowledge graph, and **9-signal hybrid retrieval**, optionally dual-written
to a directory of markdown memory files. It serves 18 tools, 6 read-only `memory://`
resources and a prompt; `src/mcp-server.ts` only starts the process, and the handlers
live in `src/mcp-tools.ts`. This document maps the runtime data flow and
the database schema.

For the high-level component view, see the [README](../README.md#architecture).

## Data flow

The three hot paths — **write**, **read**, and **dedup** — all pivot on the `entities`
table and its additive `embedding vector(384)` column. The work queue is a fourth,
deliberately separate path.

```mermaid
flowchart TD
    subgraph write["Write path (remember / update / merge)"]
        R[remember/update handler] --> E[embed.ts<br/>bge-small ONNX, in-process]
        E --> V[384-d L2-normalized vector]
        V --> PG[(entities.embedding<br/>pgvector)]
        R --> FS[file-sync.ts<br/>markdown dual-write]
        FS --> IDX[updateMemoryIndex<br/>170-line budget]
        PG -.->|batched pg_id &rarr; tier, temp| IDX
    end

    subgraph decay["Nightly decay"]
        CRON[pg_cron: memory-thermal-decay] --> FN[["public.memory_thermal_decay()<br/>last definer: drizzle/0015"]]
        FN --> PG
        FN --> TC[(thermal_cutoffs<br/>percentile tier cutoffs)]
        TC -.->|bump reads cutoffs| PG
        DA[decayAll / make decay-remote] --> FN
        DA --> FS
    end

    subgraph read["Read path (recall)"]
        Q[recall query] --> QE[embed.ts &rarr; query vector]
        QE --> SCORE[retrieve.ts<br/>relevance × 1+α·prior<br/>semantic: 1 - embedding &lt;=&gt; qvec]
        PG --> SCORE
        SCORE --> RES[ranked results<br/>superseded memories last]
        RES -->|output_mode=summary| SUM[lean rows: no body,<br/>&le;5 related + related_total]
    end

    subgraph dedup["Dedup (health tool, human-approved)"]
        PG --> COS[cosine near-dupe pairs<br/>sim &gt; 0.92]
        COS --> HC[health tool / compaction workflow]
    end

    subgraph queue["Work queue (separate from the corpus)"]
        PA[pending_add / _list / _resolve / _update] --> PQ[(pending<br/>+ applies_to host scope)]
        PQ -.->|this host's open items| BRIEF[session-start brief]
    end

    monitor[events_canary.py] -. polls for write-pipeline silence .-> PG

    subgraph conn["Connection (src/db.ts)"]
        POOL[["pg Pool<br/>options: -c search_path=public,extensions<br/>src/search-path.ts"]]
    end
    POOL --> PG
    SCORE -.->|trigram + pgvector need this pin| POOL
```

- **Write** — `remember` / `update` / `merge` embed `name + "\n" + observations` via the
  in-process `embed.ts` singleton (bge-small-384, ONNX, fp32) and persist the 384-d
  vector alongside the row. Embedding failure is **non-fatal** (the row is stored with
  `NULL` and a later backfill fills it in). The same call dual-writes the markdown file.
- **Read** — `recall` embeds the query once and scores `relevance × (1 + α·prior)`:
  four query-dependent signals (including `1 - (embedding <=> qvec)`, `COALESCE`d to `0`
  for NULL-embedding rows so lexical-only matches still rank) modulated by five
  query-independent ones. A memory with an incoming asserted `supersedes` edge ranks
  below every live match. `output_mode: "summary"` drops bodies and caps each row's
  `related` edges at 5, so a hub cannot drag its whole neighbourhood into a lean
  response; `recall_by_ids` is the drill-down.
- **Connection** — every pool pins `search_path` to `public,extensions`. Managed
  Postgres installs `pg_trgm` and `pgvector` into `extensions`, and a pooled backend
  does not reliably inherit the role's `search_path`; without the pin `recall` fails
  with `42883` on `word_similarity`.
- **Dedup** — `health` surfaces cosine near-duplicate pairs above `0.92` for
  human-approved `merge`. Nothing is ever auto-merged.
- **Index** — every markdown write rebuilds the directory's index under a 170-line
  budget, ranking retention on **live Postgres** tier/temperature via one batched
  `pg_id` lookup per rebuild. `user` and `feedback` entries are retained first, then
  HOT > WARM > COLD, then temperature, then filename in codepoint order. If the
  database is unreachable the whole index falls back to frontmatter ranking — never a
  mix — and a `pg_id` with no row ranks at temperature 0 so orphans cannot outrank
  live memories.
- **Decay** — the nightly `pg_cron` job, `make decay` and `make decay-remote` all call
  the same version-controlled `public.memory_thermal_decay()` (the last migration that
  defines it, `0015` today). It assigns tiers by rank in the live temperature
  distribution (top decile HOT, next two deciles WARM) and writes those cutoffs to
  `thermal_cutoffs`, which `bump()` reads between decays; memories at the `0` floor are
  always COLD. Postgres cannot reach any
  machine's filesystem, so the scheduled path updates rows only; `decayAll()` adds the
  markdown half and rebuilds each affected directory's index **once**, on the last
  write into it.
- **Queue** — `pending_*` writes and reads the `pending` table and touches nothing else.
  `applies_to` scopes an item to hosts (empty = fleet-wide); `pending_list` shows this
  host's items and counts the rest in `hiddenByHost`.
  Note that `pending_list` deliberately logs **no** event: it is a read-only call that
  typically fires on every session start, and logging it would keep the event stream
  permanently "fresh", defeating `events_canary.py`'s write-pipeline check.

## Database schema

Six tables. `entities` is the spine; `memory_relations` is the knowledge graph;
`memory_versions` is the audit trail; `events` is fire-and-forget observability;
`pending` is a standalone work queue with no relationship to the memory corpus;
`thermal_cutoffs` is a single row holding the current percentile tier cutoffs.

```mermaid
erDiagram
    entities ||--o{ memory_relations : "from_id"
    entities ||--o{ memory_relations : "to_id"
    entities ||--o{ memory_versions : "memory_id (cascade)"
    entities |o..o{ events : "memory_id (nullable soft ref)"

    entities {
        uuid id PK
        text name
        text type "user|project|decision|fact|pattern|feedback|reference"
        text observations
        text_array tags
        text source "CWD where remember ran"
        real importance "0.1-0.9, auto-drift"
        real temperature "0.0-1.0, decays daily"
        text tier "HOT|WARM|COLD"
        int access_count
        int access_bitmap "weekly access pattern"
        text origin_host
        timestamptz last_accessed_at
        timestamptz created_at
        boolean stale
        vector384 embedding "nullable, additive"
        real temperature_rank "nullable, cume_dist written by decay"
    }

    memory_relations {
        uuid id PK
        uuid from_id FK
        uuid to_id FK
        text relation_type "related_to|supersedes|contradicts|elaborates|depends_on"
        real weight
        text provenance "asserted|inferred"
        timestamptz created_at
    }

    memory_versions {
        uuid id PK
        uuid memory_id FK
        text name
        text observations
        text_array tags
        real importance
        timestamptz changed_at
    }

    events {
        uuid id PK
        text event_type
        uuid memory_id "nullable, no FK constraint"
        jsonb payload
        timestamptz created_at
    }

    pending {
        uuid id PK
        text title
        text body "default empty string"
        text category "skill|rule|automation|knowledge"
        text priority "low|medium|high, default medium"
        text status "open|done|archived, default open"
        text source "nullable, CWD where item was raised"
        text origin_host "nullable, where it was written"
        text_array applies_to "hosts it is true on; empty = fleet-wide"
        timestamptz created_at
        timestamptz resolved_at "nullable"
        text resolution "nullable"
    }

    thermal_cutoffs {
        smallint id PK "always 1"
        real hot_cutoff
        real warm_cutoff
        int corpus_size "0 = seed row, never measured"
        timestamptz computed_at
    }
```

`pending` has no edge to `entities` in the diagram above — that isolation is
deliberate, not an omission. It is a work queue, not memory: no thermal decay,
no embedding, no graph edges, no markdown mirror, and no FK to `entities`. It
lives in the same database purely so a session-start hook needs one connection
(see `src/schema.ts`'s comment above the table definition).

- **entities** — one row per memory. `embedding vector(384)` is nullable and additive
  (no ANN index — exact brute-force cosine `<=>` is sub-millisecond at this corpus size).
- **memory_relations** — typed graph edges; both `from_id` and `to_id` cascade-delete
  with the entity, so removing a memory tears down its edges. `provenance` records
  whether someone asserted the edge (`relate`) or it was inferred by similarity
  (`remember`'s auto-relate); graph centrality pays an inferred edge half. One row per
  `(from_id, to_id, relation_type)`, enforced by a unique index.
- **memory_versions** — a snapshot of `name` / `observations` / `tags` / `importance`
  taken before each `update`; cascade-deletes with the entity.
- **events** — every mutating tool call logs here (fire-and-forget, non-blocking).
  `memory_id` is a **nullable soft reference** with no FK constraint, so event logging
  never blocks on or is torn down by entity lifecycle.
- **thermal_cutoffs** — one row, written by each decay run; `bump()` falls back to the
  0.7 / 0.3 seeds when it is missing, a seed, or more than 48 h old.
- **pending** — a deferred-work queue (`pending_add` / `pending_list` /
  `pending_resolve` / `pending_update`), ordered `high → medium → low` then newest-first, surfaced
  as a session brief's top-10 open titles. Not part of the memory corpus. Created
  with **no RLS policy** by design — see `drizzle/0009_pending.sql`.
