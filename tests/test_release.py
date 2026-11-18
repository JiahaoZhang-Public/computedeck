import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "release_check", Path(__file__).resolve().parents[1] / "scripts/release_check.py"
)
assert _spec and _spec.loader
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)


@pytest.mark.parametrize(
    "version,stable", [("0.7.0", True), ("0.7.0rc1", False), ("0.7.0a0", False)]
)
def test_release_tag(tmp_path, version, stable):
    (tmp_path / "pyproject.toml").write_text(f'[project]\nversion = "{version}"\n')
    assert _module.release_version(tmp_path, "v" + version, "v") == (version, stable)
    with pytest.raises(ValueError):
        _module.release_version(tmp_path, "v9.0.0", "v")


def test_release_notes_are_the_dated_section(tmp_path):
    (tmp_path / "CHANGELOG.md").write_text(
        "# Changelog\n\n## 0.8.0 (2026-12-01)\n\n- New routes.\n- Fixes.\n\n"
        "## 0.8.0rc1 (2026-11-20)\n\n- Preview.\n\n## 0.7.0 (2026-10-24)\n\n- Older.\n"
    )
    assert _module.release_notes(tmp_path, "0.8.0") == "- New routes.\n- Fixes.\n"
    assert _module.release_notes(tmp_path, "0.8.0rc1") == "- Preview.\n"
    assert _module.release_notes(tmp_path, "0.7.0") == "- Older.\n"


@pytest.mark.parametrize(
    "changelog,message",
    [
        ("## 0.8.0 (unreleased)\n\n- New.\n", "release date"),
        ("## 0.8.0 (Unreleased)\n\n- New.\n", "release date"),
        ("## 0.8.0\n\n- New.\n", "release date"),
        ("## 0.8.0 (2026-12-01)\n\n## 0.7.0 (2026-10-24)\n\n- Older.\n", "is empty"),
        ("# Changelog\n\n## 0.8.0.1 (2026-12-01)\n\n- Other.\n", "no section"),
    ],
)
def test_release_notes_refuse_an_unready_changelog(tmp_path, changelog, message):
    (tmp_path / "CHANGELOG.md").write_text(changelog)
    with pytest.raises(ValueError, match=message):
        _module.release_notes(tmp_path, "0.8.0")
