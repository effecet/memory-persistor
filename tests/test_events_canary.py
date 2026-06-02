"""Tests for scripts/events_canary.py — freshness logic, parsing, CLI exit codes."""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import events_canary


class TestParseMaxTimestamp:
    """Parse the raw MAX(created_at) output from psql -t -A."""

    def test_parses_iso_with_space_separator(self) -> None:
        ts = events_canary.parse_max_timestamp("2026-04-13 06:00:00+00")
        assert ts == datetime(2026, 4, 13, 6, 0, 0, tzinfo=timezone.utc)

    def test_parses_iso_with_t_separator(self) -> None:
        ts = events_canary.parse_max_timestamp("2026-04-13T06:00:00+00:00")
        assert ts == datetime(2026, 4, 13, 6, 0, 0, tzinfo=timezone.utc)

    def test_naive_timestamp_treated_as_utc(self) -> None:
        ts = events_canary.parse_max_timestamp("2026-04-13 06:00:00")
        assert ts is not None
        assert ts.tzinfo == timezone.utc

    def test_empty_string_returns_none(self) -> None:
        assert events_canary.parse_max_timestamp("") is None

    def test_whitespace_only_returns_none(self) -> None:
        assert events_canary.parse_max_timestamp("   \n  ") is None

    def test_invalid_format_raises(self) -> None:
        with pytest.raises(ValueError):
            events_canary.parse_max_timestamp("not a timestamp")


class TestCheckEventsFreshness:
    """Core freshness logic with a mocked psql runner."""

    NOW = datetime(2026, 4, 13, 12, 0, 0, tzinfo=timezone.utc)

    def _runner(self, response: str):
        def _call(query: str) -> str:
            assert "MAX(created_at)" in query
            assert "events" in query
            return response

        return _call

    def test_fresh_when_event_within_threshold(self) -> None:
        last = self.NOW - timedelta(hours=1)
        result = events_canary.check_events_freshness(
            threshold_hours=24,
            now=self.NOW,
            psql_runner=self._runner(last.isoformat()),
        )
        assert not result.is_stale
        assert not result.is_empty
        assert result.age_hours == pytest.approx(1.0, abs=0.01)

    def test_stale_when_event_past_threshold(self) -> None:
        last = self.NOW - timedelta(hours=48)
        result = events_canary.check_events_freshness(
            threshold_hours=24,
            now=self.NOW,
            psql_runner=self._runner(last.isoformat()),
        )
        assert result.is_stale
        assert not result.is_empty
        assert result.age_hours == pytest.approx(48.0, abs=0.01)

    def test_boundary_exactly_at_threshold_is_fresh(self) -> None:
        """An age == threshold is still considered fresh (> comparison)."""
        last = self.NOW - timedelta(hours=24)
        result = events_canary.check_events_freshness(
            threshold_hours=24,
            now=self.NOW,
            psql_runner=self._runner(last.isoformat()),
        )
        assert not result.is_stale

    def test_empty_table_is_stale_and_empty(self) -> None:
        result = events_canary.check_events_freshness(
            threshold_hours=24,
            now=self.NOW,
            psql_runner=self._runner(""),
        )
        assert result.is_stale
        assert result.is_empty
        assert result.last_event is None
        assert result.age_hours is None

    def test_custom_threshold_respected(self) -> None:
        last = self.NOW - timedelta(hours=2)
        result = events_canary.check_events_freshness(
            threshold_hours=1,
            now=self.NOW,
            psql_runner=self._runner(last.isoformat()),
        )
        assert result.is_stale


class TestRenderText:
    """Human-readable output."""

    NOW = datetime(2026, 4, 13, 12, 0, 0, tzinfo=timezone.utc)

    def test_fresh_render_includes_checkmark(self) -> None:
        result = events_canary.CanaryResult(
            last_event=self.NOW - timedelta(hours=2),
            age_hours=2.0,
            threshold_hours=24,
            is_stale=False,
            is_empty=False,
            now=self.NOW,
        )
        text = result.render_text()
        assert "✅" in text or "fresh" in text
        assert "2.0h" in text

    def test_stale_render_includes_warning(self) -> None:
        result = events_canary.CanaryResult(
            last_event=self.NOW - timedelta(hours=48),
            age_hours=48.0,
            threshold_hours=24,
            is_stale=True,
            is_empty=False,
            now=self.NOW,
        )
        text = result.render_text()
        assert "⚠️" in text or "stale" in text

    def test_empty_render_mentions_empty(self) -> None:
        result = events_canary.CanaryResult(
            last_event=None,
            age_hours=None,
            threshold_hours=24,
            is_stale=True,
            is_empty=True,
            now=self.NOW,
        )
        text = result.render_text()
        assert "empty" in text.lower()


class TestToJson:
    """Structured output."""

    NOW = datetime(2026, 4, 13, 12, 0, 0, tzinfo=timezone.utc)

    def test_json_shape(self) -> None:
        result = events_canary.CanaryResult(
            last_event=self.NOW - timedelta(hours=1),
            age_hours=1.0,
            threshold_hours=24,
            is_stale=False,
            is_empty=False,
            now=self.NOW,
        )
        data = json.loads(result.to_json())
        assert set(data.keys()) == {
            "last_event",
            "age_hours",
            "threshold_hours",
            "is_stale",
            "is_empty",
            "now",
        }
        assert data["is_stale"] is False
        assert data["age_hours"] == 1.0

    def test_json_handles_empty_table(self) -> None:
        result = events_canary.CanaryResult(
            last_event=None,
            age_hours=None,
            threshold_hours=24,
            is_stale=True,
            is_empty=True,
            now=self.NOW,
        )
        data = json.loads(result.to_json())
        assert data["last_event"] is None
        assert data["age_hours"] is None
        assert data["is_empty"] is True


class TestMainCLI:
    """CLI exit codes + arg parsing."""

    NOW = datetime(2026, 4, 13, 12, 0, 0, tzinfo=timezone.utc)

    def _fresh_result(self):
        return events_canary.CanaryResult(
            last_event=self.NOW - timedelta(hours=1),
            age_hours=1.0,
            threshold_hours=24,
            is_stale=False,
            is_empty=False,
            now=self.NOW,
        )

    def _stale_result(self):
        return events_canary.CanaryResult(
            last_event=self.NOW - timedelta(hours=48),
            age_hours=48.0,
            threshold_hours=24,
            is_stale=True,
            is_empty=False,
            now=self.NOW,
        )

    def _empty_result(self):
        return events_canary.CanaryResult(
            last_event=None,
            age_hours=None,
            threshold_hours=24,
            is_stale=True,
            is_empty=True,
            now=self.NOW,
        )

    def test_fresh_exits_zero(self, capsys) -> None:
        with patch.object(
            events_canary, "check_events_freshness", return_value=self._fresh_result()
        ):
            exit_code = events_canary.main([])
        assert exit_code == 0

    def test_stale_exits_one(self, capsys) -> None:
        with patch.object(
            events_canary, "check_events_freshness", return_value=self._stale_result()
        ):
            exit_code = events_canary.main([])
        assert exit_code == 1

    def test_empty_exits_one_by_default(self, capsys) -> None:
        with patch.object(
            events_canary, "check_events_freshness", return_value=self._empty_result()
        ):
            exit_code = events_canary.main([])
        assert exit_code == 1

    def test_empty_with_allow_empty_exits_zero(self, capsys) -> None:
        with patch.object(
            events_canary, "check_events_freshness", return_value=self._empty_result()
        ):
            exit_code = events_canary.main(["--allow-empty"])
        assert exit_code == 0

    def test_db_error_exits_two(self, capsys) -> None:
        with patch.object(
            events_canary,
            "check_events_freshness",
            side_effect=RuntimeError("connection refused"),
        ):
            exit_code = events_canary.main([])
        assert exit_code == 2
        captured = capsys.readouterr()
        assert "connection refused" in captured.err

    def test_json_flag_emits_parseable_json(self, capsys) -> None:
        with patch.object(
            events_canary, "check_events_freshness", return_value=self._fresh_result()
        ):
            events_canary.main(["--json"])
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["is_stale"] is False

    def test_threshold_flag_propagates(self) -> None:
        with patch.object(events_canary, "check_events_freshness") as mock_check:
            mock_check.return_value = self._fresh_result()
            events_canary.main(["--threshold-hours", "6"])
            assert mock_check.call_args.kwargs["threshold_hours"] == 6.0


class TestGetDatabaseUrl:
    """Verify DATABASE_URL resolution order."""

    def test_reads_from_environment_first(self) -> None:
        with patch.dict("os.environ", {"DATABASE_URL": "postgresql://env/x"}):
            assert events_canary.get_database_url() == "postgresql://env/x"

    def test_reads_from_env_supabase(self, tmp_path: Path) -> None:
        (tmp_path / ".env.supabase").write_text(
            'DATABASE_URL="postgresql://supabase/x"\n'
        )
        with patch.dict("os.environ", {}, clear=True):
            with patch.object(events_canary, "PROJECT_DIR", tmp_path):
                assert events_canary.get_database_url() == "postgresql://supabase/x"

    def test_env_supabase_takes_precedence_over_env(self, tmp_path: Path) -> None:
        (tmp_path / ".env.supabase").write_text(
            "DATABASE_URL=postgresql://supabase/x\n"
        )
        (tmp_path / ".env").write_text("DATABASE_URL=postgresql://local/x\n")
        with patch.dict("os.environ", {}, clear=True):
            with patch.object(events_canary, "PROJECT_DIR", tmp_path):
                assert events_canary.get_database_url() == "postgresql://supabase/x"

    def test_raises_when_not_found(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with patch.object(events_canary, "PROJECT_DIR", tmp_path):
                with pytest.raises(RuntimeError, match="DATABASE_URL not found"):
                    events_canary.get_database_url()


class TestIsLocal:
    """_is_local decides whether Docker fallback is legitimate."""

    def test_localhost_is_local(self) -> None:
        assert events_canary._is_local("postgresql://user:pass@localhost:5432/db")

    def test_loopback_ip_is_local(self) -> None:
        assert events_canary._is_local("postgresql://user:pass@127.0.0.1:5432/db")

    def test_supabase_pooler_is_not_local(self) -> None:
        assert not events_canary._is_local(
            "postgresql://postgres:x@aws-0-region.pooler.supabase.com:6543/postgres"
        )


class TestRunPsqlRouting:
    """run_psql must refuse to silently fall back to Docker on a remote URL.

    Regression guard for the bug pattern that caused this canary to exist in
    the first place: silent misroute of DB traffic to local Docker. If psql
    is missing and DATABASE_URL is remote, the canary MUST fail loudly so
    the operator knows the check isn't actually happening.
    """

    REMOTE_URL = (
        "postgresql://postgres:x@aws-0-region.pooler.supabase.com:6543/postgres"
    )
    LOCAL_URL = "postgresql://postgres:pw@localhost:5432/memory_persistor"

    def test_remote_url_without_psql_raises_loudly(self) -> None:
        with patch.dict("os.environ", {"DATABASE_URL": self.REMOTE_URL}, clear=True):
            with patch.object(events_canary.shutil, "which", return_value=None):
                with pytest.raises(RuntimeError, match="remote host but `psql` is not"):
                    events_canary.run_psql("SELECT 1")

    def test_remote_url_with_psql_uses_psql(self) -> None:
        captured: dict[str, list[str]] = {}

        class FakeResult:
            returncode = 0
            stdout = "2026-04-13 06:00:00+00"
            stderr = ""

        def fake_run(argv: list[str], **_kwargs: object) -> FakeResult:
            captured["argv"] = argv
            return FakeResult()

        with patch.dict("os.environ", {"DATABASE_URL": self.REMOTE_URL}, clear=True):
            with patch.object(
                events_canary.shutil, "which", return_value="/usr/bin/psql"
            ):
                with patch.object(events_canary.subprocess, "run", fake_run):
                    events_canary.run_psql("SELECT 1")

        assert captured["argv"][0] == "psql"
        assert captured["argv"][1] == self.REMOTE_URL

    def test_local_url_without_psql_uses_docker(self) -> None:
        captured: dict[str, list[str]] = {}

        class FakeResult:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(argv: list[str], **_kwargs: object) -> FakeResult:
            captured["argv"] = argv
            return FakeResult()

        with patch.dict("os.environ", {"DATABASE_URL": self.LOCAL_URL}, clear=True):
            with patch.object(events_canary.shutil, "which", return_value=None):
                with patch.object(events_canary.subprocess, "run", fake_run):
                    events_canary.run_psql("SELECT 1")

        assert captured["argv"][0] == "docker"
        assert "compose" in captured["argv"]
