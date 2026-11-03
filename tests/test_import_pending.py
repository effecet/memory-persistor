"""Tests for scripts/import_pending.py — the one-shot pending.md → Postgres importer.

The parsing hazard this file exists to pin down: `## [date] title` headers also
appear INSIDE `<!-- ARCHIVED ... -->` comment blocks. A naive regex over the raw
file counts 91 entries when there are only 76 real open ones.
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import import_pending as ip  # noqa: E402

SAMPLE = """\
# Pending Improvements
# ~/.claude/pending.md
#
# Format per entry:
#   ## [YYYY-MM-DD] <title>

## [2026-08-01] Recent open item
**Category:** automation
**Priority:** high
Body of the recent item.

## [2026-01-15] Ancient open item
**Category:** skill
**Priority:** low
Body of the ancient item.

<!-- ARCHIVED 2026-05-04 (resolved):
- some resolution prose

## [2026-05-02] Nested archived entry
**Category:** knowledge
**Priority:** medium
Body of the nested entry.
-->

<!-- ARCHIVED 2026-04-20 (resolved in commit a1b2c3d):
     - note-only block, no entry header
-->
"""


class TestStripArchived:
    def test_removes_archived_blocks_from_the_open_text(self) -> None:
        open_text, _ = ip.strip_archived(SAMPLE)
        assert "Nested archived entry" not in open_text
        assert "note-only block" not in open_text
        assert "Recent open item" in open_text

    def test_returns_every_archived_block(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        assert len(blocks) == 2


class TestParseEntries:
    def test_counts_only_true_open_entries(self) -> None:
        open_text, _ = ip.strip_archived(SAMPLE)
        entries = ip.parse_entries(open_text)
        assert len(entries) == 2
        assert [e.title for e in entries] == ["Recent open item", "Ancient open item"]

    def test_extracts_category_priority_and_body(self) -> None:
        open_text, _ = ip.strip_archived(SAMPLE)
        first = ip.parse_entries(open_text)[0]
        assert first.created == date(2026, 8, 1)
        assert first.category == "automation"
        assert first.priority == "high"
        assert first.body == "Body of the recent item."

    def test_raises_when_category_is_missing(self) -> None:
        # Strict (open-entry) mode. Nested archived entries use tolerant=True
        # and fall back instead — see TestNormalization.
        broken = "## [2026-08-01] No category here\n**Priority:** low\nbody\n"
        with pytest.raises(ValueError, match="category"):
            ip.parse_entries(broken)

    def test_raises_when_priority_is_missing(self) -> None:
        broken = "## [2026-08-01] No priority here\n**Category:** rule\nbody\n"
        with pytest.raises(ValueError, match="priority"):
            ip.parse_entries(broken)

    def test_ignores_the_leading_hash_comment_header(self) -> None:
        entries = ip.parse_entries(SAMPLE.split("## [")[0])
        assert entries == []


class TestParseArchivedBlocks:
    def test_nested_entry_becomes_an_archived_row(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        nested = [r for r in rows if r.title == "Nested archived entry"]
        assert len(nested) == 1
        assert nested[0].status == "archived"
        assert nested[0].category == "knowledge"

    def test_note_only_block_is_preserved_not_dropped(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        assert len(rows) == 2
        note = [r for r in rows if r.title != "Nested archived entry"][0]
        assert note.status == "archived"
        assert "note-only block" in note.body


class TestNormalization:
    """Legacy-data drift seen in hand-maintained pending.md files."""

    def test_slash_joined_category_takes_the_first_token(self) -> None:
        assert ip.normalize_category("rule / automation") == "rule"
        assert ip.normalize_category("rule/automation") == "rule"
        assert ip.normalize_category("knowledge / debugging") == "knowledge"

    def test_clean_category_passes_through_unchanged(self) -> None:
        assert ip.normalize_category("automation") == "automation"

    def test_missing_category_stays_none(self) -> None:
        assert ip.normalize_category(None) is None

    def test_done_in_the_priority_field_becomes_a_status(self) -> None:
        assert ip.normalize_priority("done") == ("medium", "done")

    def test_clean_priority_yields_no_status_override(self) -> None:
        assert ip.normalize_priority("high") == ("high", None)

    def test_open_entry_with_slash_category_parses_strictly(self) -> None:
        text = (
            "## [2026-08-01] Slashy\n"
            "**Category:** rule / automation\n"
            "**Priority:** medium\n"
            "body\n"
        )
        entry = ip.parse_entries(text)[0]
        assert entry.category == "rule"
        assert entry.status == "open"

    def test_open_entry_with_priority_done_lands_as_done(self) -> None:
        text = (
            "## [2026-08-01] Already finished\n"
            "**Category:** automation\n"
            "**Priority:** done\n"
            "body\n"
        )
        entry = ip.parse_entries(text)[0]
        assert entry.status == "done"
        assert entry.priority == "medium"

    def test_tolerant_mode_fills_missing_metadata(self) -> None:
        text = "## [2026-04-22] No metadata at all\nsome resolution prose\n"
        entry = ip.parse_entries(text, status_for="archived", tolerant=True)[0]
        assert entry.category == "knowledge"
        assert entry.priority == "low"
        assert entry.status == "archived"

    def test_strict_mode_still_raises_on_junk_category(self) -> None:
        text = "## [2026-08-01] Junk\n**Category:** banana\n**Priority:** low\nb\n"
        with pytest.raises(ValueError, match="category"):
            ip.parse_entries(text)


class TestClassifyStatus:
    TODAY = date(2026, 8, 7)

    def test_recent_entry_imports_as_open(self) -> None:
        assert ip.classify_status(date(2026, 8, 1), self.TODAY) == "open"

    def test_entry_older_than_the_cutoff_imports_as_archived(self) -> None:
        assert ip.classify_status(date(2026, 1, 15), self.TODAY) == "archived"

    def test_boundary_exactly_at_the_cutoff_stays_open(self) -> None:
        # 90 days before 2026-08-07 is 2026-05-09; "older than 90" is strict.
        assert ip.classify_status(date(2026, 5, 9), self.TODAY) == "open"

    def test_one_day_past_the_cutoff_is_archived(self) -> None:
        assert ip.classify_status(date(2026, 5, 8), self.TODAY) == "archived"

    def test_cutoff_is_configurable(self) -> None:
        assert ip.classify_status(date(2026, 8, 1), self.TODAY, cutoff_days=3) == "archived"


class TestToSqlValues:
    def test_escapes_single_quotes_in_titles_and_bodies(self) -> None:
        entry = ip.PendingEntry(
            title="Don't break on apostrophes",
            body="it's a body",
            category="rule",
            priority="low",
            status="open",
            created=date(2026, 8, 1),
        )
        sql = ip.to_sql_values([entry])
        assert "Don''t break" in sql
        assert "it''s a body" in sql

    def test_emits_one_tuple_per_entry(self) -> None:
        entries = [
            ip.PendingEntry("a", "", "rule", "low", "open", date(2026, 8, 1)),
            ip.PendingEntry("b", "", "skill", "high", "archived", date(2026, 1, 1)),
        ]
        sql = ip.to_sql_values(entries)
        assert sql.count("),\n  (") == 1


class TestArchivedPreamble:
    """Resolution prose between an ARCHIVED header line and its first nested
    entry must survive — parse_entries only sees text AFTER a header, so
    without _block_preamble it is silently dropped. Some real
    blocks carry such prose, the largest 1.7 kB.
    """

    def test_prose_before_the_nested_entry_is_preserved(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        nested = [r for r in rows if r.title == "Nested archived entry"][0]
        assert "some resolution prose" in nested.body

    def test_the_entrys_own_body_is_kept_alongside_the_prose(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        nested = [r for r in rows if r.title == "Nested archived entry"][0]
        assert "Body of the nested entry." in nested.body
        # Prose comes first, then the entry's own body.
        assert nested.body.index("some resolution prose") < nested.body.index(
            "Body of the nested entry."
        )

    def test_the_archived_header_is_kept_verbatim(self) -> None:
        # Deliberately KEPT, not stripped: it records how the item was resolved,
        # and real headers wrap across lines so any line-based strip leaves
        # garbled fragments behind.
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        nested = [r for r in rows if r.title == "Nested archived entry"][0]
        assert "ARCHIVED 2026-05-04" in nested.body

    def test_multi_line_header_is_not_garbled(self) -> None:
        # some real blocks wrap their header parenthetical. A line-based
        # strip left fragments like "generated output files):" as the
        # entire preamble.
        block = (
            "<!-- ARCHIVED 2026-05-04 (resolved in commit d4e5f6a [tools] clean up\n"
            "generated output files):\n"
            "## [2026-05-01] Land the grant\n"
            "**Category:** rule\n"
            "**Priority:** low\n"
            "Real body.\n"
            "-->"
        )
        row = ip.parse_archived_blocks([block])[0]
        assert "resolved in commit d4e5f6a" in row.body
        assert "generated output files" in row.body
        assert row.body.count("generated output files") == 1
        assert "Real body." in row.body

    def test_header_only_block_yields_header_plus_body(self) -> None:
        block = (
            "<!-- ARCHIVED 2026-05-04 (resolved):\n"
            "## [2026-05-02] Straight to the entry\n"
            "**Category:** rule\n"
            "**Priority:** low\n"
            "Just the body.\n"
            "-->"
        )
        rows = ip.parse_archived_blocks([block])
        assert rows[0].body == "ARCHIVED 2026-05-04 (resolved):\n\nJust the body."

    def test_preamble_goes_only_to_the_first_of_two_nested_entries(self) -> None:
        block = (
            "<!-- ARCHIVED 2026-05-04 (resolved):\n"
            "shared context line\n"
            "## [2026-05-02] First entry\n"
            "**Category:** rule\n"
            "**Priority:** low\n"
            "First body.\n"
            "## [2026-05-03] Second entry\n"
            "**Category:** rule\n"
            "**Priority:** low\n"
            "Second body.\n"
            "-->"
        )
        rows = ip.parse_archived_blocks([block])
        assert len(rows) == 2
        assert "shared context line" in rows[0].body
        assert "shared context line" not in rows[1].body

    def test_note_only_block_still_imports_whole(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        note = [r for r in rows if r.title.startswith("[archived note]")][0]
        assert "note-only block" in note.body

    def test_preamble_helper_returns_empty_without_a_nested_entry(self) -> None:
        assert ip._block_preamble(" ARCHIVED 2026-04-20 (resolved):\n prose\n") == ""


class TestDoneStatusSurvivesAgeClassification:
    """main() age-classifies open entries, but must NOT clobber an entry
    normalized to 'done' from a leaked `**Priority:** done`. The guard is
    `if entry.status == "open":` in main().

    These tests drive the REAL main() via argv + a temp file, not a
    reimplementation of the guard — deleting the guard in the script must make
    them fail.
    """

    # Dates are computed relative to today, not hard-coded. main() calls
    # date.today() internally, so a pinned literal would silently drift across
    # the 90-day cutoff and fail this suite on a future date.
    ANCIENT = date.today() - timedelta(days=200)
    RECENT = date.today() - timedelta(days=5)

    @classmethod
    def _entry(cls, when: date, title: str, priority: str) -> str:
        return (
            f"## [{when.isoformat()}] {title}\n"
            f"**Category:** automation\n"
            f"**Priority:** {priority}\n"
            "body\n"
        )

    def _run_main(self, monkeypatch, capsys, tmp_path, text: str) -> str:
        src = tmp_path / "pending.md"
        src.write_text(text)
        monkeypatch.setattr(sys, "argv", ["import_pending.py", "--file", str(src)])
        rc = ip.main()
        assert rc == 0
        return capsys.readouterr().out

    def test_ancient_done_entry_reports_as_done_not_archived(
        self, monkeypatch, capsys, tmp_path
    ) -> None:
        # Dated well past the 90-day cutoff. Without main()'s guard this is
        # reclassified to 'archived' and the done count drops to 0.
        entry = self._entry(self.ANCIENT, "Finished long ago", "done")
        out = self._run_main(monkeypatch, capsys, tmp_path, entry)
        assert "→ done:          1" in out
        assert "→ archived:      0" in out
        assert "→ open:          0" in out

    def test_ancient_normal_entry_still_archives(
        self, monkeypatch, capsys, tmp_path
    ) -> None:
        entry = self._entry(self.ANCIENT, "Just old", "low")
        out = self._run_main(monkeypatch, capsys, tmp_path, entry)
        assert "→ archived:      1" in out
        assert "→ done:          0" in out

    def test_recent_normal_entry_stays_open(
        self, monkeypatch, capsys, tmp_path
    ) -> None:
        recent = self._entry(self.RECENT, "Fresh", "high")
        out = self._run_main(monkeypatch, capsys, tmp_path, recent)
        assert "→ open:          1" in out

    def test_report_only_does_not_write(self, monkeypatch, capsys, tmp_path) -> None:
        entry = self._entry(self.ANCIENT, "Just old", "low")
        out = self._run_main(monkeypatch, capsys, tmp_path, entry)
        assert "Report only" in out
        assert "Inserted" not in out


class _FakeCompleted:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class TestRedactDsn:
    """redact_dsn() is the only form of the target allowed to reach stdout —
    it must never leak the password."""

    def test_strips_credentials_keeps_host_port_db(self) -> None:
        dsn = "postgresql://postgres.abc123:s3cr3t@aws-0-region.pooler.supabase.com:6543/postgres"
        out = ip.redact_dsn(dsn)
        assert out == "aws-0-region.pooler.supabase.com:6543/postgres"
        assert "s3cr3t" not in out
        assert "postgres.abc123" not in out

    def test_handles_dsn_without_explicit_port(self) -> None:
        out = ip.redact_dsn("postgresql://user:pw@dbhost/mydb")
        assert out == "dbhost/mydb"
        assert "pw" not in out


class TestExplicitTargetRequired:
    """Critical 1: --apply must refuse unless the operator explicitly opted
    into a target. Auto-resolution (the walk to .env.supabase / .env) alone
    is exactly the mechanism that silently picked the wrong database."""

    ENTRY = (
        "## [2026-08-01] Target guard probe\n"
        "**Category:** automation\n"
        "**Priority:** low\n"
        "body\n"
    )

    def _src(self, tmp_path) -> Path:
        src = tmp_path / "pending.md"
        src.write_text(self.ENTRY)
        return src

    def test_apply_without_dsn_env_or_confirmation_refuses(
        self, monkeypatch, capsys, tmp_path
    ) -> None:
        src = self._src(tmp_path)
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setattr(
            ip, "resolve_connection_string", lambda: "postgresql://x:y@localhost:5432/memory_persistor"
        )

        def boom(*a, **k):
            raise AssertionError("subprocess.run must not be called on refusal")

        monkeypatch.setattr(ip.subprocess, "run", boom)
        monkeypatch.setattr(sys, "argv", ["import_pending.py", "--file", str(src), "--apply"])

        rc = ip.main()
        err = capsys.readouterr().err
        assert rc == 1
        assert "Refusing to --apply" in err
        assert "no explicit target" in err
        # Names the host it would have used, so the operator sees the mistake.
        assert "localhost:5432/memory_persistor" in err
        assert "DATABASE_URL" in err
        assert "--i-know-the-target" in err
        assert "--dsn" not in err

    def test_dsn_flag_is_not_accepted(self, monkeypatch, tmp_path) -> None:
        """A connection string in argv is readable by every user on the host
        (/proc/<pid>/cmdline) and lands in shell history. The target comes
        from DATABASE_URL or a confirmed auto-resolution, never argv."""
        src = self._src(tmp_path)
        monkeypatch.setattr(
            sys,
            "argv",
            ["import_pending.py", "--file", str(src), "--apply", "--dsn", "postgresql://a:pw@example.com/db"],
        )
        with pytest.raises(SystemExit) as exc:
            ip.main()
        assert exc.value.code == 2

    def test_apply_with_database_url_env_is_explicit(
        self, monkeypatch, capsys, tmp_path
    ) -> None:
        src = self._src(tmp_path)
        monkeypatch.setenv("DATABASE_URL", "postgresql://a@localhost:5432/memory_persistor")

        def fake_run(args, **kwargs):
            sql = args[-1]
            if "SELECT count" in sql:
                return _FakeCompleted(0, "0")
            return _FakeCompleted(0, "INSERT 0 1")

        monkeypatch.setattr(ip.subprocess, "run", fake_run)
        monkeypatch.setattr(sys, "argv", ["import_pending.py", "--file", str(src), "--apply"])

        rc = ip.main()
        out = capsys.readouterr().out
        assert rc == 0
        assert "Target: localhost:5432/memory_persistor (via DATABASE_URL env var)" in out


class TestRerunGuard:
    """Critical 2: re-running --apply must not duplicate rows already
    imported from the same source."""

    ENTRY = (
        "## [2026-08-01] Rerun guard probe\n"
        "**Category:** automation\n"
        "**Priority:** low\n"
        "body\n"
    )

    def _argv(self, src) -> list[str]:
        return [
            "import_pending.py",
            "--file",
            str(src),
            "--apply",
        ]

    @pytest.fixture(autouse=True)
    def _explicit_target(self, monkeypatch) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://a@localhost:5432/memory_persistor")

    def test_existing_rows_abort_without_force(self, monkeypatch, capsys, tmp_path) -> None:
        src = tmp_path / "pending.md"
        src.write_text(self.ENTRY)
        insert_calls = []

        def fake_run(args, **kwargs):
            sql = args[-1]
            if "SELECT count" in sql:
                return _FakeCompleted(0, "93")
            insert_calls.append(args)
            return _FakeCompleted(0, "INSERT 0 1")

        monkeypatch.setattr(ip.subprocess, "run", fake_run)
        monkeypatch.setattr(sys, "argv", self._argv(src))

        rc = ip.main()
        err = capsys.readouterr().err
        assert rc == 1
        assert insert_calls == []  # never reached the INSERT
        assert "93 row(s) already imported" in err
        assert str(src) in err
        assert "--force" in err
        assert f"DELETE FROM pending WHERE source = '{src}'" in err

    def test_zero_existing_rows_proceeds_to_insert(self, monkeypatch, capsys, tmp_path) -> None:
        src = tmp_path / "pending.md"
        src.write_text(self.ENTRY)
        insert_calls = []

        def fake_run(args, **kwargs):
            sql = args[-1]
            if "SELECT count" in sql:
                return _FakeCompleted(0, "0")
            insert_calls.append(args)
            return _FakeCompleted(0, "INSERT 0 1")

        monkeypatch.setattr(ip.subprocess, "run", fake_run)
        monkeypatch.setattr(sys, "argv", self._argv(src))

        rc = ip.main()
        out = capsys.readouterr().out
        assert rc == 0
        assert len(insert_calls) == 1
        assert "Inserted: INSERT 0 1" in out

    def test_force_skips_the_guard_entirely(self, monkeypatch, capsys, tmp_path) -> None:
        src = tmp_path / "pending.md"
        src.write_text(self.ENTRY)
        count_calls = []
        insert_calls = []

        def fake_run(args, **kwargs):
            sql = args[-1]
            if "SELECT count" in sql:
                count_calls.append(args)
                return _FakeCompleted(0, "93")
            insert_calls.append(args)
            return _FakeCompleted(0, "INSERT 0 1")

        monkeypatch.setattr(ip.subprocess, "run", fake_run)
        monkeypatch.setattr(sys, "argv", [*self._argv(src), "--force"])

        rc = ip.main()
        assert rc == 0
        assert count_calls == []  # --force skips the count check outright
        assert len(insert_calls) == 1

    def test_count_query_uses_the_actual_file_arg_not_the_default(
        self, monkeypatch, capsys, tmp_path
    ) -> None:
        """Minor 5: source must be the real --file path, not DEFAULT_FILE,
        or the re-run guard and its rollback handle both lie when --file is
        used to import something other than ~/.claude/pending.md."""
        src = tmp_path / "custom-name.md"
        src.write_text(self.ENTRY)
        seen_sources = []

        def fake_run(args, **kwargs):
            sql = args[-1]
            if "SELECT count" in sql:
                seen_sources.append(sql)
                return _FakeCompleted(0, "0")
            return _FakeCompleted(0, "INSERT 0 1")

        monkeypatch.setattr(ip.subprocess, "run", fake_run)
        monkeypatch.setattr(sys, "argv", self._argv(src))

        ip.main()
        assert any(str(src) in q for q in seen_sources)
        assert not any(str(ip.DEFAULT_FILE) in q for q in seen_sources)

    def test_could_not_verify_prior_import_aborts(self, monkeypatch, capsys, tmp_path) -> None:
        src = tmp_path / "pending.md"
        src.write_text(self.ENTRY)

        def fake_run(args, **kwargs):
            return _FakeCompleted(1, "", "connection refused")

        monkeypatch.setattr(ip.subprocess, "run", fake_run)
        monkeypatch.setattr(sys, "argv", self._argv(src))

        rc = ip.main()
        err = capsys.readouterr().err
        assert rc == 1
        assert "Could not verify prior import" in err


class TestSourceDefaultsInToSqlValues:
    """Minor 5, unit-level: to_sql_values honours an explicit source and
    still falls back to DEFAULT_FILE for older callers that don't pass one."""

    def test_explicit_source_is_used(self) -> None:
        entry = ip.PendingEntry("t", "b", "rule", "low", "open", date(2026, 8, 1))
        sql = ip.to_sql_values([entry], source="/tmp/custom.md")
        assert "/tmp/custom.md" in sql
        assert str(ip.DEFAULT_FILE) not in sql

    def test_missing_source_falls_back_to_default_file(self) -> None:
        entry = ip.PendingEntry("t", "b", "rule", "low", "open", date(2026, 8, 1))
        sql = ip.to_sql_values([entry])
        assert str(ip.DEFAULT_FILE) in sql


class TestArchivedRowsCarryResolvedAtAndResolution:
    """The 2026-08-08 defect: the INSERT had no resolved_at/resolution columns,
    so all 49 archived rows landed with both NULL.

    The header text was never fully lost — _block_preamble keeps it verbatim in
    the FIRST nested entry's body. What was missing is (a) the date as a real
    timestamp and (b) any resolution at all on the 2nd+ entry of a block.
    """

    def test_nested_entry_carries_the_block_date_as_resolved_at(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        nested = [r for r in rows if r.title == "Nested archived entry"][0]
        assert nested.resolved_at == date(2026, 5, 4)

    def test_nested_entry_carries_the_header_prose_as_resolution(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        nested = [r for r in rows if r.title == "Nested archived entry"][0]
        assert nested.resolution is not None
        assert "resolved" in nested.resolution

    def test_second_nested_entry_also_gets_the_resolution(self) -> None:
        """The real gain: _block_preamble only ever reached the FIRST entry, so
        the 2nd+ entries of a block had no resolution context whatsoever."""
        block = (
            "<!-- ARCHIVED 2026-05-04 (resolved in commit abc1234):\n"
            "## [2026-05-02] First entry\n"
            "**Category:** rule\n"
            "**Priority:** low\n"
            "First body.\n"
            "## [2026-05-03] Second entry\n"
            "**Category:** rule\n"
            "**Priority:** low\n"
            "Second body.\n"
            "-->"
        )
        rows = ip.parse_archived_blocks([block])
        assert len(rows) == 2
        for row in rows:
            assert row.resolved_at == date(2026, 5, 4)
            assert "commit abc1234" in row.resolution

    def test_multi_line_header_prose_is_collapsed_to_one_line(self) -> None:
        block = (
            "<!-- ARCHIVED 2026-05-04 (resolved in commit d4e5f6a [tools] clean up\n"
            "generated output files):\n"
            "## [2026-05-01] Land the grant\n"
            "**Category:** rule\n"
            "**Priority:** low\n"
            "Real body.\n"
            "-->"
        )
        row = ip.parse_archived_blocks([block])[0]
        assert "\n" not in row.resolution
        assert "commit d4e5f6a" in row.resolution
        assert "generated output files" in row.resolution

    def test_note_only_block_carries_resolved_at_and_resolution(self) -> None:
        _, blocks = ip.strip_archived(SAMPLE)
        rows = ip.parse_archived_blocks(blocks)
        note = [r for r in rows if r.title.startswith("[archived note]")][0]
        assert note.resolved_at == date(2026, 4, 20)
        assert "commit a1b2c3d" in note.resolution

    def test_header_without_a_parenthetical_still_gets_a_resolution(self) -> None:
        block = (
            "<!-- ARCHIVED 2026-05-28\n"
            "## [2026-05-20] No parenthetical here\n"
            "**Category:** rule\n"
            "**Priority:** low\n"
            "Body.\n"
            "-->"
        )
        row = ip.parse_archived_blocks([block])[0]
        assert row.resolved_at == date(2026, 5, 28)
        assert row.resolution  # a fallback, never None/empty
        assert "2026-05-28" in row.resolution


class TestAgeArchivedEntriesAreStamped:
    """Class A: entries that aged past the cutoff were never resolved. They get
    the import date plus prose that says so in as many words, so nobody later
    reads an age-archive as a completion."""

    def _open(self, created: date) -> ip.PendingEntry:
        return ip.PendingEntry("t", "b", "rule", "low", "open", created)

    def test_age_archived_entry_is_stamped_with_the_import_date(self) -> None:
        today = date(2026, 8, 8)
        entry = self._open(date(2026, 1, 1))
        ip.stamp_age_archive(entry, today, cutoff_days=90)
        assert entry.status == "archived"
        assert entry.resolved_at == today

    def test_age_archived_resolution_says_it_is_not_a_completion(self) -> None:
        today = date(2026, 8, 8)
        entry = self._open(date(2026, 1, 1))
        ip.stamp_age_archive(entry, today, cutoff_days=90)
        assert "NOT a completion" in entry.resolution
        assert "2026-08-08" in entry.resolution

    def test_recent_entry_stays_open_and_unstamped(self) -> None:
        today = date(2026, 8, 8)
        entry = self._open(date(2026, 8, 1))
        ip.stamp_age_archive(entry, today, cutoff_days=90)
        assert entry.status == "open"
        assert entry.resolved_at is None
        assert entry.resolution is None

    def test_done_entry_is_not_age_stamped(self) -> None:
        """Mirrors the existing `if entry.status == "open":` guard in main() —
        a leaked `**Priority:** done` must not be re-classified or stamped."""
        today = date(2026, 8, 8)
        entry = ip.PendingEntry("t", "b", "rule", "low", "done", date(2026, 1, 1))
        ip.stamp_age_archive(entry, today, cutoff_days=90)
        assert entry.status == "done"
        assert entry.resolved_at is None


class TestNullableColumnRendering:
    """resolved_at/resolution are nullable, so the SQL renderer needs a bare
    NULL — quoting None yields the string 'None', which is worse than useless
    in a timestamptz column (it fails) and silently wrong in text."""

    def test_q_opt_renders_bare_null_for_none(self) -> None:
        assert ip._q_opt(None) == "NULL"

    def test_q_opt_quotes_and_escapes_a_value(self) -> None:
        assert ip._q_opt("it's") == "'it''s'"

    def test_open_entry_emits_null_not_the_string_none(self) -> None:
        entry = ip.PendingEntry("t", "b", "rule", "low", "open", date(2026, 8, 1))
        sql = ip.to_sql_values([entry], source="/tmp/x.md")
        assert "NULL" in sql
        assert "'None'" not in sql

    def test_archived_entry_emits_both_values(self) -> None:
        entry = ip.PendingEntry(
            "t", "b", "rule", "low", "archived", date(2026, 1, 1),
            resolved_at=date(2026, 5, 4), resolution="resolved in commit abc1234",
        )
        sql = ip.to_sql_values([entry], source="/tmp/x.md")
        assert "'2026-05-04'" in sql
        assert "'resolved in commit abc1234'" in sql

    def test_insert_column_list_includes_the_new_columns(self) -> None:
        entry = ip.PendingEntry("t", "b", "rule", "low", "open", date(2026, 8, 1))
        stmt = ip.build_insert([entry], source="/tmp/x.md")
        assert "resolved_at" in stmt
        assert "resolution" in stmt


class TestResolveConnectionString:
    """Resolves the database the MCP server would use (src/db.ts): the
    DOTENV_CONFIG_PATH file, else the repo's .env, overrides the environment
    (dotenv `override: true`); DATABASE_URL in the environment is the fallback.
    A repo .env.supabase is never consulted implicitly."""

    @pytest.fixture(autouse=True)
    def _isolate(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("DOTENV_CONFIG_PATH", raising=False)
        monkeypatch.setattr(ip, "REPO_DIR", tmp_path)

    def test_dotenv_config_path_file_overrides_the_environment(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        cfg = tmp_path / "custom.env"
        cfg.write_text('DATABASE_URL="postgresql://u@db.example.com/configured"\n')
        (tmp_path / ".env").write_text("DATABASE_URL=postgresql://localhost/repo_env\n")
        (tmp_path / ".env.supabase").write_text("DATABASE_URL=postgresql://u@managed.example.com/m\n")
        monkeypatch.setenv("DATABASE_URL", "postgresql://u@other.example.com/from_env")
        monkeypatch.setenv("DOTENV_CONFIG_PATH", str(cfg))
        assert ip.resolve_connection_string() == "postgresql://u@db.example.com/configured"

    def test_repo_env_when_dotenv_config_path_is_unset(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        (tmp_path / ".env").write_text("# local\nDATABASE_URL=postgresql://localhost/repo_env\n")
        monkeypatch.setenv("DATABASE_URL", "postgresql://u@other.example.com/from_env")
        assert ip.resolve_connection_string() == "postgresql://localhost/repo_env"

    def test_env_supabase_is_not_consulted(self, tmp_path: Path) -> None:
        (tmp_path / ".env.supabase").write_text("DATABASE_URL=postgresql://u@managed.example.com/m\n")
        assert ip.resolve_connection_string() is None

    def test_environment_is_the_fallback_when_the_file_has_no_url(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        # A repo .env must NOT be used instead: src/db.ts loads only the named file.
        (tmp_path / ".env").write_text("DATABASE_URL=postgresql://localhost/repo_env\n")
        monkeypatch.setenv("DOTENV_CONFIG_PATH", str(tmp_path / "missing.env"))
        monkeypatch.setenv("DATABASE_URL", "postgresql://127.0.0.1/local")
        assert ip.resolve_connection_string() == "postgresql://127.0.0.1/local"

    def test_none_when_nothing_is_configured(self) -> None:
        assert ip.resolve_connection_string() is None
