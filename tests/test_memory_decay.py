"""Tests for scripts/memory-decay.py — decay math, snapshot, pruning."""
import json
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Add scripts dir to path so we can import
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import importlib
memory_decay = importlib.import_module("memory-decay")


class TestDecayMath:
    """Verify thermal decay constants and math."""

    def test_decay_rate_reduces_temperature(self) -> None:
        rate = memory_decay.DECAY_RATE
        assert 0 < rate < 1
        assert rate == 0.85

    def test_decay_threshold_is_24_hours(self) -> None:
        assert memory_decay.DECAY_THRESHOLD_HOURS == 24

    def test_max_snapshots_is_7(self) -> None:
        # Lowered 30->7: Postgres is the real safety net.
        assert memory_decay.MAX_SNAPSHOTS == 7


class TestGetDatabaseUrlTargeting:
    """get_database_url must target the live Supabase brain, honoring DOTENV_CONFIG_PATH."""

    def test_prefers_non_localhost_env(self, monkeypatch) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@cloud:6543/db")
        assert memory_decay.get_database_url() == "postgresql://u:p@cloud:6543/db"

    def test_honors_dotenv_config_path(self, monkeypatch, tmp_path) -> None:
        monkeypatch.delenv("DATABASE_URL", raising=False)
        f = tmp_path / "chosen.env"
        f.write_text("DATABASE_URL=postgresql://u:p@chosen:6543/db\n")
        monkeypatch.setenv("DOTENV_CONFIG_PATH", str(f))
        assert memory_decay.get_database_url() == "postgresql://u:p@chosen:6543/db"

    def test_prefers_supabase_over_local_env_file(self, monkeypatch, tmp_path) -> None:
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("DOTENV_CONFIG_PATH", raising=False)
        (tmp_path / ".env.supabase").write_text("DATABASE_URL=postgresql://u:p@pooler:6543/db\n")
        (tmp_path / ".env").write_text("DATABASE_URL=postgresql://u:p@localhost:5432/db\n")
        monkeypatch.setattr(memory_decay, "PROJECT_DIR", tmp_path)
        assert "pooler" in memory_decay.get_database_url()

    def test_localhost_env_does_not_pin_local(self, monkeypatch, tmp_path) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost:5432/db")
        monkeypatch.delenv("DOTENV_CONFIG_PATH", raising=False)
        (tmp_path / ".env.supabase").write_text("DATABASE_URL=postgresql://u:p@pooler:6543/db\n")
        monkeypatch.setattr(memory_decay, "PROJECT_DIR", tmp_path)
        assert "pooler" in memory_decay.get_database_url()

    def test_decay_converges_to_cold(self) -> None:
        """After enough decays, temperature should approach 0."""
        temp = 1.0
        for _ in range(50):
            temp = max(0.0, temp * memory_decay.DECAY_RATE)
        assert temp < 0.001


class TestGetDatabaseUrl:
    """Verify DATABASE_URL resolution."""

    def test_reads_from_environment(self) -> None:
        with patch.dict("os.environ", {"DATABASE_URL": "postgresql://test:test@cloud-host/test"}):
            url = memory_decay.get_database_url()
            assert url == "postgresql://test:test@cloud-host/test"

    def test_reads_from_env_file(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("DATABASE_URL=postgresql://file:file@localhost/file\n")

        with patch.dict("os.environ", {}, clear=True):
            with patch.object(memory_decay, "PROJECT_DIR", tmp_path):
                url = memory_decay.get_database_url()
                assert url == "postgresql://file:file@localhost/file"

    def test_raises_when_not_found(self, tmp_path: Path) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with patch.object(memory_decay, "PROJECT_DIR", tmp_path):
                with pytest.raises(RuntimeError, match="DATABASE_URL not found"):
                    memory_decay.get_database_url()


class TestPruneSnapshots:
    """Verify snapshot pruning keeps only MAX_SNAPSHOTS."""

    def test_prunes_old_snapshots(self, tmp_path: Path) -> None:
        with patch.object(memory_decay, "BACKUP_DIR", tmp_path):
            # Create 35 entity snapshots and 35 relation snapshots
            for i in range(35):
                (tmp_path / f"entities_2026-03-{i:02d}_1200.json").write_text("[]")
                (tmp_path / f"relations_2026-03-{i:02d}_1200.json").write_text("[]")

            removed = memory_decay.prune_snapshots()

            # MAX_SNAPSHOTS=7: remove 28 entities + 28 relations = 56
            assert removed == 56

            remaining_entities = list(tmp_path.glob("entities_*.json"))
            remaining_relations = list(tmp_path.glob("relations_*.json"))
            assert len(remaining_entities) == 7
            assert len(remaining_relations) == 7

    def test_no_pruning_when_under_limit(self, tmp_path: Path) -> None:
        with patch.object(memory_decay, "BACKUP_DIR", tmp_path):
            for i in range(5):
                (tmp_path / f"entities_2026-03-{i:02d}_1200.json").write_text("[]")
                (tmp_path / f"relations_2026-03-{i:02d}_1200.json").write_text("[]")

            removed = memory_decay.prune_snapshots()
            assert removed == 0


class TestExportSnapshot:
    """Verify JSON snapshot export."""

    def test_creates_backup_files(self, tmp_path: Path) -> None:
        with patch.object(memory_decay, "BACKUP_DIR", tmp_path):
            with patch.object(memory_decay, "run_psql") as mock_psql:
                mock_psql.return_value = '[{"id": "abc", "name": "test"}]'

                entities_file, relations_file = memory_decay.export_snapshot()

                assert entities_file.exists()
                assert relations_file.exists()
                assert entities_file.name.startswith("entities_")
                assert relations_file.name.startswith("relations_")

    def test_handles_empty_result(self, tmp_path: Path) -> None:
        with patch.object(memory_decay, "BACKUP_DIR", tmp_path):
            with patch.object(memory_decay, "run_psql", return_value=""):
                entities_file, relations_file = memory_decay.export_snapshot()

                assert entities_file.read_text() == "[]"
                assert relations_file.read_text() == "[]"
