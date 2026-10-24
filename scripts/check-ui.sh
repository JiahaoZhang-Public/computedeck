#!/bin/bash
# Usage: bash scripts/check-ui.sh [page-regex] [--update-snapshots]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
root=$PWD
work=$(mktemp -d "${TMPDIR:-/tmp}/computedeck-ui.XXXXXX")
service_pid=
ui_complete=false
cleanup() {
  status=$?
  # Bash 3.2 can enter EXIT with status 0 after a fatal nounset expansion.
  if [[ "$status" == 0 && "$ui_complete" != true ]]; then status=1; fi
  if [[ -n "$service_pid" ]]; then
    kill "$service_pid" 2>/dev/null || true
    wait "$service_pid" 2>/dev/null || true
  fi
  rm -rf "$work" || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
filter=
update=
for arg in "$@"; do
  case "$arg" in
    --update-snapshots) update=--update-snapshots=all ;;
    --*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) if [[ -n "$filter" ]]; then echo 'Only one page filter is accepted' >&2; exit 2; fi; filter=$arg ;;
  esac
done
export COMPUTEDECK_DEMO_NOW=2026-01-15T14:00:00Z
export TZ=UTC
# Build only core code, even when the developer normally loads private plugins.
unset COMPUTEDECK_WEB_PLUGINS COMPUTEDECK_TEST_PLUGIN_SLOTS COMPUTEDECK_FALLBACK_TOKENS COMPUTEDECK_HELLO_EXAMPLE
npm --prefix web run build -- --outDir "$work/web"
node web/scripts/check-size.mjs "$work/web"
# Separate builds exercise the older-engine fallback and the actual plugin-new template.
COMPUTEDECK_FALLBACK_TOKENS=1 npm --prefix web run build -- --base /__ui-fallback/ --outDir "$work/fallback"
"$root/.venv/bin/python" - "$work/hello.jsx" <<'PYTHON'
import sys
from pathlib import Path
from computedeck.scaffold import WEB_ENTRY

# No server plugin is needed: example mode keeps the hello page's reads local.
source = WEB_ENTRY.format(id="hello-example", title="Hello example")
source = source.replace("  requires: 'hello-example',\n", "")
Path(sys.argv[1]).write_text(source)
PYTHON
COMPUTEDECK_WEB_PLUGINS="$root/web/e2e/plugins.tsx" \
COMPUTEDECK_HELLO_EXAMPLE="$work/hello.jsx" COMPUTEDECK_TEST_PLUGIN_SLOTS=1 \
  npm --prefix web run build -- --base /__ui-plugins/ --outDir "$work/plugins"
mkdir -p "$work/data"
"$root/.venv/bin/python" scripts/ui-server.py "$work" >"$work/service.log" 2>&1 &
service_pid=$!
if ! "$root/.venv/bin/python" - "$work/url" "$service_pid" <<'PY'
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

url_file = Path(sys.argv[1])
for _ in range(150):
    try:
        os.kill(int(sys.argv[2]), 0)
        if url_file.exists():
            with urllib.request.urlopen(url_file.read_text() + "/api/ping", timeout=1) as reply:
                if reply.status == 200:
                    break
    except ProcessLookupError:
        raise SystemExit("UI service exited before becoming ready") from None
    except (OSError, urllib.error.URLError):
        pass
    time.sleep(0.2)
else:
    raise SystemExit("UI service did not become ready within 30 seconds")
PY
then
  cat "$work/service.log" >&2
  exit 1
fi
export PLAYWRIGHT_BASE_URL
PLAYWRIGHT_BASE_URL=$(cat "$work/url")
cd web
if [[ -z "${CI:-}" && -z "${PLAYWRIGHT_CHANNEL:-}" ]] && ! node --input-type=module -e \
  'import { chromium } from "@playwright/test"; import { existsSync } from "node:fs"; process.exit(existsSync(chromium.executablePath()) ? 0 : 1)'; then
  if [[ "$(uname -s)" == Darwin ]]; then
    export PLAYWRIGHT_CHANNEL=chrome
    echo 'Bundled Chromium not installed — using Google Chrome'
  fi
fi
args=()
if [[ -n "$filter" ]]; then args+=(--grep "$filter"); fi
if [[ -n "$update" ]]; then args+=("$update"); fi
node node_modules/@playwright/test/cli.js test ${args[@]+"${args[@]}"}
ui_complete=true
