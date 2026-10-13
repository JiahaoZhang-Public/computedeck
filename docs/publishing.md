# Publishing

Only tag workflows in this repository upload packages. Local development never uploads.
Before creating a tag, complete the publication review of all history, identities, messages,
paths, docs and binary assets. Run the full-history secret scan and inspect GitHub metadata
and old Actions logs. TestPyPI uploads are public too.

The tag must match the Python package version. Build jobs run checks and build both a wheel
and sdist. Download those artifacts and inspect their unpacked contents before approving
`testpypi`. Production `pypi` also requires environment approval and reuses the exact artifacts
that passed TestPyPI. Prereleases stop at TestPyPI. Register Trusted Publishers for both
environments before publishing; no upload tokens are used.

Once public, protect main and release tags, require CI and PR review, enable Issues, secret
scanning, push protection and private vulnerability reporting. Keep the default workflow
token read-only and require approval for external contributions. Activate the supplied
Dependabot example in `.github/dependabot.yml`.

The repository variable `PUBLISHING_ENABLED` starts unset. Leave it unset until the
review checklist, protected environments and Trusted Publishers are configured.
