#!/bin/bash
# Install a built ComputeDeck wheel into a fresh virtualenv and use it as a user would.
#
#   bash scripts/smoke-wheel.sh dist/computedeck-<version>-py3-none-any.whl
#   bash scripts/smoke-wheel.sh dist/computedeck-<version>.tar.gz
#
# Checks the wheel's contents, then installs it outside any checkout, starts the service
# on a free port with a temporary data directory, fetches /api/ping, the web app and one
# of its hashed assets, and runs `computedeck --version`, `doctor` and `export`. It also checks
# that the package description (the README as PyPI shows it) has no relative links.
# Given an sdist, it first builds the wheel from it, as a user's installer would; the sdist
# carries the built web app, so this needs no Node.js.
# Needs uv, curl and unzip. PYTHON selects the interpreter for the virtualenv (default 3.12).
set -euo pipefail

if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: $0 <path to a computedeck wheel or sdist>" >&2
  exit 2
fi
archive="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
work="$(mktemp -d "${TMPDIR:-/tmp}/computedeck-smoke.XXXXXX")"
server=""
cleanup() {
  if [ -n "$server" ]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "smoke: $*" >&2
  if [ -f "$work/serve.log" ]; then
    echo "--- service output" >&2
    cat "$work/serve.log" >&2
  fi
  exit 1
}

case "$archive" in
  *.whl) wheel="$archive" ;;
  *.tar.gz)
    echo "smoke: building a wheel from $(basename "$archive")"
    uv build --quiet --wheel --out-dir "$work/wheel" "$archive"
    wheel="$(echo "$work"/wheel/computedeck-*.whl)"
    [ -f "$wheel" ] || fail "building from the sdist made no wheel"
    ;;
  *) fail "$archive is neither a wheel nor an sdist" ;;
esac

echo "smoke: checking the contents of $(basename "$wheel")"
unzip -Z1 "$wheel" >"$work/contents"
for required in computedeck/__init__.py computedeck/static/index.html; do
  grep -Fx "$required" "$work/contents" >/dev/null || fail "missing $required"
done
for notice in LICENSE NOTICE THIRD_PARTY_NOTICES; do
  grep -E "^computedeck-[^/]+\.dist-info/licenses/$notice$" "$work/contents" >/dev/null ||
    fail "missing license file $notice"
done
grep -E '^computedeck/static/assets/[^/]+-[A-Za-z0-9_-]{8}\.js$' "$work/contents" >/dev/null ||
  fail "no hashed web assets under computedeck/static/assets"
if grep -E '(^|/)(tests?|e2e|snapshots|node_modules|__pycache__|\.vite)(/|$)|\.map$' \
  "$work/contents" >"$work/unexpected"; then
  fail "unexpected files in the wheel: $(tr '\n' ' ' <"$work/unexpected")"
fi

echo "smoke: installing into a fresh virtualenv"
uv venv --quiet --python "${PYTHON:-3.12}" "$work/venv"
uv pip install --quiet --python "$work/venv/bin/python" "$wheel"
bin="$work/venv/bin"
# Run from the empty work directory so no checkout's sources can be imported instead.
cd "$work"
export COMPUTEDECK_DATA_DIR="$work/data"
unset COMPUTEDECK_WEB_DIR COMPUTEDECK_AUTH COMPUTEDECK_PORT

expected="$(basename "$wheel" | cut -d- -f2)"
installed="$("$bin/python" -c 'import importlib.metadata as m; print(m.version("computedeck"))')"
[ "$installed" = "$expected" ] || fail "installed version $installed, expected $expected"
[ "$("$bin/computedeck" --version)" = "computedeck $expected" ] ||
  fail "computedeck --version does not print computedeck $expected"
"$bin/python" - <<'PY' || fail "the package description is not ready for PyPI"
import importlib.metadata
import re
import sys

metadata = importlib.metadata.metadata("computedeck")
text = metadata.get_payload() or metadata.get("Description", "")
if metadata.get("Description-Content-Type") != "text/markdown" or "# ComputeDeck" not in text:
    sys.exit("the description is not the README in Markdown")
# PyPI does not resolve repository-relative paths; every link and image must be absolute.
relative = re.findall(r'\]\((?!https?://|#|mailto:)([^)\s]+)\)|src="(?!https?://)([^"]+)"', text)
if relative:
    sys.exit("relative links in the description: " + ", ".join(a or b for a, b in relative))
PY
"$bin/python" - <<'PY' || fail "the installed package does not serve its bundled web app"
from pathlib import Path

import computedeck
from computedeck import paths

package = Path(computedeck.__file__).parent
assert "site-packages" in package.parts, package
assert paths.web_dir() == package / "static", paths.web_dir()
PY

port="$("$bin/python" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
base="http://127.0.0.1:$port"
echo "smoke: starting computedeck serve on $base"
"$bin/computedeck" serve --port "$port" >"$work/serve.log" 2>&1 &
server=$!
for _ in $(seq 1 60); do
  if curl -fsS "$base/api/ping" >"$work/ping" 2>/dev/null; then
    break
  fi
  kill -0 "$server" 2>/dev/null || fail "the service exited before answering"
  sleep 0.5
done
grep -F '"status":"ok"' "$work/ping" >/dev/null || fail "/api/ping did not answer ok"

curl -fsS "$base/" >"$work/index.html" || fail "/ did not answer"
asset="$(grep -oE '/assets/[^"]+\.js' "$work/index.html" | head -n 1)"
[ -n "$asset" ] || fail "/ did not serve the web app's index.html"
curl -fsS -o /dev/null -w '%{content_type}\n' "$base$asset" >"$work/asset-type" ||
  fail "$asset did not answer"
grep -i javascript "$work/asset-type" >/dev/null || fail "$asset is not served as JavaScript"

echo "smoke: running computedeck doctor and computedeck export"
"$bin/computedeck" doctor --port "$port" >"$work/doctor.log" 2>&1 ||
  fail "computedeck doctor failed: $(cat "$work/doctor.log")"
"$bin/computedeck" export >"$work/export.toml" || fail "computedeck export failed"
"$bin/python" -c 'import sys, tomllib; tomllib.load(open(sys.argv[1], "rb"))' \
  "$work/export.toml" || fail "computedeck export did not print valid TOML"

kill "$server"
wait "$server" 2>/dev/null || true
server=""
echo "smoke: $(basename "$archive") works (version $installed, web asset $asset)"
