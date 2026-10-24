"""Exercise the real Bash launcher without browsers, sockets or package downloads."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    ("failure", "status", "arguments"),
    [
        ("build", 37, []),
        ("size", 38, []),
        ("playwright", 39, []),
        ("shell", 1, []),
        ("", 0, []),
        ("", 0, ["jobs|gallery", "--update-snapshots"]),
    ],
)
def test_ui_launcher_exit_cleanup_and_arguments(tmp_path, failure, status, arguments):
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    (root / "web").mkdir()
    (root / ".venv/bin").mkdir(parents=True)
    script = root / "scripts/check-ui.sh"
    shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts/check-ui.sh", script)
    if failure == "shell":
        # A fatal nounset expansion used to let the EXIT trap turn failure into success.
        script.write_text(
            script.read_text().replace(
                "ui_complete=true", 'printf "%s\\n" "$UI_LAUNCHER_UNSET"\nui_complete=true'
            )
        )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    temporary = tmp_path / "temporary"
    temporary.mkdir()

    def executable(path, body):
        path.write_text("#!/bin/bash\n" + body)
        path.chmod(0o755)

    executable(bin_dir / "npm", 'if [[ "$UI_FAILURE" == build ]]; then exit 37; fi\nexit 0\n')
    executable(
        bin_dir / "node",
        """case "$1" in
  web/scripts/check-size.mjs)
    if [[ "$UI_FAILURE" == size ]]; then exit 38; fi ;;
  node_modules/@playwright/test/cli.js)
    printf '%s\\n' "$@" > "$UI_CALLS"
    if [[ "$UI_FAILURE" == playwright ]]; then exit 39; fi ;;
esac
exit 0
""",
    )
    executable(
        root / ".venv/bin/python",
        """if [[ "$1" == - ]]; then
  cat >/dev/null
  printf 'http://127.0.0.1:12345' > "$2"
else
  exec sleep 30
fi
""",
    )
    calls = tmp_path / "playwright-arguments"
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "TMPDIR": str(temporary),
        "CI": "1",
        "UI_FAILURE": failure,
        "UI_CALLS": str(calls),
    }
    env.pop("UI_LAUNCHER_UNSET", None)
    result = subprocess.run(
        ["/bin/bash", str(script), *arguments], env=env, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == status, result.stdout + result.stderr
    assert list(temporary.iterdir()) == []
    if failure in ("build", "size"):
        assert not calls.exists()
    else:
        expected = ["node_modules/@playwright/test/cli.js", "test"]
        if arguments:
            expected.extend(["--grep", "jobs|gallery", "--update-snapshots=all"])
        assert calls.read_text().splitlines() == expected
