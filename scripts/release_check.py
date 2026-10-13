"""Validate a release tag against the package version."""

import argparse
import re
import tomllib
from pathlib import Path


def release_version(project: Path, tag: str, prefix: str) -> tuple[str, bool]:
    version = tomllib.loads((project / "pyproject.toml").read_text())["project"]["version"]
    if tag != prefix + version:
        raise ValueError("The release tag must match the package version")
    return version, re.fullmatch(r"\d+\.\d+\.\d+", version) is not None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("tag")
    parser.add_argument("prefix")
    args = parser.parse_args()
    version, stable = release_version(args.project, args.tag, args.prefix)
    print(f"version={version}")
    print(f"stable={str(stable).lower()}")


if __name__ == "__main__":
    main()
