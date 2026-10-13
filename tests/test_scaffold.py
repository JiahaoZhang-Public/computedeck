"""``computedeck plugin new`` makes a working plugin; ``validate`` reports what is wrong."""

import importlib
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import cli, scaffold

HEADERS = {"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}


def test_a_new_plugin_validates_and_runs(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    project = tmp_path / "scaffold-check"
    assert (
        cli.main(["plugin", "new", "scaffold-check", "--driver", "--web", "--dir", str(project)])
        == 0
    )
    assert (project / "src/computedeck_scaffold_check/driver.py").is_file()
    assert (project / "web/vite.config.js").is_file()
    report = scaffold.validate(project)
    assert report.errors == [] and report.plugins == ["scaffold-check"]
    # Only the unbuilt page is noted.
    assert [warning for warning in report.warnings if "web bundle" not in warning] == []
    assert cli.main(["plugin", "validate", str(project)]) == 0
    assert "OK: scaffold-check" in capsys.readouterr().out
    sys.path.insert(0, str(project / "src"))
    try:
        plugin = importlib.import_module("computedeck_scaffold_check").plugin
        driver = importlib.import_module("computedeck_scaffold_check.driver").ExampleDriver()
    finally:
        sys.path.pop(0)
    assert driver.info.beta is True
    with TestClient(api.create_app(tmp_path / "data", polling=False, plugins=[plugin])) as client:
        assert client.get("/api/plugins/scaffold-check/hello").status_code == 404
        client.put("/api/toolbox/scaffold-check", json={"enabled": True}, headers=HEADERS)
        assert client.get("/api/plugins/scaffold-check/hello").json() == {"greeting": "hello"}


def test_the_dependency_admits_a_pre_release_core() -> None:
    assert scaffold._dependency("0.3.0a0") == ">=0.3.0a0,<0.4"
    assert scaffold._dependency("0.3.2") == ">=0.3,<0.4"
    assert scaffold._dependency("1.4.0") == ">=1.4,<2"


def test_new_refuses_bad_ids_and_full_folders(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        scaffold.create(tmp_path / "a", "Bad_Id", web=False, driver=False)
    (tmp_path / "full").mkdir()
    (tmp_path / "full" / "keep.txt").write_text("x")
    with pytest.raises(ValueError, match="not empty"):
        scaffold.create(tmp_path / "full", "fine-id", web=False, driver=False)


def test_validate_reports_problems(tmp_path: Path) -> None:
    assert scaffold.validate(tmp_path).errors == ["No pyproject.toml."]
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\n')
    assert "No computedeck.plugins" in scaffold.validate(tmp_path).errors[0]
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "x"\n[project.entry-points."computedeck.plugins"]\n'
        'broken = "no_such_module_here:plugin"\n'
    )
    assert "cannot import" in scaffold.validate(tmp_path).errors[0]


def test_generated_test_runs_without_core_test_fixtures(tmp_path: Path) -> None:
    project = tmp_path / "standalone"
    scaffold.create(project, "standalone-example", web=False, driver=False)
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "tests", "-q"],
        cwd=project,
        env={**os.environ, "PYTHONPATH": str(project / "src")},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
