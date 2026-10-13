"""``computedeck plugin new`` and ``validate``: start a plugin package and check it."""

import importlib
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .versions import core_version


def _module(plugin_id: str) -> str:
    return "computedeck_" + plugin_id.replace("-", "_")


def _dependency(value: str) -> str:
    """The pip requirement on computedeck. A pre-release core (0.3.0a0) is named exactly,
    because pip and uv do not let ">=0.3" match a pre-release of 0.3."""
    major, minor = (int(part) for part in re.findall(r"\d+", value)[:2])
    upper = f"<{major}.{minor + 1}" if major == 0 else f"<{major + 1}"
    low = value if re.search(r"[a-z]", value) else f"{major}.{minor}"
    return f">={low},{upper}"


def _release(value: str) -> str:
    major, minor = (int(part) for part in re.findall(r"\d+", value)[:2])
    return (
        f">={major}.{minor},<{major}.{minor + 1}"
        if major == 0
        else f">={major}.{minor},<{major + 1}"
    )


PYPROJECT = """[project]
name = "computedeck-{id}"
version = "0.1.0"
description = "{title}: a ComputeDeck plugin"
requires-python = ">=3.12"
dependencies = ["computedeck{dependency}"]

[project.entry-points."computedeck.plugins"]
{id} = "{module}:plugin"
{driver_entry}
[dependency-groups]
dev = ["pytest>=8", "pytest-asyncio>=0.25", "httpx>=0.28"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/{module}"]
{web_artifacts}
[tool.pytest.ini_options]
asyncio_mode = "auto"

[tool.ruff]
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
"""

PLUGIN = '''"""{title}: a ComputeDeck plugin."""

from pathlib import Path
from typing import Any

from computedeck.sdk import Plugin, PluginContext, SettingField


def setup(ctx: PluginContext) -> None:
    """Called once at startup. Routes live under /api/plugins/{id}."""

    @ctx.router.get("/hello")
    async def hello() -> dict[str, Any]:
        return {{"greeting": ctx.settings()["greeting"]}}

    async def on_failure(event: dict[str, Any]) -> None:
        # Events are delivered in order while the plugin is on; see docs/plugins.md.
        job = event["data"].get("job") or {{}}
        print(f"{{job.get('name')}} failed on {{event['data'].get('source_name')}}")

    ctx.on_event(on_failure, ["job.failed"])
    ctx.health = lambda: {{"ready": True}}


plugin = Plugin(
    id="{id}",
    setup=setup,
    name={{"en": "{title}", "zh-CN": "{title}"}},
    description={{"en": "Describe what this tool does.", "zh-CN": "说明这个工具做什么。"}},
    # Say plainly what switching it on lets it do; people read this before they do.
    permissions=(
        {{"en": "prints failed jobs to the service log", "zh-CN": "把失败的作业写到服务日志"}},
    ),
    settings=(
        SettingField(key="greeting", label={{"en": "Greeting", "zh-CN": "问候语"}}, default="hello"),
    ),
    # Tools that start off are switched on by their owner in the Toolbox.
    default_enabled=False,
    requires="{requires_range}",{web_line}
)
'''

DRIVER = '''"""An example data source: replace collect() with reads from your scheduler or cloud."""

from typing import Any, ClassVar, Literal

from computedeck.sdk import Batch, DriverCheck, DriverInfo, SourceError, now, ssh_alias_field


class ExampleDriver:
    name: ClassVar[str] = "{id}"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={{"en": "{title}", "zh-CN": "{title}"}},
        description={{"en": "What this source reads.", "zh-CN": "这个来源读取什么。"}},
        details={{
            "en": "Read-only queries through an SSH alias on {{where}}.",
            "zh-CN": "通过{{where}}的 SSH 别名只读查询。",
        }},
        fields=[ssh_alias_field()],
        checks=[
            DriverCheck(capability="jobs", command="jobs", label={{"en": "Jobs", "zh-CN": "作业"}})
        ],
        beta=True,
    )

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("ssh_alias"):
            raise SourceError("cluster_connection_required")

    async def collect(self, source: dict[str, Any]) -> Batch:
        # None means "not collected"; never report unknown values as zero.
        return Batch(jobs=[], capabilities=["jobs"], observed_at=now())
'''

TEST = """from computedeck.app import create_app
from fastapi.testclient import TestClient

from {module} import plugin

HEADERS = {{"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}}


def test_the_plugin_answers_once_switched_on(tmp_path, monkeypatch):
    monkeypatch.setenv("COMPUTEDECK_AUTH", "off")
    with TestClient(
        create_app(tmp_path, polling=False, plugins=[plugin]), base_url="http://127.0.0.1"
    ) as client:
        assert client.get("/api/plugins/{id}/hello").status_code == 404
        client.put("/api/toolbox/{id}", json={{"enabled": True}}, headers=HEADERS)
        assert client.get("/api/plugins/{id}/hello").json() == {{"greeting": "hello"}}
"""

WEB_PACKAGE = """{{
  "name": "computedeck-{id}-web",
  "private": true,
  "type": "module",
  "scripts": {{ "build": "vite build" }},
  "devDependencies": {{
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^7.1.0"
  }}
}}
"""

WEB_CONFIG = """import {{ fileURLToPath }} from 'node:url';
import {{ defineConfig }} from 'vite';
import react from '@vitejs/plugin-react';

// One classic script that registers with the page. React comes from the page
// (window.ComputeDeck), so it is not bundled.
export default defineConfig({{
  plugins: [react()],
  define: {{ 'process.env.NODE_ENV': JSON.stringify('production') }},
  build: {{
    lib: {{
      entry: fileURLToPath(new URL('./src/index.jsx', import.meta.url)),
      formats: ['iife'],
      name: 'ComputeDeckPlugin_{module}',
      fileName: () => 'index.js',
      cssFileName: 'index',
    }},
    outDir: fileURLToPath(new URL('../src/{module}/web', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {{
      external: ['react', 'react/jsx-runtime'],
      output: {{
        globals: {{ react: 'ComputeDeck.React', 'react/jsx-runtime': 'ComputeDeck.jsxRuntime' }},
      }},
    }},
  }},
}});
"""

WEB_ENTRY = """import {{ useEffect, useState }} from 'react';

const {{ components, register }} = window.ComputeDeck;
const {{ Panel }} = components;

function Icon() {{
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}}

function Page({{ request }}) {{
  const [greeting, setGreeting] = useState('…');
  useEffect(() => {{
    request('/plugins/{id}/hello').then((data) => setGreeting(data.greeting));
  }}, [request]);
  return (
    <Panel title="{title}">
      <p className="panel-note">{{greeting}}</p>
    </Panel>
  );
}}

register({{
  id: '{id}',
  // Hidden while the server plugin of the same id is switched off.
  requires: '{id}',
  pages: [
    {{
      id: '{id}',
      label: {{ en: '{title}', 'zh-CN': '{title}' }},
      icon: Icon,
      render: (props) => <Page {{...props}} />,
    }},
  ],
}});
"""

README = """# {title}

A ComputeDeck plugin. See ComputeDeck's docs/plugins.md for the plugin API.

```bash
uv sync
uv run pytest
uv run computedeck plugin validate .
```
{web_readme}
Try it in a ComputeDeck checkout or environment:

```bash
uv pip install -e .
computedeck serve   # then switch it on in the Toolbox
```

List it in a marketplace (computedeck-marketplace.json) with a pinned source, for example a
wheel URL and its sha256, so others can run `computedeck plugin install {id}@<marketplace>`.
"""


def create(directory: Path, plugin_id: str, *, web: bool, driver: bool) -> list[Path]:
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,39}", plugin_id):
        raise ValueError("The plugin id is lowercase letters, digits and dashes, e.g. lab-alerts.")
    if directory.exists() and any(directory.iterdir()):
        raise ValueError(f"{directory} is not empty.")
    module = _module(plugin_id)
    title = " ".join(part.capitalize() for part in plugin_id.split("-"))
    requires = _release(core_version())
    values = {
        "id": plugin_id,
        "module": module,
        "title": title,
        "requires": requires,
        "dependency": _dependency(core_version()),
        "requires_range": requires,
        "driver_entry": (
            '\n[project.entry-points."computedeck.drivers"]\n'
            f'{plugin_id} = "{module}.driver:ExampleDriver"\n'
            if driver
            else ""
        ),
        "web_artifacts": 'artifacts = ["src/' + module + '/web"]\n' if web else "",
        "web_line": '\n    web=Path(__file__).parent / "web",' if web else "",
        "web_readme": (
            "\nThe page lives in web/. Build it into the package before building a wheel:\n\n"
            "```bash\nnpm --prefix web install\nnpm --prefix web run build\n```\n"
            if web
            else ""
        ),
    }
    files = {
        "pyproject.toml": PYPROJECT.format(**values),
        "README.md": README.format(**values),
        f"src/{module}/__init__.py": PLUGIN.format(**values),
        "tests/test_plugin.py": TEST.format(**values),
        ".gitignore": "__pycache__/\n.venv/\ndist/\nweb/node_modules/\nsrc/*/web/\n",
    }
    if driver:
        files[f"src/{module}/driver.py"] = DRIVER.format(**values)
    if web:
        files["web/package.json"] = WEB_PACKAGE.format(**values)
        files["web/vite.config.js"] = WEB_CONFIG.format(**values)
        files["web/src/index.jsx"] = WEB_ENTRY.format(**values)
    written = []
    for name, text in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        written.append(path)
    return written


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    plugins: list[str] = field(default_factory=list)


def validate(directory: Path) -> Report:
    """Check a plugin project: its entry points, manifests, settings and declared bundle.

    This imports the project's code, so run it on projects you trust (your own).
    """
    from .plugins import Plugin, PluginContext, Runtime, compatibility, web_bundle

    report = Report()
    pyproject = directory / "pyproject.toml"
    if not pyproject.is_file():
        report.errors.append("No pyproject.toml.")
        return report
    data: dict[str, Any] = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    groups = data.get("project", {}).get("entry-points", {})
    plugins = groups.get("computedeck.plugins", {})
    drivers = groups.get("computedeck.drivers", {})
    if not plugins and not drivers:
        report.errors.append("No computedeck.plugins or computedeck.drivers entry points.")
    deps = " ".join(data.get("project", {}).get("dependencies", []))
    if "computedeck" not in deps:
        report.warnings.append("Add computedeck to the dependencies, with a version range.")
    src = directory / "src"
    sys.path.insert(0, str(src if src.is_dir() else directory))
    try:
        for name, target in plugins.items():
            module, _, attribute = target.partition(":")
            try:
                plugin = getattr(importlib.import_module(module), attribute)
            except Exception as error:
                report.errors.append(f"{name}: cannot import {target}: {error}")
                continue
            if not isinstance(plugin, Plugin):
                report.errors.append(f"{name}: {target} is not a computedeck Plugin.")
                continue
            report.plugins.append(plugin.id)
            problem = compatibility(plugin)
            if problem:
                report.errors.append(f"{name}: {problem}")
            if plugin.id != name:
                report.warnings.append(f"{name}: the entry point name differs from id {plugin.id}.")
            if not (plugin.name or {}).get("en"):
                report.warnings.append(
                    f"{plugin.id}: give it an English name (name={{'en': ...}})."
                )
            if not plugin.requires:
                report.warnings.append(
                    f"{plugin.id}: set requires to the core versions it supports."
                )
            if plugin.web is not None and web_bundle(plugin) is None:
                report.warnings.append(
                    f"{plugin.id}: the web bundle is not built (index.js missing)."
                )
            context = PluginContext(plugin, Runtime(directory))
            try:
                plugin.setup(context)
            except Exception as error:
                report.errors.append(f"{plugin.id}: setup failed: {error}")
                continue
            acts = bool(context.router.routes or context.loops or context.handlers)
            if acts and not plugin.permissions:
                report.warnings.append(
                    f"{plugin.id}: it has routes, loops or event handlers; list what it does "
                    "in permissions so people can decide before switching it on."
                )
        for name, target in drivers.items():
            module, _, attribute = target.partition(":")
            try:
                driver = getattr(importlib.import_module(module), attribute)()
            except Exception as error:
                report.errors.append(f"driver {name}: cannot load {target}: {error}")
                continue
            for required in ("name", "kind", "collect", "validate"):
                if not hasattr(driver, required):
                    report.errors.append(f"driver {name}: missing {required}.")
            if getattr(driver, "kind", None) not in ("cluster", "cloud"):
                report.errors.append(f"driver {name}: kind must be cluster or cloud.")
            if not hasattr(driver, "info"):
                report.warnings.append(
                    f"driver {name}: add info (DriverInfo) for the add-source form."
                )
    finally:
        sys.path.pop(0)
    return report
