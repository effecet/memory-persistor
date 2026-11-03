#!/usr/bin/env python3
"""
memory_dedup.py — reconcile a machine's local memory mirror against Postgres
(the source of truth) and report/repair slug-drift orphans.

Postgres is authoritative. This machine's primary memory dir is
~/.claude/projects/<encode($HOME)>/memory  (encode: replace / and . with -).

Tiers (per file in the primary dir):
  KEEP        canonical: filename == <type>_<slug-of-name>.md and pg_id is a live entity
  T1 DELETE   stale-slug / orphan-shadow whose canonical twin is ALSO present here
  T2 DELETE   entity is homed in another project dir AND that dir already has the file
  T3 RENAME   sole local copy of a this-dir entity under an outdated slug -> regenerate
              the canonical file from current PG content, remove the stale one
  T4 REVIEW   no matching PG entity anywhere (true local-only / never-synced) -> NEVER
              auto-deleted; a human decides (re-remember vs delete)

CRITICAL: slugify truncates to 60 chars (mirrors src/file-sync.ts). Omitting the
cap mis-identifies already-canonical truncated files as stale.

Usage:
    python3 scripts/memory_dedup.py            # read-only report
    python3 scripts/memory_dedup.py --apply    # execute T1+T2 deletes + T3 renames

Requires: psql on PATH and DATABASE_URL in env (or a .env.supabase / .env file with it).
Run in a normal terminal (not a sandboxed agent) so psql can reach the DB.
Does NOT touch any shared backup mirror of memory files — that needs a separate,
PG-reconciled pass.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

_HOOKS = Path(__file__).resolve().parent  # psql_dsn.py lives beside this script
if str(_HOOKS) not in sys.path:
    sys.path.insert(0, str(_HOOKS))
from psql_dsn import psql_env  # noqa: E402  (path-insert must precede import)

APPLY = "--apply" in sys.argv
HOME = Path.home()
CLAUDE = HOME / ".claude"

def encode(source: str) -> str:
    return source.replace("/", "-").replace(".", "-")

def slugify(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"^-+|-+$", "", s)
    return s[:120]                     # 120-char cap — must match file-sync.ts

def canon_name(e: dict) -> str:
    return f"{e['type']}_{slugify(e['name'])}.md"

THIS_ENC = encode(str(HOME))
MEMDIR = CLAUDE / "projects" / THIS_ENC / "memory"

def find_database_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    repo = Path(__file__).resolve().parent.parent
    for envf in (repo / ".env.supabase", repo / ".env"):
        if envf.exists():
            for line in envf.read_text().splitlines():
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("DATABASE_URL not found (env or .env.supabase/.env). Export it and retry.")

def dump_entities() -> list[dict]:
    q = ("select coalesce(json_agg(json_build_object("
         "'id',id,'name',name,'type',type,'source',source,"
         "'observations',observations,'temperature',temperature,'tier',tier,"
         "'importance',importance,'accessCount',access_count,'originHost',origin_host)),'[]') "
         "from entities")
    argv_dsn, env = psql_env(find_database_url())
    out = subprocess.run(["psql", argv_dsn, "-tAc", q],
                         capture_output=True, text=True, env=env)
    if out.returncode != 0:
        sys.exit(f"psql failed: {out.stderr.strip()}")
    return json.loads(out.stdout.strip())

def read_fm(p: Path) -> dict:
    """Scoped frontmatter field reader — mirrors src/file-sync.ts ::
    readFrontmatterField. Matching is confined to the `---...---` block (or
    the first 800 chars when no fence is found), so a same-named key in the
    BODY (e.g. a memory documenting `tier: HOT` as prose) is never picked up.
    Values have surrounding quotes stripped, so `tier: "HOT"` parses the same
    as `tier: HOT`.
    """
    t = p.read_text(errors="replace")
    m = re.match(r"^---\n(.*?)\n---", t, re.S)
    blk = m.group(1) if m else t[:800]
    def g(k):
        mm = re.search(rf"^\s*{k}\s*:\s*(.+)$", blk, re.M)
        return mm.group(1).strip().strip('"').strip("'") if mm else None
    return {
        "pgid": g("pg_id"), "name": g("name"), "type": g("type"),
        "tier": g("tier"), "temperature": g("temperature"),
    }

# Harness line cap for an auto-loaded MEMORY.md is 200; 170 leaves headroom.
# Output is ["# Memory Index", "", *entries, ""] joined by "\n", so the line
# count is entries + 2, or entries + 3 once a footer is appended.
# MUST match src/file-sync.ts (and any other emitter of this index).
INDEX_LINE_BUDGET = 170
MAX_ENTRIES_NO_FOOTER = INDEX_LINE_BUDGET - 2    # 168
MAX_ENTRIES_WITH_FOOTER = INDEX_LINE_BUDGET - 3  # 167

TIER_RANK = {"HOT": 0, "WARM": 1, "COLD": 2}
UNKNOWN_TIER_RANK = TIER_RANK["WARM"]

# Types never dropped ahead of others when the budget bites — standing rules and
# identity. A PRIORITY tier in the retention sort, not an exemption from the cap.
# MUST match src/file-sync.ts :: PROTECTED_TYPES.
PROTECTED_TYPES = frozenset({"user", "feedback"})


def index_footer(n: int) -> str:
    """Overflow footer. '…' is U+2026, '—' is U+2014."""
    return f"- …and {n} more — use `recall`"


def trunc_desc(s: str, mx: int = 40) -> str:
    s = (s or "").replace("\n", " ").strip()
    cp = list(s)
    if len(cp) <= mx:
        return s
    sl = cp[:mx]
    ls = "".join(sl).rfind(" ")
    return "".join(sl[:ls]) if ls > mx * 0.6 else "".join(sl)

def build_md(e: dict) -> str:
    return "\n".join([
        "---", f"name: {e['name']}", f"description: {trunc_desc(e['observations'])}",
        f"type: {e['type']}", f"temperature: {e['temperature']}", f"tier: {e['tier']}",
        f"importance: {e.get('importance', 0.5)}", f"access_count: {e.get('accessCount', 0)}",
        f"origin_host: {e.get('originHost') or 'unknown'}", f"pg_id: {e['id']}",
        "---", "", e["observations"] or "", ""])

def home_has_file(e: dict) -> str | None:
    home = CLAUDE / "projects" / encode(e["source"]) / "memory"
    if not home.exists():
        return None
    if (home / canon_name(e)).exists():
        return canon_name(e)
    pat = re.compile(rf"^pg_id:[ \t]*{re.escape(e['id'])}\s*$", re.M)
    for f in home.glob("*.md"):
        if f.name != "MEMORY.md" and pat.search(f.read_text(errors="replace")):
            return f.name
    return ""

_FETCH = object()   # sentinel: "resolve the map yourself"


def fetch_thermal_by_pgid(
    pg_ids: list[str], timeout: int = 30, url: str | None = None
) -> dict[str, tuple[str, float]] | None:
    """Batch-resolve live tier/temperature keyed by pg_id. ONE query, not one per file.

    Returns None when there is no Postgres information to rank on — the caller
    then ranks the WHOLE index on frontmatter. A partial fallback would rank
    fresh values against stale ones, the exact defect this lookup removes.

    An empty id list also returns None: a directory where no file carries a
    pg_id is the no-information case. Returning {} instead would classify every
    legacy file as an orphan and re-cut the index on filename alone.

    `timeout` bounds the psql call. It defaults to 30s for index rebuilds, but
    callers on a latency-sensitive path (a session-start hook, say) pass less,
    because session start must not stall on a slow pooler.

    `url` overrides the connection string. It exists because find_database_url()
    below does NOT honor DOTENV_CONFIG_PATH, while the MCP server's own config
    does. A caller
    that already resolved the DB the MCP is actually using must pass it, or a
    machine on the local-Docker fallback would query one database here and a
    different one everywhere else — reading every live pg_id as dead.

    Must match src/file-sync.ts :: fetchThermalByPgId.
    """
    ids = ",".join(i for i in pg_ids if re.fullmatch(r"[0-9a-fA-F-]{36}", i))
    if not ids:
        return None
    try:
        url = url or find_database_url()
    except SystemExit:
        print("[memory_dedup] no DATABASE_URL; ranking on frontmatter", file=sys.stderr)
        return None
    # Nothing is interpolated into the SQL: the id list travels as a psql
    # variable, so psql owns the quoting and the ::uuid[] cast makes Postgres
    # reject anything that is not a uuid. The regex above is a second gate.
    #
    # The query goes in on STDIN, not via -c: psql only performs :'var'
    # interpolation on lexed input, and -c is sent verbatim (verified 2026-08-16
    # — -c returns `syntax error at or near ":"`).
    q = ("select coalesce(json_agg(json_build_object("
         "'id',id,'tier',tier,'temperature',temperature)),'[]') "
         "from entities where id = ANY(string_to_array(:'ids', ',')::uuid[])")
    argv_dsn, env = psql_env(url)
    try:
        out = subprocess.run(["psql", argv_dsn, "-v", f"ids={ids}", "-tA"],
                             input=q, capture_output=True, text=True, timeout=timeout,
                             env=env)
    # TimeoutExpired FIRST: it is a SubprocessError subclass, and its __str__
    # embeds the whole argv — which carries the connection string, password and
    # all. Never interpolate the exception itself here. Verified 2026-08-17:
    #   Command '[... 'postgresql://user:SECRETPW@host/db']' timed out after 0.3s
    except subprocess.TimeoutExpired:
        print(f"[memory_dedup] thermal lookup timed out after {timeout}s; "
              "ranking on frontmatter", file=sys.stderr)
        return None
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"[memory_dedup] thermal lookup failed ({type(exc).__name__}); "
              "ranking on frontmatter", file=sys.stderr)
        return None
    if out.returncode != 0:
        print(f"[memory_dedup] thermal lookup failed ({out.stderr.strip()}); "
              "ranking on frontmatter", file=sys.stderr)
        return None
    return {r["id"]: (str(r["tier"] or ""), float(r["temperature"] or 0))
            for r in json.loads(out.stdout.strip())}


def regen_index(thermal: object = _FETCH) -> int:
    """Rebuild MEMORY.md.

    Line format is `- <type>: <name> — <description>` (no markdown link, no
    filename) to keep the context-loaded index small and human-scannable.
    Must match src/file-sync.ts :: updateMemoryIndex — whichever emitter runs
    last wins, so both change together.

    Budget rule (identical in both emitters): emit everything while entries
    <= MAX_ENTRIES_NO_FOOTER. Over that, rank PROTECTED_TYPES entries first,
    then by tier (HOT > WARM > COLD), then temperature descending, then
    filename; keep MAX_ENTRIES_WITH_FOOTER and append index_footer(dropped).
    Unknown tier ranks as WARM — never drop what could not be classified.
    Protected types are a priority tier, not an exemption — if they alone
    exceed the budget they are still cut among themselves, so the file cannot
    breach it.

    Temperature and tier come from POSTGRES, not frontmatter: the nightly
    pg_cron decay updates the database only, so frontmatter goes stale between
    writes and ranking on it made the cut effectively alphabetical. `thermal`
    is the _FETCH sentinel to resolve internally, a dict to use as-is, or None
    to rank on frontmatter without a lookup.
    """
    files = sorted(f.name for f in MEMDIR.glob("*.md") if f.name != "MEMORY.md")

    entries = []
    for f in files:
        path = MEMDIR / f
        text = path.read_text(errors="replace")
        # description deliberately does NOT go through read_fm/g(): that
        # helper strips surrounding quotes, and the TS emitter's raw
        # descMatch does not either. Keep this unscoped so all three
        # emitters produce byte-identical lines (see updateMemoryIndex).
        m = re.search(r"^description:[ \t]*(.*)$", text, re.M)
        raw = m.group(1).strip() if m else ""
        fm = read_fm(path)
        name = fm["name"] or f[:-3]
        mtype = fm["type"] or "unknown"
        tier = (fm["tier"] or "").upper()
        try:
            temp = float(fm["temperature"]) if fm["temperature"] else 0.0
        except ValueError:
            temp = 0.0
        entries.append({
            "file": f,
            "pgid": fm["pgid"] or "",
            "line": f"- {mtype}: {name} — {trunc_desc(raw) if raw else f}",
            "rank": TIER_RANK.get(tier, UNKNOWN_TIER_RANK),
            "temp": temp,
            "prot": 0 if mtype in PROTECTED_TYPES else 1,
        })

    resolved = (fetch_thermal_by_pgid([e["pgid"] for e in entries if e["pgid"]])
                if thermal is _FETCH else thermal)
    if resolved is not None:
        orphans = 0
        for e in entries:
            row = resolved.get(e["pgid"]) if e["pgid"] else None
            if row:
                e["rank"] = TIER_RANK.get(row[0].upper(), UNKNOWN_TIER_RANK)
                e["temp"] = row[1]
            else:
                # Reachable but no row: an orphan. Orphans must not outrank live
                # memories, and per-entry frontmatter fallback is forbidden — it
                # would rank a stale value against fresh ones.
                e["rank"] = UNKNOWN_TIER_RANK
                e["temp"] = 0.0
                orphans += 1
        if orphans:
            print(f"[memory_dedup] {orphans} file(s) in {MEMDIR} have no matching "
                  "entity; ranked at temperature 0", file=sys.stderr)

    kept, dropped = entries, 0
    if len(entries) > MAX_ENTRIES_NO_FOOTER:
        survivors = {
            e["file"]
            for e in sorted(entries, key=lambda e: (e["prot"], e["rank"], -e["temp"], e["file"]))[
                :MAX_ENTRIES_WITH_FOOTER
            ]
        }
        kept = [e for e in entries if e["file"] in survivors]
        dropped = len(entries) - len(kept)

    lines = ["# Memory Index", "", *[e["line"] for e in kept]]
    if dropped:
        lines.append(index_footer(dropped))
    lines.append("")
    (MEMDIR / "MEMORY.md").write_text("\n".join(lines), "utf-8")
    return len(files)

def main():
    if not MEMDIR.exists():
        sys.exit(f"primary memory dir not found: {MEMDIR}")
    ents = dump_entities()
    by_id = {e["id"]: e for e in ents}
    dir_ents = [e for e in ents if encode(e["source"]) == THIS_ENC]
    name_dir = {}
    for e in dir_ents:
        name_dir.setdefault(e["name"], e)

    files = sorted(p for p in MEMDIR.glob("*.md") if p.name != "MEMORY.md")
    present = {p.name for p in files}
    tiers = defaultdict(list)
    for f in files:
        fi = read_fm(f)
        ent = by_id.get(fi["pgid"]) if fi["pgid"] else None
        if fi["pgid"] and ent is None:
            tiers["T4_REVIEW"].append((f.name, f"dangling pg_id {fi['pgid'][:8]}")); continue
        if ent is None:
            ent = name_dir.get(fi["name"])
            if ent is None:
                tiers["T4_REVIEW"].append((f.name, "no PG entity in this dir (local-only)")); continue
        if encode(ent["source"]) != THIS_ENC:
            hf = home_has_file(ent)
            if hf:
                tiers["T2_DELETE"].append((f.name, f"homed in {encode(ent['source'])} (file {hf} present)"))
            else:
                tiers["T4_REVIEW"].append((f.name, "homed elsewhere but no home file found"))
            continue
        c = canon_name(ent)
        if f.name == c:
            tiers["KEEP"].append((f.name, "")); continue
        if c in present:
            tiers["T1_DELETE"].append((f.name, f"dup of present canonical {c}"))
        else:
            tiers["T3_RENAME"].append((f.name, c, ent["id"]))

    for k in ("KEEP", "T1_DELETE", "T2_DELETE", "T3_RENAME", "T4_REVIEW"):
        print(f"  {k}: {len(tiers[k])}")
    for fn, *r in tiers["T4_REVIEW"]:
        print(f"    REVIEW  {fn}  — {r[0]}")

    if not APPLY:
        print("\n(read-only. re-run with --apply to delete T1+T2 and regenerate T3 from PG.)")
        print("T4_REVIEW files are NEVER auto-touched — decide per file (re-remember vs delete).")
        return

    n_del = 0
    for fn, _ in tiers["T1_DELETE"] + tiers["T2_DELETE"]:
        (MEMDIR / fn).unlink(); n_del += 1
    n_ren = 0
    for fn, c, eid in tiers["T3_RENAME"]:
        (MEMDIR / c).write_text(build_md(by_id[eid]), "utf-8")
        if fn != c and (MEMDIR / fn).exists():
            (MEMDIR / fn).unlink()
        n_ren += 1
    count = regen_index()
    print(f"\nAPPLIED: deleted={n_del}, renamed={n_ren}, MEMORY.md={count} entries.")
    print("T4_REVIEW left untouched. Verify with `git status`, then commit.")

if __name__ == "__main__":
    main()
