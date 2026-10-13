"""Source builds and installed wheels select their own browser assets."""

import pytest

from computedeck import paths


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
