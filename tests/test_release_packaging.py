"""Release archives carry browser assets without UI screenshot baselines."""

import io
import os
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

from computedeck import paths


@pytest.mark.parametrize("snapshot_platform", [None, "linux", "darwin"])
def test_build_rejects_sdist_screenshot_baselines(tmp_path, snapshot_platform):
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    (root / "web/dist").mkdir(parents=True)
    (root / "web/dist/index.html").write_text("example browser app")
    (root / "src/computedeck").mkdir(parents=True)
    script = root / "scripts/build.sh"
    shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts/build.sh", script)

    archives = tmp_path / "archives"
    archives.mkdir()
    with tarfile.open(archives / "computedeck-0.0.0.tar.gz", "w:gz") as archive:
        name = "computedeck-0.0.0/src/computedeck/static/index.html"
        if snapshot_platform:
            name = f"computedeck-0.0.0/web/e2e/snapshots/{snapshot_platform}/gallery.png"
        entry = tarfile.TarInfo(name)
        entry.size = 7
        archive.addfile(entry, io.BytesIO(b"example"))
    with zipfile.ZipFile(archives / "computedeck-0.0.0.whl", "w") as archive:
        archive.writestr("computedeck/static/index.html", "example browser app")
        archive.writestr("computedeck-0.0.0.dist-info/licenses/THIRD_PARTY_NOTICES", "example")

    # Exercise the real archive checks without installing packages or building the app.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in {
        "npm": "exit 0",
        "uv": 'mkdir dist\ncp "$TEST_ARCHIVES"/* dist/',
    }.items():
        executable = bin_dir / name
        executable.write_text("#!/bin/bash\nset -eu\n" + body + "\n")
        executable.chmod(0o755)
    result = subprocess.run(
        ["bash", str(script)],
        env={
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "TEST_ARCHIVES": str(archives),
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == (1 if snapshot_platform else 0), result.stdout + result.stderr
    if snapshot_platform:
        assert "contains UI screenshot baselines" in result.stderr


@pytest.mark.parametrize(
    ("location", "metadata", "expected"),
    [
        ("src", True, "web/dist"),
        ("src", False, "src/computedeck/static"),
        ("site-packages", True, "site-packages/computedeck/static"),
    ],
)
def test_source_build_takes_precedence_only_in_a_source_checkout(
    tmp_path, monkeypatch, location, metadata, expected
):
    package = tmp_path / location / "computedeck"
    packaged = package / "static"
    packaged.mkdir(parents=True)
    (packaged / "index.html").write_text("previous packaged build")
    built = tmp_path / "web" / "dist"
    built.mkdir(parents=True)
    (built / "index.html").write_text("current source build")
    if metadata:
        (tmp_path / "pyproject.toml").write_text('[project]\nname = "computedeck"\n')
    monkeypatch.setattr(paths, "__file__", str(package / "paths.py"))
    monkeypatch.delenv("COMPUTEDECK_WEB_DIR", raising=False)
    assert paths.web_dir() == tmp_path / expected


def test_explicit_web_directory_does_not_fall_back_to_bundled_assets(tmp_path, monkeypatch):
    package = tmp_path / "computedeck"
    packaged = package / "static"
    packaged.mkdir(parents=True)
    (packaged / "index.html").write_text("packaged build")
    custom = tmp_path / "custom"
    monkeypatch.setattr(paths, "__file__", str(package / "paths.py"))
    monkeypatch.setenv("COMPUTEDECK_WEB_DIR", str(custom))
    assert paths.web_dir() is None
    custom.mkdir()
    (custom / "index.html").write_text("custom build")
    assert paths.web_dir() == custom
