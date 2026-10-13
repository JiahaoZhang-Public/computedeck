"""Credential references: resolved on demand, validated strictly, never stored as values."""

import sys
from pathlib import Path

import pytest

from computedeck import credentials
from computedeck.errors import SourceError


def test_env_reference_reads_the_service_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EXAMPLE_API_KEY", "example-value")
    assert credentials.validate_reference("env:EXAMPLE_API_KEY") == "env:EXAMPLE_API_KEY"
    assert credentials.resolve("env:EXAMPLE_API_KEY") == "example-value"
    monkeypatch.setenv("EXAMPLE_API_KEY", "")
    assert credentials.resolve("env:EXAMPLE_API_KEY") is None
    monkeypatch.delenv("EXAMPLE_API_KEY")
    assert credentials.resolve("env:EXAMPLE_API_KEY") is None


@pytest.mark.parametrize(
    "reference",
    [
        "",
        "EXAMPLE_API_KEY",
        "env:",
        "env:1STARTS_WITH_DIGIT",
        "env:NAME;touch /tmp/x",
        "env:NAME\n",
        "env:$(whoami)",
        "ENV:EXAMPLE_API_KEY",
        "file:relative/key",
        "file:/etc/key;rm",
        "keychain:",
        "keychain:no-account",
        "keychain:service/account/extra",
        "keychain:/account",
        "keychain:service/",
    ],
)
def test_invalid_reference_is_rejected(reference: str) -> None:
    with pytest.raises(SourceError) as error:
        credentials.validate_reference(reference)
    assert error.value.message() == {
        "code": "invalid_credential_reference",
        "reference": reference,
    }
    with pytest.raises(SourceError, match="invalid_credential_reference"):
        credentials.resolve(reference)


def test_registered_scheme_resolves_through_its_resolver() -> None:
    seen: list[str] = []

    def resolver(name: str) -> str | None:
        seen.append(name)
        return f"value-for-{name}"

    assert "vault" not in credentials.schemes()
    with pytest.raises(SourceError):
        credentials.validate_reference("vault:team/runpod")
    credentials.register("vault", resolver)
    assert "vault" in credentials.schemes()
    assert credentials.resolve("vault:team/runpod") == "value-for-team/runpod"
    assert seen == ["team/runpod"]
    # The default pattern still rejects spaces and control characters.
    with pytest.raises(SourceError):
        credentials.validate_reference("vault:team runpod")


def test_registered_scheme_pattern_is_enforced() -> None:
    credentials.register("item", lambda name: name, r"[0-9]{4}")
    assert credentials.resolve("item:1234") == "1234"
    for reference in ("item:12345", "item:abcd", "item:12"):
        with pytest.raises(SourceError):
            credentials.validate_reference(reference)


@pytest.mark.parametrize("scheme", ["env", "file", "keychain", "Vault", "1vault", "va:ult", ""])
def test_built_in_or_malformed_schemes_cannot_be_registered(scheme: str) -> None:
    with pytest.raises(ValueError):
        credentials.register(scheme, lambda name: "hijacked")
    assert credentials.schemes() == ["env", "file", "keychain"]


def test_keychain_reference_reads_service_and_account(monkeypatch: pytest.MonkeyPatch) -> None:
    import keyring

    calls: list[tuple[str, str]] = []

    def get_password(service: str, account: str) -> str | None:
        calls.append((service, account))
        return "keychain-value" if account == "runpod" else None

    monkeypatch.setattr(keyring, "get_password", get_password)
    assert credentials.resolve("keychain:computedeck/runpod") == "keychain-value"
    assert credentials.resolve("keychain:computedeck/absent") is None
    assert calls == [("computedeck", "runpod"), ("computedeck", "absent")]


def test_keychain_backend_failure_is_a_source_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import keyring
    from keyring.errors import NoKeyringError

    def get_password(service: str, account: str) -> str | None:
        raise NoKeyringError("No recommended backend was available.")

    monkeypatch.setattr(keyring, "get_password", get_password)
    with pytest.raises(SourceError) as error:
        credentials.resolve("keychain:computedeck/runpod")
    assert error.value.message() == {"code": "keychain_unavailable", "detail": "NoKeyringError"}


def test_missing_keychain_package_is_a_source_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "keyring", None)
    with pytest.raises(SourceError) as error:
        credentials.resolve("keychain:computedeck/runpod")
    assert error.value.message() == {"code": "keychain_unavailable"}


def test_file_reference_reads_only_private_files(tmp_path: Path) -> None:
    key = tmp_path / "key"
    key.write_text("s3cret\n")
    key.chmod(0o600)
    assert credentials.resolve(f"file:{key}") == "s3cret"
    key.chmod(0o640)
    with pytest.raises(SourceError) as error:
        credentials.resolve(f"file:{key}")
    assert error.value.code == "credential_file_open"
    assert credentials.resolve(f"file:{tmp_path}/absent") is None
    with pytest.raises(SourceError):
        credentials.resolve(f"file:{tmp_path}/../key")
