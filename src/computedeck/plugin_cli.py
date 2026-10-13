"""``computedeck plugin``: marketplaces, installing plugins, and starting a new one."""

import argparse
import sys
from typing import Any

from . import marketplace as market
from . import paths
from .marketplace import MarketplaceError, plain

# Catalog text is printed through plain(): it cannot move the cursor or add lines.


def _text(value: dict[str, str] | None) -> str:
    return plain((value or {}).get("en") or next(iter((value or {}).values()), ""))


def _confirm(summary: str, assume_yes: bool) -> bool:
    print(summary, flush=True)
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        print("Pass --yes to install without a prompt.", file=sys.stderr)
        return False
    return input("Install? [y/N] ").strip().lower() in ("y", "yes")


def marketplace_command(args: argparse.Namespace) -> int:
    data_dir = paths.data_dir()
    if args.action == "add":
        record = market.add_marketplace(data_dir, args.source)
        plugins = record["catalog"]["plugins"]
        print(plain(f"Added {record['name']} ({record['tier']}): {len(plugins)} plugins."))
    elif args.action == "update":
        names = [args.name] if args.name else list(market.registry(data_dir))
        for name in names:
            record = market.update_marketplace(data_dir, name)
            print(plain(f"Updated {name}: {len(record['catalog']['plugins'])} plugins."))
    elif args.action == "remove":
        market.remove_marketplace(data_dir, args.name)
        print(plain(f"Removed {args.name}. Plugins installed from it stay installed."))
    else:
        markets = market.registry(data_dir)
        problems = market.problems(data_dir)
        if not markets:
            print("No marketplaces. Add one with: computedeck plugin marketplace add SOURCE")
        for record in markets.values():
            count = (
                "unreadable"
                if record["name"] in problems
                else f"{len(record['catalog']['plugins']):>3} plugins"
            )
            print(
                plain(
                    f"{record['name']:<24} {record['tier']:<10} {count:<11}  "
                    f"{market.display_source(record['source'])}"
                )
            )
        _report(problems)
    return 0


def _report(problems: dict[str, str]) -> None:
    for problem in problems.values():
        print(f"computedeck plugin: {plain(problem)}", file=sys.stderr)


def _row(entry: dict[str, Any]) -> str:
    state = (
        "blocked"
        if entry["blocked"]
        else f"installed {entry['installed_version']}"
        if entry["installed_version"]
        else "needs a newer ComputeDeck"
        if not entry["compatible"]
        else ""
    )
    name = f"{entry['name']}@{entry['marketplace']}"
    return plain(f"{name:<36} {entry['version']:<10} {entry['tier']:<10} {state}")


def search(args: argparse.Namespace) -> int:
    _report(market.problems(paths.data_dir()))
    words = [word.lower() for word in args.words]
    rows = [
        entry
        for entry in market.listing(paths.data_dir())
        if all(
            word
            in " ".join(
                [
                    entry["name"],
                    _text(entry["display_name"]),
                    _text(entry["description"]),
                    *(entry["tags"] or []),
                    entry["category"] or "",
                ]
            ).lower()
            for word in words
        )
    ]
    if not rows:
        print("No plugins found.")
    for entry in rows:
        print(_row(entry))
        if entry["description"]:
            print(f"    {_text(entry['description'])}")
    return 0


def info(args: argparse.Namespace) -> int:
    record, entry = market.find(paths.data_dir(), args.plugin)
    print(plain(f"{entry.name} {entry.version}  ({record['name']}, {record['tier']})"))
    for label, value in (
        ("Name", _text(entry.display_name)),
        ("About", _text(entry.description)),
        ("Source", entry.source.type),
        ("Package", entry.source.package or ""),
        ("Needs", f"ComputeDeck {entry.requires}" if entry.requires else ""),
        ("License", entry.license or ""),
        ("Author", entry.author or ""),
        ("Home page", entry.homepage or ""),
    ):
        if value:
            print(f"  {label + ':':<11} {plain(value)}")
    if entry.permissions:
        print("  When on, it will:")
        for item in entry.permissions:
            print(f"    - {_text(item)}")
    print(plain(f"\n  computedeck plugin install {entry.name}@{record['name']}", lines=True))
    return 0


def install(args: argparse.Namespace) -> int:
    record = market.install(
        paths.data_dir(), args.plugin, confirm=lambda summary: _confirm(summary, args.yes)
    )
    print(
        plain(
            f"Installed {record['package']} {record['version']}. Restart ComputeDeck to load "
            "it; tools that start switched off can be turned on in the Toolbox."
        )
    )
    return 0


def uninstall(args: argparse.Namespace) -> int:
    market.uninstall(paths.data_dir(), args.plugin)
    print(plain(f"Uninstalled {args.plugin}. Restart ComputeDeck to unload it."))
    return 0


def installed_list(args: argparse.Namespace) -> int:
    from .plugins import compatibility, discover

    try:
        records = market.installed(paths.data_dir())
    except MarketplaceError as error:
        # Still list what is installed, without where it came from.
        print(f"computedeck plugin: {plain(error)}", file=sys.stderr)
        records = {}
    plugins = discover()
    if not plugins:
        print("No plugins installed.")
    for plugin in plugins:
        origin = next(
            (
                f"{name}@{record['marketplace']}"
                for name, record in records.items()
                if record["package"] == plugin.package
            ),
            "built in" if plugin.package == "computedeck" else "installed directly",
        )
        problem = compatibility(plugin)
        note = f"  not loaded: {problem['code']}" if problem else ""
        print(
            plain(
                f"{plugin.id:<20} {plugin.package or '':<28} {plugin.version or '':<10} "
                f"{origin}{note}"
            )
        )
    return 0


def new(args: argparse.Namespace) -> int:
    from pathlib import Path

    from .scaffold import create

    directory = Path(args.dir or f"computedeck-{args.id}")
    try:
        written = create(directory, args.id, web=args.web, driver=args.driver)
    except ValueError as error:
        raise MarketplaceError(str(error)) from None
    print(f"Created {directory} ({len(written)} files). Next:")
    print(f"  cd {directory} && uv sync && uv run pytest && uv run computedeck plugin validate .")
    return 0


def check(args: argparse.Namespace) -> int:
    from pathlib import Path

    from .scaffold import validate

    report = validate(Path(args.path))
    for error in report.errors:
        print(f"error: {error}")
    for warning in report.warnings:
        print(f"warning: {warning}")
    if not report.errors:
        names = ", ".join(report.plugins) or "drivers only"
        print(f"OK: {names}")
    return 1 if report.errors else 0


def add_parser(commands: Any, run: Any) -> None:
    """Register ``computedeck plugin`` on the main parser; ``run`` wraps each handler."""
    plugin = commands.add_parser("plugin", help="marketplaces and plugins")
    actions = plugin.add_subparsers(dest="plugin_command", required=True)

    markets = actions.add_parser("marketplace", help="add, list, update or remove marketplaces")
    market_actions = markets.add_subparsers(dest="action", required=True)
    add = market_actions.add_parser(
        "add", help="add a catalog: an https URL, a git repository, owner/repo or a folder"
    )
    add.add_argument("source")
    market_actions.add_parser("list", help="list added marketplaces")
    update = market_actions.add_parser("update", help="read catalogs again")
    update.add_argument("name", nargs="?")
    remove = market_actions.add_parser("remove", help="forget a marketplace")
    remove.add_argument("name")
    markets.set_defaults(handler=run(marketplace_command))

    found = actions.add_parser("search", help="search the added marketplaces")
    found.add_argument("words", nargs="*")
    found.set_defaults(handler=run(search))

    details = actions.add_parser("info", help="show a plugin, its source and its permissions")
    details.add_argument("plugin", help="name or name@marketplace")
    details.set_defaults(handler=run(info))

    add_plugin = actions.add_parser("install", help="install a plugin from a marketplace")
    add_plugin.add_argument("plugin", help="name or name@marketplace")
    add_plugin.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    add_plugin.set_defaults(handler=run(install))

    remove_plugin = actions.add_parser("uninstall", help="uninstall a plugin")
    remove_plugin.add_argument("plugin")
    remove_plugin.set_defaults(handler=run(uninstall))

    listed = actions.add_parser("list", help="list installed plugins")
    listed.set_defaults(handler=run(installed_list))

    start = actions.add_parser("new", help="start a plugin package from a template")
    start.add_argument("id", help="plugin id: lowercase letters, digits and dashes")
    start.add_argument("--dir", help="folder to create (default computedeck-<id>)")
    start.add_argument("--web", action="store_true", help="include a web page")
    start.add_argument("--driver", action="store_true", help="include a data-source driver")
    start.set_defaults(handler=run(new))

    lint = actions.add_parser("validate", help="check a plugin project (imports its code)")
    lint.add_argument("path", nargs="?", default=".")
    lint.set_defaults(handler=run(check))


def guarded(handler: Any) -> Any:
    """Print marketplace errors as one line instead of a traceback."""

    def call(args: argparse.Namespace) -> int:
        try:
            return int(handler(args))
        except MarketplaceError as error:
            print(f"computedeck plugin: {plain(error, lines=True)}", file=sys.stderr)
            return 1

    return call
