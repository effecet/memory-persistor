"""Both MEMORY.md emitters (src/file-sync.ts and scripts/memory_dedup.py) must
produce byte-identical output.

Whichever emitter runs last wins, so any divergence silently flaps the index
format on the next memory write. The pre-existing slug guards pin naming only;
this pins the emitted index itself.

The golden tests below pass the explicit fallback sentinel (thermal=None
/ null) rather than letting the emitters resolve their own thermal map. The
fixture pg_ids are synthetic, so against a reachable database every entry
would resolve as an orphan at temperature 0 and re-rank the whole index —
the test would pass in CI (no DATABASE_URL) and fail on a dev machine. Pinning
the sentinel also makes these the DB-unreachable parity cases: both
emitters must fall back byte-identically.

NOTE: this guard covers the fixture's cases only. Two known divergences
between the TS and Python frontmatter readers (nested-vs-flat key priority,
quote-run stripping) are deliberately NOT exercised here. A green run here
does not prove the emitters agree in general.
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
FIXTURE = REPO / "tests" / "fixtures" / "index-golden"
EXPECTED = REPO / "tests" / "fixtures" / "index-golden-expected.md"

sys.path.insert(0, str(REPO / "scripts"))
import memory_dedup as md  # noqa: E402


@pytest.fixture
def workdir(tmp_path):
    dest = tmp_path / "memory"
    shutil.copytree(FIXTURE, dest)
    return dest


def test_memory_dedup_matches_golden(workdir, monkeypatch):
    monkeypatch.setattr(md, "MEMDIR", workdir)
    md.regen_index(thermal=None)
    assert (workdir / "MEMORY.md").read_text() == EXPECTED.read_text()


def test_file_sync_ts_matches_golden(workdir):
    """Drive the TS emitter through tsx so both are compared as shipped."""
    script = (
        "import { updateMemoryIndex } from "
        f"'{(REPO / 'src' / 'file-sync.ts').as_posix()}';"
        f"await updateMemoryIndex('{workdir.as_posix()}', null);"
    )
    result = subprocess.run(
        ["node", "--import",
         f"file://{(REPO / 'node_modules' / 'tsx' / 'dist' / 'loader.mjs').as_posix()}",
         "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=REPO, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert (workdir / "MEMORY.md").read_text() == EXPECTED.read_text()


def test_budget_constants_agree():
    ts = (REPO / "src" / "file-sync.ts").read_text()
    assert "export const INDEX_LINE_BUDGET = 170" in ts, "TS budget drifted from Python"
    assert md.INDEX_LINE_BUDGET == 170
    assert md.MAX_ENTRIES_WITH_FOOTER == 167
    assert md.TIER_RANK == {"HOT": 0, "WARM": 1, "COLD": 2}
    assert md.index_footer(5) == "- …and 5 more — use `recall`"
    assert re.search(r"PROTECTED_TYPES(?::[^=]+)? = new Set\(\['user', 'feedback'\]\)", ts), "TS PROTECTED_TYPES drifted from Python"
    assert set(md.PROTECTED_TYPES) == {"user", "feedback"}


# --------------------------------------------------------------------------- #
# Postgres-ranked parity
#
# The frontmatter-ranked golden above cannot catch a ranking regression: it has
# no database dimension, so an emitter that ignored Postgres entirely would
# still pass it. These cases inject a thermal map that DISAGREES with every
# file's frontmatter, so the emitted order can only be right if both
# emitters actually rank on the injected values.
# --------------------------------------------------------------------------- #

THERMAL = REPO / "tests" / "fixtures" / "index-golden-thermal.json"
THERMAL_EXPECTED = REPO / "tests" / "fixtures" / "index-golden-thermal-expected.md"


def _thermal_map() -> dict[str, tuple[str, float]]:
    return {k: (v[0], float(v[1])) for k, v in json.loads(THERMAL.read_text()).items()}


def test_memory_dedup_matches_thermal_golden(workdir, monkeypatch):
    monkeypatch.setattr(md, "MEMDIR", workdir)
    md.regen_index(thermal=_thermal_map())
    assert (workdir / "MEMORY.md").read_text() == THERMAL_EXPECTED.read_text()


def test_file_sync_ts_matches_thermal_golden(workdir):
    """Drive the TS emitter through tsx with the same injected map."""
    script = (
        "import { readFileSync } from 'node:fs';"
        "import { updateMemoryIndex } from "
        f"'{(REPO / 'src' / 'file-sync.ts').as_posix()}';"
        f"const raw = JSON.parse(readFileSync('{THERMAL.as_posix()}', 'utf-8'));"
        "const m = new Map(Object.entries(raw).map("
        "([k, v]) => [k, { tier: v[0], temperature: Number(v[1]) }]));"
        f"await updateMemoryIndex('{workdir.as_posix()}', m);"
    )
    result = subprocess.run(
        ["node", "--import",
         f"file://{(REPO / 'node_modules' / 'tsx' / 'dist' / 'loader.mjs').as_posix()}",
         "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=REPO, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert (workdir / "MEMORY.md").read_text() == THERMAL_EXPECTED.read_text()


def test_thermal_golden_differs_from_frontmatter_golden():
    """The thermal fixture is only meaningful if it actually reorders the index.

    Without this, an emitter that silently ignored the injected map would still
    pass both tests above.
    """
    assert THERMAL_EXPECTED.read_text() != EXPECTED.read_text()
