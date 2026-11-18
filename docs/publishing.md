# Publishing

Only tag workflows in this repository upload packages. Local development never uploads.
Before creating a tag, complete the publication review of all history, identities, messages,
paths, docs and binary assets. Run the full-history secret scan and inspect GitHub metadata
and old Actions logs. Draft releases are private, but a published GitHub release and
TestPyPI uploads are public.

## Check a build locally

```sh
bash scripts/build.sh
bash scripts/smoke-wheel.sh dist/computedeck-*.whl
bash scripts/smoke-wheel.sh dist/computedeck-*.tar.gz
```

`build.sh` builds the web app into the package and writes a wheel and an sdist to `dist/`.
`smoke-wheel.sh` checks a wheel's contents (the web app, hashed assets, `LICENSE`,
`NOTICE` and `THIRD_PARTY_NOTICES`, and no tests, snapshots or source maps), installs it in
a fresh virtual environment outside the checkout, starts `computedeck serve` on a free port
with a temporary data directory, loads `/api/ping`, `/` and one hashed asset, and runs
`computedeck --version`, `computedeck doctor` and `computedeck export`. It also fails if the
package description (the README as PyPI shows it) is not Markdown or still has a relative
link or image. Given the sdist, it first builds the wheel
from it, as an installer would; the sdist carries the built web app, so that needs no
Node.js. `PYTHON=3.13` selects another interpreter. CI runs both checks on every push.

## Refresh the README screenshots

The images under `docs/assets/screens/` come from the built-in example data. After an
interface change, build the web app, start the service and capture them again:

```sh
npm --prefix web run build
uv run computedeck serve
```

```sh
cd web && node scripts/screenshots.mjs http://127.0.0.1:8710
```

Add `<directory> --review` to write every page in light, dark and phone layouts to another
directory instead, for looking over a design change. The script uses Playwright's Chromium
when it is installed and Google Chrome otherwise.

## Release a version

1. Set `version` in `pyproject.toml` and date the version's section in `CHANGELOG.md`
   (`## 0.8.0 (2026-12-01)`). The workflow refuses a section marked `unreleased`, and
   uses the section's text as the release notes.
2. Merge to `main` and wait for CI, including the UI gate.
3. Tag a commit on `main` and push the tag: `git tag v0.8.0 && git push origin v0.8.0`.
   The tag must match the package version.
4. The **Release** workflow (`.github/workflows/release.yml`) checks that the commit is
   on `main`, scans the full history for secrets, runs `scripts/check.sh`, builds the
   wheel and sdist, smoke-tests the wheel on Python 3.12 and 3.13 and the sdist, and
   creates a **draft** GitHub release with both files and the changelog section.
   Versions with a suffix such as `rc1` become prereleases.
5. Download the files from the draft, inspect their unpacked contents, and publish the
   draft by hand. Nothing is public until you do.

To rebuild for an existing tag, delete its draft release and run the workflow from the
Actions tab with that tag. A run never changes a release that already exists.

## PyPI (not enabled yet)

ComputeDeck is not on PyPI, and the workflow does not assume a PyPI project exists. Its
`testpypi` and `pypi` jobs upload with Trusted Publishing (no upload tokens) and run only
when all of these hold:

- the workflow is started by hand from the Actions tab with **publish** set to
  `testpypi`, or to `pypi`, which uploads to TestPyPI first and then the same files to
  PyPI (a tag push never uploads);
- the repository variable `PUBLISHING_ENABLED` is `true`; it starts unset, and a run that
  asks to upload without it fails before building;
- the protected environment `testpypi` or `pypi` approves the job;
- for `pypi`, the version is a final release; prereleases stop at TestPyPI.

To enable it: register a Trusted Publisher for `JiahaoZhang-Public/computedeck`, workflow
`release.yml`, on TestPyPI (environment `testpypi`) and PyPI (environment `pypi`), as a
pending publisher if the project does not exist yet. Create both environments with
required reviewers. Then set `PUBLISHING_ENABLED` to `true`. Run the workflow with
`testpypi` and install from TestPyPI in a clean environment; then run it with `pypi` and
approve `testpypi` and `pypi` in turn. A run uploads only the files it built and
smoke-tested itself.

The package description is `README.md` with its repository-relative links and images
rewritten to absolute URLs pinned to the release tag (`hatch-fancy-pypi-readme` in
`pyproject.toml`), so it renders on PyPI as on GitHub. The images load only once the tag is
pushed and contains them.

## Repository settings

Once public, protect main and release tags, require CI and PR review, enable Issues, secret
scanning, push protection and private vulnerability reporting. Keep the default workflow
token read-only and require approval for external contributions. Activate the supplied
Dependabot example in `.github/dependabot.yml`.

Leave `PUBLISHING_ENABLED` unset until the review checklist, protected environments and
Trusted Publishers are configured.
