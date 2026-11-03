"""`normalizeHost` (TypeScript) is the host rule every client must reproduce.

Host scoping reduces pending visibility to a string comparison between a stored
host and the current one. The MCP server writes the stored value with
`normalizeHost`; any client that filters by host (a session-start hook, for
example) computes the current one in its own language. If the two spellings
ever diverge, an item stops matching its own machine and becomes SILENTLY
INVISIBLE.

The expected values below are written from the rule itself (lowercase, cut at
the first dot, keep only `[a-z0-9_-]`), not computed by the implementation, so
the table is the reference a client implementation can be checked against.
The real TypeScript function is run on every fixture.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent

#: Every shape a real hostname can take, plus the ones that would break a
#: naive comparison: domain suffixes, case, spaces, punctuation.
EXPECTED = {
    "Laptop-A": "laptop-a",
    "Laptop-A.local": "laptop-a",
    "server-b": "server-b",
    "SERVER-B": "server-b",
    "server-b.lan": "server-b",
    "host.with.many.dots": "host",
    "ALLCAPS": "allcaps",
    "already-lower": "already-lower",
    "": "",
    "LAPTOP A": "laptopa",
    "Jane's MacBook Pro": "janesmacbookpro",
    "host_with_underscores": "host_with_underscores",
    "weird!@#chars": "weirdchars",
    "...": "",
}

INJECTION = ["a'; DROP TABLE pending; --", 'x" OR 1=1', "back\\slash"]


def _run_ts(hosts: list[str]) -> list[str]:
    if shutil.which("node") is None:
        pytest.skip("node not available")
    loader = REPO / "node_modules" / "tsx" / "dist" / "loader.mjs"
    if not loader.exists():
        pytest.skip("tsx not installed (npm ci not run)")
    script = (
        "import { normalizeHost } from './src/pending.ts';"
        f"const xs = {json.dumps(hosts)};"
        "console.log(JSON.stringify(xs.map(normalizeHost)));"
    )
    proc = subprocess.run(
        ["node", "--import", loader.as_uri(), "--input-type=module", "-e", script],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        pytest.fail(f"tsx run failed: {proc.stderr[-800:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


@pytest.fixture(scope="module")
def ts_results() -> dict[str, str]:
    hosts = [*EXPECTED, *EXPECTED.values(), *INJECTION]
    return dict(zip(hosts, _run_ts(hosts), strict=True))


def test_ts_rule_matches_the_reference_table(ts_results: dict[str, str]) -> None:
    mismatches = {h: (ts_results[h], want) for h, want in EXPECTED.items() if ts_results[h] != want}
    assert not mismatches, "normalizeHost diverged from the reference table:\n" + "\n".join(
        f"  {h!r}: got {got!r}, want {want!r}" for h, (got, want) in mismatches.items()
    )


def test_ts_rule_is_idempotent(ts_results: dict[str, str]) -> None:
    """Normalizing an already-normalized value is a no-op, or a value could
    drift each time it round-trips through a write."""
    for normalized in EXPECTED.values():
        assert ts_results[normalized] == normalized


def test_ts_output_is_sql_literal_safe(ts_results: dict[str, str]) -> None:
    """Clients embed the value in a single-quoted SQL literal, so the alphabet
    itself is the injection defence, not escaping applied downstream."""
    for raw in [*EXPECTED, *INJECTION]:
        assert re.fullmatch(r"[a-z0-9_-]*", ts_results[raw]), raw
