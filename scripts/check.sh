#!/bin/bash
# Lint, type-check and test the Python service and the web app.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen mypy src/computedeck scripts
uv run --frozen pytest -q
npm --prefix web run lint
npm --prefix web run format:check
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
