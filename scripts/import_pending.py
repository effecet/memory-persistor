#!/usr/bin/env python3
"""One-shot importer: ~/.claude/pending.md → the Postgres `pending` table.

Report-only by default; pass --apply to write. Entries older than --cutoff-days
(default 90) import as status='archived' so the session brief shows live work
rather than a queryable junk drawer — nothing is lost, archived rows stay
readable via `pending_list --status archived`.

Parsing hazard this handles: `## [date] title` headers also appear INSIDE
`<!-- ARCHIVED ... -->` comment blocks. Archived blocks are stripped FIRST,
then parsed separately, so nested entries are neither double-counted nor lost.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

_HOOKS = Path(__file__).resolve().parent  # psql_dsn.py lives beside this script
if str(_HOOKS) not in sys.path:
    sys.path.insert(0, str(_HOOKS))
from psql_dsn import psql_env  # noqa: E402  (path-insert must precede import)

DEFAULT_FILE = Path.home() / ".claude" / "pending.md"
DEFAULT_CUTOFF_DAYS = 90

ARCHIVED_BLOCK_RE = re.compile(r"<!--\s*ARCHIVED.*?-->", re.S)
ENTRY_SPLIT_RE = re.compile(r"^## \[(\d{4}-\d{2}-\d{2})\]\s+(.+?)\s*$", re.M)
CATEGORY_RE = re.compile(r"^\*\*Category:\*\*\s*(.+?)\s*$", re.M)
PRIORITY_RE = re.compile(r"^\*\*Priority:\*\*\s*(.+?)\s*$", re.M)
ARCHIVED_DATE_RE = re.compile(r"<!--\s*ARCHIVED\s+(\d{4}-\d{2}-\d{2})")
# The parenthetical that follows the archive date — "(resolved in commit
# a1b2c3d)", "(an earlier issue closed 2026-04-27)". re.S because some
# real headers wrap their parenthetical across physical lines.
ARCHIVED_PROSE_RE = re.compile(
    r"<!--\s*ARCHIVED\s+\d{4}-\d{2}-\d{2}\s*\(([^)]*)\)", re.S
)

VALID_CATEGORIES = {"skill", "rule", "automation", "knowledge"}
VALID_PRIORITIES = {"low", "medium", "high"}

# Legacy-data normalization. A hand-written pending.md drifts from its own
# documented format; these handle the drifts seen in practice.
# This is a one-shot importer — it runs once, against this
# one file, and is never a general-purpose parser.
FALLBACK_CATEGORY = "knowledge"
FALLBACK_PRIORITY = "low"
# A status value that leaked into the Priority field (one entry, whose title
# also says "✅ DONE"). Maps to a real status rather than a bogus priority.
PRIORITY_STATUS_LEAKS = {"done"}

# Class A prose. An entry that aged past the cutoff was never resolved — it just
# stopped being live. The wording has to make that unmistakable, because
# `resolved_at` is the only timestamp column and a bare date there reads as a
# completion to anyone querying it later.
AGE_ARCHIVE_NOTE = (
    "Auto-archived at Postgres import {date}: older than {days} days and never "
    "explicitly resolved. NOT a completion."
)


@dataclass
class PendingEntry:
    title: str
    body: str
    category: str
    priority: str
    status: str
    created: date
    # Defaulted and appended last so existing positional construction keeps
    # working. Both are nullable in the table and stay None for open rows.
    resolved_at: date | None = None
    resolution: str | None = None


def strip_archived(raw: str) -> tuple[str, list[str]]:
    """Split the file into (text with ARCHIVED blocks removed, the blocks)."""
    blocks = ARCHIVED_BLOCK_RE.findall(raw)
    open_text = ARCHIVED_BLOCK_RE.sub("", raw)
    return open_text, blocks


def _field(pattern: re.Pattern[str], chunk: str, label: str, title: str) -> str | None:
    """Extract a `**Label:** value` field, or None when absent."""
    match = pattern.search(chunk)
    return match.group(1).strip().lower() if match else None


def normalize_category(raw: str | None) -> str | None:
    """Collapse a slash-joined category to its first token.

    Three legacy entries use 'rule / automation' or 'rule/automation'; the
    first token is the primary intent. Returns None when there is nothing to
    normalize, so the caller can decide between raising and falling back.
    """
    if raw is None:
        return None
    return raw.split("/")[0].strip().lower()


def normalize_priority(raw: str | None) -> tuple[str | None, str | None]:
    """Return (priority, status_override).

    One legacy entry carries '**Priority:** done' — a status that landed in the
    priority slot. It becomes status='done' with a default priority rather than
    an invalid priority value.
    """
    if raw is None:
        return None, None
    val = raw.strip().lower()
    if val in PRIORITY_STATUS_LEAKS:
        return "medium", "done"
    return val, None


def _body_of(chunk: str) -> str:
    """Everything after the Category/Priority lines, whitespace-trimmed."""
    lines = [
        line
        for line in chunk.splitlines()
        if not line.startswith("**Category:**") and not line.startswith("**Priority:**")
    ]
    return "\n".join(lines).strip()


def parse_entries(
    text: str, status_for: str | None = None, tolerant: bool = False
) -> list[PendingEntry]:
    """Parse `## [date] title` entries out of ARCHIVED-stripped text.

    status_for, when given, forces the status (used for nested archived
    entries); otherwise the caller classifies by age.

    tolerant=False (open entries): normalize, then validate strictly. An entry
    that is still out-of-vocabulary after normalization raises — open items are
    what the session brief shows, so a wrong category there is a real problem.

    tolerant=True (nested archived entries): fall back silently. Thirteen of the
    fifteen nested entries were never written with Category/Priority at all.
    They are history; a fabricated 'knowledge'/'low' label costs nothing and
    dropping them would lose the record.
    """
    entries: list[PendingEntry] = []
    matches = list(ENTRY_SPLIT_RE.finditer(text))
    for i, match in enumerate(matches):
        created = datetime.strptime(match.group(1), "%Y-%m-%d").date()
        title = match.group(2).strip()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[match.end() : end]

        category = normalize_category(_field(CATEGORY_RE, chunk, "Category", title))
        priority, status_override = normalize_priority(
            _field(PRIORITY_RE, chunk, "Priority", title)
        )

        if tolerant:
            if category not in VALID_CATEGORIES:
                category = FALLBACK_CATEGORY
            if priority not in VALID_PRIORITIES:
                priority = FALLBACK_PRIORITY
        else:
            if category not in VALID_CATEGORIES:
                raise ValueError(f"Unknown category {category!r} for entry {title!r}")
            if priority not in VALID_PRIORITIES:
                raise ValueError(f"Unknown priority {priority!r} for entry {title!r}")

        entries.append(
            PendingEntry(
                title=title,
                body=_body_of(chunk),
                category=category,
                priority=priority,
                status=status_for or status_override or "open",
                created=created,
            )
        )
    return entries


def _block_preamble(inner: str) -> str:
    """Everything in an ARCHIVED block before its first `## [date]` entry, or
    '' when the block has no nested entry.

    The `ARCHIVED <date> (resolved...)` header is kept verbatim rather than
    stripped as metadata. Two reasons: it is the single most useful sentence on
    an archived row (it records how the item was resolved), and it is not
    reliably one line — some real blocks wrap their header parenthetical
    across two or three physical lines, so any line-based strip leaves garbled
    fragments like 'generated output files):' behind.
    """
    first = ENTRY_SPLIT_RE.search(inner)
    if not first:
        return ""
    return inner[: first.start()].strip()


def parse_archived_blocks(blocks: list[str]) -> list[PendingEntry]:
    """Turn ARCHIVED comment blocks into archived rows.

    A block either wraps one or more `## [date] title` entries (import each) or
    is a prose-only resolution note (import the whole block as one row, so the
    history is preserved rather than dropped).

    A block that wraps entries may ALSO carry resolution context before the
    first `## [date]` header. `parse_entries` only sees text *after* a header,
    so that context would be silently dropped — it is prepended to the first
    nested entry's body instead. Some real blocks carry such
    context (up to 1.7 kB, including a full failure diagnosis).
    """
    rows: list[PendingEntry] = []
    for block in blocks:
        inner = block.removeprefix("<!--").removesuffix("-->")
        archived_on = _block_archived_on(block)
        resolution = _block_resolution(block, archived_on)

        nested = parse_entries(inner, status_for="archived", tolerant=True)
        if nested:
            preamble = _block_preamble(inner)
            if preamble:
                nested[0].body = f"{preamble}\n\n{nested[0].body}".strip()
            # Every nested entry gets the block's date and resolution, not just
            # the first — _block_preamble only ever reaches nested[0].
            # Defensive, not corrective: in practice an archived block holds
            # at most one entry. The loop keeps a hand-edited
            # multi-entry block from silently losing its resolution later.
            for entry in nested:
                entry.resolved_at = archived_on
                entry.resolution = resolution
            rows.extend(nested)
            continue

        rows.append(
            PendingEntry(
                title=f"[archived note] resolved {archived_on.isoformat()}",
                body=inner.strip(),
                category="knowledge",
                priority="low",
                status="archived",
                created=archived_on,
                resolved_at=archived_on,
                resolution=resolution,
            )
        )
    return rows


def _block_archived_on(block: str) -> date:
    """The date in an ARCHIVED block header, or the 1970 sentinel when absent."""
    match = ARCHIVED_DATE_RE.search(block)
    return (
        datetime.strptime(match.group(1), "%Y-%m-%d").date()
        if match
        else date(1970, 1, 1)
    )


def _block_resolution(block: str, archived_on: date) -> str:
    """One-line resolution for an ARCHIVED block.

    Prefers the header's parenthetical — "resolved in commit a1b2c3d" — collapsed
    to a single line, since real headers wrap across two or three physical lines.
    Falls back to the bare date rather than None: we know for certain the row was
    deliberately archived, so an empty resolution would understate what we know.
    """
    match = ARCHIVED_PROSE_RE.search(block)
    if match:
        return " ".join(match.group(1).split())
    return f"Archived {archived_on.isoformat()} (no resolution note in source)"


def classify_status(
    created: date, today: date, cutoff_days: int = DEFAULT_CUTOFF_DAYS
) -> str:
    """'archived' when strictly older than cutoff_days, else 'open'."""
    return "archived" if (today - created).days > cutoff_days else "open"


def stamp_age_archive(
    entry: PendingEntry, today: date, cutoff_days: int = DEFAULT_CUTOFF_DAYS
) -> None:
    """Age-classify an open entry, stamping the archive date when it ages out.

    Carries the same `status == "open"` guard main() has always had: an entry
    normalized to 'done' (its status leaked into the Priority field) keeps that
    status and is never stamped.
    """
    if entry.status != "open":
        return
    entry.status = classify_status(entry.created, today, cutoff_days)
    if entry.status == "archived":
        entry.resolved_at = today
        entry.resolution = AGE_ARCHIVE_NOTE.format(
            date=today.isoformat(), days=cutoff_days
        )


def _q(value: str) -> str:
    """Single-quote a SQL string literal, doubling embedded quotes."""
    return "'" + value.replace("'", "''") + "'"


def _q_opt(value: str | None) -> str:
    """`_q` for a nullable column: bare NULL for None, never the string 'None'.

    Quoting None would insert the literal text 'None' — which fails outright in
    a timestamptz column and, worse, succeeds silently in a text one.
    """
    return "NULL" if value is None else _q(value)


def to_sql_values(entries: list[PendingEntry], source: str | None = None) -> str:
    """Render the VALUES tuples for a multi-row INSERT.

    `source` defaults to DEFAULT_FILE for backward-compatible callers (unit
    tests); main() always passes the actual --file path so provenance (and
    the re-run guard, which keys off this column) stays honest when --file
    is used to import something other than the default pending.md.
    """
    host = os.uname().nodename.split(".")[0]
    src = source if source is not None else str(DEFAULT_FILE)
    tuples = [
        "  ("
        + ", ".join(
            [
                _q(e.title),
                _q(e.body),
                _q(e.category),
                _q(e.priority),
                _q(e.status),
                _q(src),
                _q(host),
                _q(e.created.isoformat()),
                _q_opt(e.resolved_at.isoformat() if e.resolved_at else None),
                _q_opt(e.resolution),
            ]
        )
        + ")"
        for e in entries
    ]
    return ",\n".join(tuples)


def build_insert(entries: list[PendingEntry], source: str | None = None) -> str:
    return (
        "INSERT INTO pending "
        "(title, body, category, priority, status, source, origin_host, created_at, "
        "resolved_at, resolution)\n"
        "VALUES\n" + to_sql_values(entries, source) + ";"
    )


REPO_DIR = Path(__file__).resolve().parent.parent


def _read_database_url(path: Path) -> str | None:
    """The DATABASE_URL value in a dotenv file, unquoted, or None."""
    if not path.is_file():
        return None
    for line in path.read_text().splitlines():
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def resolve_connection_string() -> str | None:
    """Resolve the Postgres URL the MCP server would use.

    Mirrors src/db.ts: the DOTENV_CONFIG_PATH file (else a .env) is loaded with
    override, so its DATABASE_URL wins over the environment; the environment's
    DATABASE_URL is the fallback. Without DOTENV_CONFIG_PATH this reads the
    repo's .env, while the server reads the .env in its working directory; the
    two agree when the server runs from the repo root, as `make dev` does. Nothing else is consulted, so
    a managed-database file such as .env.supabase is only used when
    DOTENV_CONFIG_PATH names it.
    """
    dotenv_path = os.environ.get("DOTENV_CONFIG_PATH")
    path = Path(dotenv_path).expanduser() if dotenv_path else REPO_DIR / ".env"
    url = _read_database_url(path)
    if url:
        return url
    return os.environ.get("DATABASE_URL", "").strip() or None


def redact_dsn(dsn: str) -> str:
    """Render `host:port/dbname` for a Postgres DSN, credentials stripped.

    Never print a raw DSN — it carries a password. This is the only form of
    the target that should ever reach stdout/stderr.
    """
    parsed = urllib.parse.urlsplit(dsn)
    host = parsed.hostname or "?"
    db = parsed.path.lstrip("/") or "?"
    return f"{host}:{parsed.port}/{db}" if parsed.port else f"{host}/{db}"


def _explicit_target(args: argparse.Namespace) -> tuple[str | None, str]:
    """Resolve the --apply connection string, requiring an explicit opt-in.

    Returns (connection_string, how). `how` is '' when the operator gave no
    explicit target at all — main() must then refuse to write, since
    auto-resolution alone (walking dotenv files) is exactly the mechanism
    that silently picks the wrong database.

    Two ways to opt in, checked in order. There is deliberately no flag that
    takes a connection string: argv is readable by every user on the host
    (/proc/<pid>/cmdline) and lands in shell history.
      1. DATABASE_URL env var        — explicit by construction
      2. --i-know-the-target         — operator confirms the auto-resolved
         value (resolve_connection_string(), the database the MCP server
         would use) is the one they intend
    """
    env_dsn = os.environ.get("DATABASE_URL", "").strip()
    if env_dsn:
        return env_dsn, "DATABASE_URL env var"
    if args.i_know_the_target:
        return resolve_connection_string(), "--i-know-the-target (auto-resolved)"
    return None, ""


def count_existing_rows(conn: str, source: str, timeout: int = 60) -> int:
    """Count `pending` rows already imported from `source` — the re-run guard.

    All 93 real rows carry source = the pending.md path, and no MCP-added row
    ever will (`addPending` defaults source to `process.cwd()`), so this is a
    reliable discriminator between "already imported" and "never imported".
    """
    query = f"SELECT count(*) FROM pending WHERE source = {_q(source)};"
    argv_dsn, env = psql_env(conn)
    # S603/S607: same constant-argv / PATH-resolved-psql pattern as the
    # insert call below.
    result = subprocess.run(  # noqa: S603
        ["psql", argv_dsn, "-t", "-A", "-c", query],  # noqa: S607
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "psql exited non-zero")
    return int(result.stdout.strip())


def _print_report(
    args: argparse.Namespace, raw: str, blocks: list[str], all_entries: list[PendingEntry]
) -> None:
    """Render the parse-summary lines (counts by status) to stdout."""
    n_open = sum(1 for e in all_entries if e.status == "open")
    n_done = sum(1 for e in all_entries if e.status == "done")
    n_archived = sum(1 for e in all_entries if e.status == "archived")

    print(f"Source:            {args.file} ({len(raw):,} B)")
    print(f"ARCHIVED blocks:   {len(blocks)}")
    print(f"Parsed entries:    {len(all_entries)}")
    print(f"  → open:          {n_open}")
    print(f"  → done:          {n_done}")
    print(f"  → archived:      {n_archived} (cutoff {args.cutoff_days} days)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, default=DEFAULT_FILE)
    parser.add_argument("--cutoff-days", type=int, default=DEFAULT_CUTOFF_DAYS)
    parser.add_argument("--apply", action="store_true", help="Actually write to Postgres")
    parser.add_argument(
        "--i-know-the-target",
        action="store_true",
        dest="i_know_the_target",
        help=(
            "Confirm the auto-resolved database (the one the MCP server would use) is the "
            "intended --apply target. Required only when DATABASE_URL is not set."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Skip the re-run guard and import even if rows from this source already exist",
    )
    args = parser.parse_args()

    if not args.file.exists():
        print(f"No such file: {args.file}", file=sys.stderr)
        return 1

    raw = args.file.read_text(encoding="utf-8")
    open_text, blocks = strip_archived(raw)

    today = date.today()
    open_entries = parse_entries(open_text)
    for entry in open_entries:
        # Only age-classify entries still marked open. An entry normalized to
        # 'done' (status leaked into its Priority field) keeps that status.
        # The guard now lives inside stamp_age_archive.
        stamp_age_archive(entry, today, args.cutoff_days)
    archived_entries = parse_archived_blocks(blocks)

    all_entries = open_entries + archived_entries
    _print_report(args, raw, blocks, all_entries)

    if not args.apply:
        print("\nReport only. Re-run with --apply to write.")
        return 0

    # Critical 1: --apply must never write on the strength of auto-resolution
    # alone. That is exactly what silently sent 93 rows into local Docker
    # while the operator believed they went to Supabase — this worktree has
    # no .env.supabase, only the main checkout does. Refuse unless the
    # operator explicitly opted into a target.
    conn, how = _explicit_target(args)
    if not how:
        auto = resolve_connection_string()
        auto_desc = redact_dsn(auto) if auto else "(could not be resolved either)"
        print("\nRefusing to --apply: no explicit target given.", file=sys.stderr)
        print(f"Auto-resolution would have used: {auto_desc}", file=sys.stderr)
        print(
            "Set DATABASE_URL, or pass "
            "--i-know-the-target to confirm the auto-resolved target above is correct.",
            file=sys.stderr,
        )
        return 1
    if not conn:
        print("Could not resolve DATABASE_URL", file=sys.stderr)
        return 1

    # Never print the raw DSN (it carries a password) — only the redacted
    # host:port/dbname, and always before any write.
    print(f"\nTarget: {redact_dsn(conn)} (via {how})")

    source = str(args.file)

    # Critical 2: no ON_ERROR_STOP-worthy constraint stops a re-run from
    # duplicating every row (fresh gen_random_uuid() each time). Count rows
    # already imported from this exact source and abort unless --force — the
    # same predicate doubles as the rollback handle, so name it in the abort.
    if not args.force:
        try:
            existing = count_existing_rows(conn, source)
        except (RuntimeError, ValueError) as exc:
            print(f"Could not verify prior import: {exc}", file=sys.stderr)
            return 1
        if existing:
            print(
                f"\n{existing} row(s) already imported from {source} (source match).",
                file=sys.stderr,
            )
            print(
                "Re-running would duplicate them. Re-run with --force to import anyway.",
                file=sys.stderr,
            )
            print(
                f"To roll back the prior import: DELETE FROM pending WHERE source = '{source}';",
                file=sys.stderr,
            )
            return 1

    argv_dsn, env = psql_env(conn)
    # S603/S607: constant argv, never shell=True; `psql` resolved from PATH, as
    # elsewhere in scripts/ (see brain_canary.py). Codes sit on the lines ruff
    # reports them on — S603 on the call, S607 on the argv list.
    result = subprocess.run(  # noqa: S603
        ["psql", argv_dsn, "-v", "ON_ERROR_STOP=1", "-c", build_insert(all_entries, source)],  # noqa: S607
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        return 1
    print(f"\nInserted: {result.stdout.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
