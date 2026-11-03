"""The Python scripts work from a checkout that has nothing but `scripts/`.

They used to import shared helpers from a sibling config directory that this
repository does not ship. `psql_dsn.py` now lives in `scripts/` and the DSN
resolver is self-contained; these tests keep it that way.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(os.environ.get("MP_SCRIPTS_DIR", Path(__file__).resolve().parent.parent / "scripts"))
PY_SCRIPTS = sorted(p.name for p in SCRIPTS.glob("*.py"))


def test_no_script_reaches_outside_the_repo_for_helpers() -> None:
    offenders = [n for n in PY_SCRIPTS if "claude-config" in (SCRIPTS / n).read_text()]
    assert not offenders, f"scripts referencing a directory this repo does not ship: {offenders}"


@pytest.mark.parametrize("name", PY_SCRIPTS)
def test_script_imports_from_a_scripts_only_copy(name: str, tmp_path: Path) -> None:
    copy = tmp_path / "repo" / "scripts"
    shutil.copytree(SCRIPTS, copy, ignore=shutil.ignore_patterns("__pycache__"))
    probe = (
        "import importlib.util, sys\n"
        f"sys.path.insert(0, {str(copy)!r})\n"
        f"spec = importlib.util.spec_from_file_location('probe', {str(copy / name)!r})\n"
        "mod = importlib.util.module_from_spec(spec)\n"
        "sys.modules['probe'] = mod  # dataclasses look the module up while it executes\n"
        "spec.loader.exec_module(mod)\n"
    )
    env = {k: v for k, v in os.environ.items() if k not in ("DATABASE_URL", "DOTENV_CONFIG_PATH")}
    proc = subprocess.run(
        [sys.executable, "-I", "-c", probe],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr[-800:]
