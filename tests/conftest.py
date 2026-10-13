"""Shared fixtures. Every test runs against fictional data and an isolated home directory."""

import os
from collections.abc import Callable, Iterator
from functools import partial, partialmethod
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from computedeck import credentials
from computedeck.drivers import ssh
from computedeck.records import SourceInput, source_record
from computedeck.store import Store, now


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep the real ~/.ssh, keychain schemes and SSH locks out of every test."""
    # Exercise the same Host allowlist as a real loopback client.
    monkeypatch.setattr(
        TestClient, "__init__", partialmethod(TestClient.__init__, base_url="http://127.0.0.1")
    )
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.delenv("COMPUTEDECK_PORT", raising=False)
    # Most tests exercise behaviour behind the token check; test_auth.py turns it on.
    monkeypatch.setenv("COMPUTEDECK_AUTH", "off")
    # platformdirs reads $HOME directly; never fall back to the real data directory.
    monkeypatch.setenv("COMPUTEDECK_DATA_DIR", str(tmp_path / "default-data"))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(credentials, "_RESOLVERS", dict(credentials._RESOLVERS))
    # Locks bind to the event loop that first waits on them; each test has its own loop.
    monkeypatch.setattr(ssh, "_LOCKS", {})
    return home


@pytest.fixture(autouse=True)
def restore_umask() -> Iterator[None]:
    """The command line sets a private umask for its process; keep it out of other tests."""
    mask = os.umask(0o022)
    os.umask(mask)
    yield
    os.umask(mask)


@pytest.fixture
def store(tmp_path: Path) -> Iterator[Store]:
    value = Store(tmp_path / "computedeck.sqlite")
    yield value
    value.db.close()


def make_source(
    store: Store,
    name: str = "Cluster A",
    username: str = "alice",
    driver: str = "slurm",
    *,
    fresh: bool = True,
    **changes: Any,
) -> dict[str, Any]:
    """Save a source built exactly as the API builds it, optionally freshly collected."""
    body = SourceInput(
        name=name,
        driver=driver,
        username=username if driver == "slurm" else None,
        ssh_alias=name.lower().replace(" ", "-") if driver == "slurm" else None,
        credential="env:RUNPOD_API_KEY" if driver == "runpod" else None,
    )
    source = source_record(body)
    if fresh:
        source.update(
            last_success=now(),
            status="ready",
            capabilities=["jobs"] if driver == "slurm" else ["instances"],
        )
    source.update(changes)
    store.save_source(source)
    result = store.source(source["id"])
    assert result is not None
    return result


AddSource = Callable[..., dict[str, Any]]


@pytest.fixture
def add_source(store: Store) -> AddSource:
    return partial(make_source, store)
