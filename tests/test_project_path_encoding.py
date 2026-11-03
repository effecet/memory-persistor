"""Cross-language parity tests for the project-dir path encoder.

The MCP server (TypeScript) and the Python maintenance scripts independently
encode filesystem paths into `~/.claude/projects/<encoded>` directory names.
They MUST agree on the encoding or the file-sync mirror drifts silently: an
encoder that kept dots would write memory markdown to a different directory
than the one Claude Code (and every other tool) reads.

The canonical encoding is: replace every `/` AND `.` in the source path with `-`.

This pins the invariant on the Python side (scripts/memory_dedup.py :: encode)
against the same cases as `src/file-sync.ts :: encodeProjectPath()`, whose TS
tests live in `tests/file-sync.test.ts`.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from memory_dedup import encode  # noqa: E402


def _encode(path: str) -> str:
    """Replicate the canonical encoder for assertion clarity."""
    return path.replace("/", "-").replace(".", "-")


@pytest.mark.parametrize(
    "source,expected",
    [
        ("/Users/jane.doe", "-Users-jane-doe"),
        (
            "/Users/jane.doe/Downloads/memory-persistor",
            "-Users-jane-doe-Downloads-memory-persistor",
        ),
        ("/Users/user.name/project", "-Users-user-name-project"),
        ("/Users/foo/bar", "-Users-foo-bar"),
        ("/", "-"),
        # Negative case: pre-existing dashes in the path must NOT gain extra
        # dashes. Catches a regression where someone "simplifies" the encoder
        # to `.replace(/[\.\-]/g, '-')` and double-encodes existing dashes.
        ("/Users/foo-bar/baz", "-Users-foo-bar-baz"),
        # Consecutive dots collapse to consecutive dashes — rare in practice
        # but pinning the behavior prevents silent drift if someone adds a
        # `collapse-multiple-dashes` step.
        ("/Users/a..b/c", "-Users-a--b-c"),
    ],
)
def test_canonical_encoder_matches_ts(source: str, expected: str) -> None:
    """Same cases as `tests/file-sync.test.ts` — must produce identical output."""
    assert _encode(source) == expected


def test_memory_dedup_uses_canonical_encoder(source: str = "/Users/jane.doe/a.b/c") -> None:
    """scripts/memory_dedup.py :: encode() must produce the dash-normalized form."""
    assert encode(source) == _encode(source)


@pytest.mark.parametrize("source", ["/Users/jane.doe", "/Users/foo-bar/baz", "/Users/a..b/c", "/"])
def test_memory_dedup_encoder_matches_canonical(source: str) -> None:
    assert encode(source) == _encode(source)
