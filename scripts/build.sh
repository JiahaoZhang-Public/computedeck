#!/bin/bash
# Build a wheel and sdist with the web app bundled into the Python package.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm --prefix web ci
npm --prefix web run build
rm -rf src/computedeck/static
cp -R web/dist src/computedeck/static
rm -rf dist
uv build
for archive in dist/computedeck-*.whl; do
  if ! unzip -Z1 "$archive" | grep -Fx "computedeck/static/index.html" >/dev/null; then
    echo "$archive does not contain the web app" >&2
    exit 1
  fi
  if ! unzip -Z1 "$archive" | grep -E '/licenses/THIRD_PARTY_NOTICES$' >/dev/null; then
    echo "$archive does not contain the bundled dependencies' license notices" >&2
    exit 1
  fi
done
