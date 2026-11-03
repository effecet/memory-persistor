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

        def fake_run(argv: list[str], **kwargs: object) -> FakeResult:
            captured["argv"] = argv
            captured["env"] = kwargs.get("env")
            return FakeResult()

        with patch.dict("os.environ", {"DATABASE_URL": self.REMOTE_URL}, clear=True):
            with patch.object(
                events_canary.shutil, "which", return_value="/usr/bin/psql"
            ):
                with patch.object(events_canary.subprocess, "run", fake_run):
                    events_canary.run_psql("SELECT 1")

        # Routing — psql, not the docker fallback, aimed at the remote host.
        assert captured["argv"][0] == "psql"
        assert captured["argv"][1] == (
            "postgresql://postgres@aws-0-region.pooler.supabase.com:6543/postgres"
        )
        # ...and the password travels in the environment, never in argv, because
        # /proc/<pid>/cmdline is world-readable (an earlier issue, follow-up 1). The
        # userinfo must carry no `:password` segment at all.
        assert ":x@" not in captured["argv"][1]
        assert captured["env"]["PGPASSWORD"] == "x"

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


# ── two-tier freshness (heartbeat vs pipeline) ───────────────────────────────


class TestParseTwoTimestamps:
    def test_both_present(self) -> None:
        p, h = events_canary.parse_two_timestamps(
            "2026-07-14 11:00:00+00~2026-07-14 06:00:00+00"
        )
        assert p is not None and h is not None

    def test_pipe_present_hb_empty(self) -> None:
        p, h = events_canary.parse_two_timestamps("2026-07-14 11:00:00+00~")
        assert p is not None and h is None

    def test_pipe_empty_hb_present(self) -> None:
        p, h = events_canary.parse_two_timestamps("~2026-07-14 06:00:00+00")
        assert p is None and h is not None

    def test_both_empty(self) -> None:
        assert events_canary.parse_two_timestamps("~") == (None, None)

    def test_missing_delimiter_raises(self) -> None:
        with pytest.raises(ValueError):
            events_canary.parse_two_timestamps("2026-07-14 11:00:00+00")


class TestTwoTierVerdict:
    NOW = datetime(2026, 7, 14, 12, 0, 0, tzinfo=timezone.utc)

    def _v(self, pipe_h, hb_h):
        pipe = None if pipe_h is None else self.NOW - timedelta(hours=pipe_h)
        hb = None if hb_h is None else self.NOW - timedelta(hours=hb_h)
        return events_canary.two_tier_verdict(pipe, hb, self.NOW, 24, 72)

    def test_pipe_fresh_is_healthy(self) -> None:
        state, should_alert, _, _ = self._v(pipe_h=1, hb_h=1)
        assert state == "healthy" and not should_alert

    def test_pipe_stale_hb_fresh_is_pipeline_silent_alert(self) -> None:
        state, should_alert, _, _ = self._v(pipe_h=100, hb_h=1)
        assert state == "pipeline_silent" and should_alert

    def test_pipe_stale_hb_stale_is_idle_no_alert(self) -> None:
        state, should_alert, _, _ = self._v(pipe_h=100, hb_h=48)
        assert state == "idle" and not should_alert

    def test_pipe_stale_hb_none_is_idle_no_alert(self) -> None:
        # Distinct branch: pipe stale, NO heartbeats at all → idle, never alert.
        state, should_alert, _, _ = self._v(pipe_h=100, hb_h=None)
        assert state == "idle" and not should_alert

    def test_pipe_none_hb_fresh_is_bootstrap_no_alert(self) -> None:
        state, should_alert, _, _ = self._v(pipe_h=None, hb_h=1)
        assert state == "bootstrap" and not should_alert

    def test_both_none_is_empty(self) -> None:
        state, should_alert, _, _ = self._v(pipe_h=None, hb_h=None)
        assert state == "empty" and should_alert

    def test_pipe_age_exactly_at_threshold_is_healthy(self) -> None:
        # pipe_fresh uses <=, so age == 72h is still fresh. A <=→< regression
        # would flip this to 'idle' — locked here.
        state, should_alert, _, _ = self._v(pipe_h=72, hb_h=1)
        assert state == "healthy" and not should_alert

    def test_hb_age_exactly_at_threshold_is_not_fresh(self) -> None:
        # hb_fresh uses strict <, so hb age == 24h is NOT fresh → no alert even
        # with a stale pipe. A <→<= regression would turn this into a FALSE
        # ALERT — the exact failure mode this whole change exists to prevent.
        state, should_alert, _, _ = self._v(pipe_h=100, hb_h=24)
        assert state == "idle" and not should_alert


class TestCheckEventsTwoTier:
    NOW = datetime(2026, 7, 14, 12, 0, 0, tzinfo=timezone.utc)

    def _runner(self, raw: str):
        def _call(query: str) -> str:
            assert "event_type" in query and "public.events" in query
            return raw

        return _call

    def test_alert_when_active_but_pipeline_silent(self) -> None:
        pipe = (self.NOW - timedelta(hours=100)).isoformat()
        hb = (self.NOW - timedelta(hours=1)).isoformat()
        r = events_canary.check_events_two_tier(
            now=self.NOW, psql_runner=self._runner(f"{pipe}~{hb}")
        )
        assert r.should_alert and r.state == "pipeline_silent"
        assert "STALE" in r.render_detail()

    def test_idle_when_both_quiet(self) -> None:
        pipe = (self.NOW - timedelta(hours=100)).isoformat()
        hb = (self.NOW - timedelta(hours=48)).isoformat()
        r = events_canary.check_events_two_tier(
            now=self.NOW, psql_runner=self._runner(f"{pipe}~{hb}")
        )
        assert not r.should_alert and r.state == "idle"
        assert "idle" in r.render_detail()

    def test_empty_table_alerts_and_renders_empty(self) -> None:
        r = events_canary.check_events_two_tier(
            now=self.NOW, psql_runner=self._runner("~")
        )
        assert r.should_alert and r.state == "empty"
        assert "empty" in r.render_detail()

    def test_bootstrap_when_heartbeats_but_no_pipeline_events(self) -> None:
        hb = (self.NOW - timedelta(hours=1)).isoformat()
        r = events_canary.check_events_two_tier(
            now=self.NOW, psql_runner=self._runner(f"~{hb}")
        )
        assert not r.should_alert and r.state == "bootstrap"
        assert "no pipeline events yet" in r.render_detail()
