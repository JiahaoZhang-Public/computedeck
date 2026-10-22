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
