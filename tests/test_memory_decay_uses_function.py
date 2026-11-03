"""`make decay` must run the versioned decay function, not its own copy.

`scripts/memory-decay.py` carried a hand-written decay UPDATE that predated
`drizzle/0010`: a flat DECAY_RATE with no pattern-awareness, no floor, and
`tier` written from the hardcoded absolute 0.7 / 0.3 thresholds. After percentile tiering
replaced tier assignment with a `cume_dist` window, running `make decay` did
not merely diverge from the nightly pg_cron job — it OVERWROTE rank-assigned
tiers with earlier absolute ones across every row in the stale window.

These guards assert the duplicate cannot come back. They are deliberately
about the *absence* of a second implementation, not about the presence of a
call, because a call plus a leftover UPDATE would still corrupt.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "memory-decay.py"


def _source() -> str:
    """Script source with `#` comments stripped, triple-quoted strings KEPT.

    Stripping `#` lines is what stops a commented-out copy of the old query
    from satisfying the negative assertions below while sitting in the file
    ready to be uncommented.

    Triple-quoted blocks are deliberately NOT stripped, and getting this wrong
    is how the first version of this guard shipped vacuous: every SQL query in
    this script lives in a `\"\"\"...\"\"\"` string, so removing those blocks to
    drop docstrings also removed the exact text the negative assertions hunt
    for. Both of them passed against a file that plainly contained the
    duplicate. A leftover query parked in an unused triple-quoted string is
    caught here too, which is the conservative direction.
    """
    text = SCRIPT.read_text(encoding="utf-8")
    return "\n".join(line.split("#", 1)[0] for line in text.splitlines())


def test_script_exists() -> None:
    assert SCRIPT.exists(), f"{SCRIPT} is missing"


def test_calls_the_versioned_decay_function() -> None:
    assert "public.memory_thermal_decay()" in _source(), (
        "scripts/memory-decay.py must delegate to the versioned function so "
        "`make decay` and the nightly pg_cron job run identical logic"
    )


def test_carries_no_second_decay_implementation() -> None:
    src = _source()
    assert "UPDATE public.entities" not in src, (
        "scripts/memory-decay.py must not write entities directly — that is "
        "the duplicate decay implementation this guard exists to prevent"
    )


def test_carries_no_hardcoded_tier_thresholds() -> None:
    """Tier is assigned by cume_dist over the live distribution since then.

    A literal 0.7 / 0.3 in this file means somebody reintroduced absolute
    thresholds, which is how the earlier tiering got written over the top of
    the new one.
    """
    src = _source()
    for literal in ("0.7", "0.3"):
        assert literal not in src, (
            f"hardcoded tier threshold {literal} found in "
            f"scripts/memory-decay.py; tier thresholds are derived, not literal"
        )


def test_snapshot_and_prune_are_untouched() -> None:
    """Scope guard: this change replaces decay() only.

    export_snapshot() and prune_snapshots() are the script's other two jobs and
    are unrelated to the decay contract. If they disappear, the fix overreached.
    """
    src = _source()
    assert "def export_snapshot(" in src
    assert "def prune_snapshots(" in src
