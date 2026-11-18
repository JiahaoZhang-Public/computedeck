"""Validate a release tag against the package version and extract its changelog notes."""

import argparse
import re
import tomllib
from pathlib import Path


def release_version(project: Path, tag: str, prefix: str) -> tuple[str, bool]:
    version = tomllib.loads((project / "pyproject.toml").read_text())["project"]["version"]
    if tag != prefix + version:
        raise ValueError("The release tag must match the package version")
    return version, re.fullmatch(r"\d+\.\d+\.\d+", version) is not None


def release_notes(project: Path, version: str) -> str:
    """The body of the CHANGELOG.md section headed `## <version> (<date>)`."""
    lines = (project / "CHANGELOG.md").read_text(encoding="utf-8").splitlines()
    heading = re.compile(rf"## {re.escape(version)}(?: \((?P<when>[^)]*)\))?")
    for start, line in enumerate(lines):
        found = heading.fullmatch(line.strip())
        if found is None:
            continue
        if found["when"] is None or "unreleased" in found["when"].lower():
            raise ValueError(f"Give the CHANGELOG.md section for {version} a release date")
        end = next(
            (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines)
        )
        body = "\n".join(lines[start + 1 : end]).strip()
        if not body:
            raise ValueError(f"The CHANGELOG.md section for {version} is empty")
        return body + "\n"
    raise ValueError(f"CHANGELOG.md has no section for {version}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("tag")
    parser.add_argument("prefix")
    parser.add_argument("--notes", type=Path, help="write the version's changelog section here")
    args = parser.parse_args()
    version, stable = release_version(args.project, args.tag, args.prefix)
    if args.notes is not None:
        args.notes.write_text(release_notes(args.project, version), encoding="utf-8")
    print(f"version={version}")
    print(f"stable={str(stable).lower()}")


if __name__ == "__main__":
    main()
