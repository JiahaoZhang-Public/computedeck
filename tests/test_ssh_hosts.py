"""Discovery of Host aliases in the user's own OpenSSH configuration."""

import os
import time
from pathlib import Path
from typing import Any

import pytest

from computedeck import ssh_hosts


@pytest.fixture
def ssh_dir(tmp_path: Path) -> Path:
    path = tmp_path / "home" / ".ssh"
    path.mkdir(parents=True, exist_ok=True)
    return path


def hosts(ssh_dir: Path, text: str | None = None) -> dict[str, dict[str, Any]]:
    if text is not None:
        (ssh_dir / "config").write_text(text)
    result = ssh_hosts.discover(ssh_dir)
    assert result["readable"]
    return {host.pop("alias"): host for host in result["hosts"]}


def test_concrete_hosts_with_their_name_user_and_jump(ssh_dir: Path) -> None:
    found = hosts(
        ssh_dir,
        """
# Host commented-out
Host cluster-a cluster-a-login
    HostName login.cluster-a.example.org
    User alice
    ProxyJump campus-bastion
    IdentityFile ~/.ssh/id_cluster
    Port 2222

Host campus-bastion
    HostName bastion.example.org
    ProxyJump none

Host *.example.org gpu-* !secret ?x lab-? *
    User nobody
""",
    )
    assert found == {
        "campus-bastion": {"hostname": "bastion.example.org", "user": None, "proxy_jump": None},
        "cluster-a": {
            "hostname": "login.cluster-a.example.org",
            "user": "alice",
            "proxy_jump": "campus-bastion",
        },
        "cluster-a-login": {
            "hostname": "login.cluster-a.example.org",
            "user": "alice",
            "proxy_jump": "campus-bastion",
        },
    }


def test_keywords_ignore_case_and_take_equals_and_quotes(ssh_dir: Path) -> None:
    found = hosts(
        ssh_dir,
        'HOST=one\n  hostname = "192.0.2.1"\n  USER=alice # trailing comment\n'
        '\tHost "two" \n\tProxyJump="campus-bastion"\n'
        "Host three\n  HostName 'quoted host'\n"
        'Host four\n  HostName "unclosed\n  User bob\n',
    )
    assert found == {
        "four": {"hostname": None, "user": "bob", "proxy_jump": None},
        "one": {"hostname": "192.0.2.1", "user": "alice", "proxy_jump": None},
        "three": {"hostname": "quoted host", "user": None, "proxy_jump": None},
        "two": {"hostname": None, "user": None, "proxy_jump": "campus-bastion"},
    }


def test_the_first_value_wins_across_blocks(ssh_dir: Path) -> None:
    found = hosts(
        ssh_dir,
        "Host gpu-box\n  User alice\nHost gpu-box other\n  User bob\n  HostName 192.0.2.40\n"
        "Host gpu-box\n  HostName 192.0.2.99\n",
    )
    assert found["gpu-box"] == {"hostname": "192.0.2.40", "user": "alice", "proxy_jump": None}
    assert found["other"]["user"] == "bob"


def test_options_of_match_blocks_belong_to_no_host(ssh_dir: Path) -> None:
    found = hosts(
        ssh_dir,
        "Host cluster-a\n  User alice\n"
        'Match host cluster-a exec "true"\n  HostName 192.0.2.66\n  User mallory\n'
        "Host cluster-b\n  HostName 192.0.2.11\n",
    )
    assert found == {
        "cluster-a": {"hostname": None, "user": "alice", "proxy_jump": None},
        "cluster-b": {"hostname": "192.0.2.11", "user": None, "proxy_jump": None},
    }


@pytest.mark.parametrize(
    "name",
    ["-oProxyCommand=x", "a;b", "$(id)", "a/b", "-l", "_lead", ".dot", "x" * 200],
)
def test_names_that_are_not_safe_aliases_are_left_out(ssh_dir: Path, name: str) -> None:
    assert hosts(ssh_dir, f"Host ok {name}\n") == {
        "ok": {"hostname": None, "user": None, "proxy_jump": None}
    }


def test_no_other_option_is_returned(ssh_dir: Path) -> None:
    (ssh_dir / "config").write_text(
        "Host box\n  IdentityFile ~/.ssh/id_secret\n  CertificateFile ~/.ssh/cert\n"
        "  LocalForward 8080 localhost:80\n  ProxyCommand ssh -W %h:%p gw\n"
    )
    result = ssh_hosts.discover(ssh_dir)
    assert result == {
        "hosts": [{"alias": "box", "hostname": None, "user": None, "proxy_jump": None}],
        "readable": True,
    }
    assert "id_secret" not in str(result)


def test_values_that_are_not_short_printable_text_are_left_out(ssh_dir: Path) -> None:
    found = hosts(ssh_dir, f'Host box\n  HostName {"h" * 300}\n  User "a\\x1b[2Jb"\n')
    assert found["box"]["hostname"] is None


def test_includes_are_followed_relative_to_the_ssh_directory(ssh_dir: Path) -> None:
    (ssh_dir / "config.d").mkdir()
    (ssh_dir / "config.d" / "10-lab").write_text("Host lab-server\n  HostName 192.0.2.30\n")
    (ssh_dir / "config.d" / "20-cloud").write_text("Host cloud-box\n")
    (ssh_dir / "config.d" / ".hidden").write_text("Host hidden\n")
    (ssh_dir / "extra").write_text("Host extra\n")
    absolute = ssh_dir.parent / "absolute.conf"
    absolute.write_text("Host absolute\n")
    (ssh_dir.parent / "tilde.conf").write_text("Host tilde\n")
    found = hosts(
        ssh_dir,
        f"Include config.d/* extra\nInclude {absolute}\ninclude=~/tilde.conf\n"
        "Include missing.conf nowhere/*\n",
    )
    assert sorted(found) == ["absolute", "cloud-box", "extra", "lab-server", "tilde"]
    assert found["lab-server"]["hostname"] == "192.0.2.30"


def test_an_include_inside_a_host_block_continues_it(ssh_dir: Path) -> None:
    (ssh_dir / "box-options").write_text("HostName 192.0.2.50\nHost inner\n  User bob\n")
    found = hosts(ssh_dir, "Host box\n  Include box-options\n  User alice\n")
    assert found == {
        "box": {"hostname": "192.0.2.50", "user": "alice", "proxy_jump": None},
        "inner": {"hostname": None, "user": "bob", "proxy_jump": None},
    }


def test_include_cycles_end(ssh_dir: Path) -> None:
    (ssh_dir / "a").write_text("Host a\nInclude b\n")
    (ssh_dir / "b").write_text("Host b\nInclude a config\n")
    assert sorted(hosts(ssh_dir, "Host top\nInclude a config\n")) == ["a", "b", "top"]


def test_includes_are_bounded_in_depth_and_number(ssh_dir: Path) -> None:
    for depth in range(30):
        (ssh_dir / f"level{depth}").write_text(f"Host level{depth}\nInclude level{depth + 1}\n")
    found = hosts(ssh_dir, "Include level0\n")
    assert len(found) == ssh_hosts.MAX_DEPTH
    for index in range(100):
        (ssh_dir / f"many{index:03}").write_text(f"Host many{index:03}\n")
    found = hosts(ssh_dir, "Include many*\n")
    assert len(found) == ssh_hosts.MAX_FILES - 1


def test_the_file_computedeck_writes_is_skipped(ssh_dir: Path, tmp_path: Path) -> None:
    managed = tmp_path / "data" / "computedeck.conf"
    managed.parent.mkdir()
    managed.write_text("Host computedeck-runpod-pod\n  HostName 192.0.2.10\n")
    found = hosts(
        ssh_dir,
        f'# ComputeDeck managed endpoints\nInclude "{managed}"\n\nHost cluster-a\n',
    )
    assert sorted(found) == ["cluster-a"]


def test_unreadable_and_special_files_are_skipped(ssh_dir: Path) -> None:
    (ssh_dir / "directory").mkdir()
    (ssh_dir / "dangling").symlink_to(ssh_dir / "nowhere")
    (ssh_dir / "loop").symlink_to(ssh_dir / "loop")
    included = ["directory", "dangling", "loop"]
    if hasattr(os, "mkfifo"):
        # Opening a FIFO would wait for a writer forever.
        os.mkfifo(ssh_dir / "fifo")
        included.append("fifo")
    started = time.monotonic()
    found = hosts(ssh_dir, f"Include {' '.join(included)}\nHost cluster-a\n")
    assert sorted(found) == ["cluster-a"]
    assert time.monotonic() - started < 5


@pytest.mark.parametrize("make", ["missing", "directory", "fifo", "binary"])
def test_a_missing_or_unreadable_config_is_an_empty_list(ssh_dir: Path, make: str) -> None:
    config = ssh_dir / "config"
    if make == "directory":
        config.mkdir()
    elif make == "fifo":
        if not hasattr(os, "mkfifo"):
            pytest.skip("no FIFOs here")
        os.mkfifo(config)
    elif make == "binary":
        config.write_bytes(b"\xff\xfe\x00\nHost \xc3\x28 ok\n\x00\x00")
        result = ssh_hosts.discover(ssh_dir)
        assert result["readable"] and [host["alias"] for host in result["hosts"]] == ["ok"]
        return
    assert ssh_hosts.discover(ssh_dir) == {"hosts": [], "readable": False}
    assert ssh_hosts.discover(ssh_dir.parent / "no-such-dir") == {
        "hosts": [],
        "readable": False,
    }


def test_hosts_are_deduplicated_sorted_and_capped(ssh_dir: Path) -> None:
    names = [f"Host-{index:04}" for index in range(1000)]
    text = "".join(f"Host {name} {name.lower()}\n  HostName 192.0.2.1\n" for name in names)
    (ssh_dir / "config").write_text(text + "Host Host-0000\n" + "# padding\n" * 200_000)
    started = time.monotonic()
    result = ssh_hosts.discover(ssh_dir)
    assert time.monotonic() - started < 5
    aliases = [host["alias"] for host in result["hosts"]]
    assert len(aliases) == ssh_hosts.MAX_HOSTS
    assert aliases[:4] == ["Host-0000", "host-0000", "Host-0001", "host-0001"]
    assert len(set(aliases)) == len(aliases)


def test_a_huge_file_is_read_only_up_to_its_bound(ssh_dir: Path) -> None:
    head = "Host early\n"
    filler = "#" * 1023 + "\n"
    tail = "Host late\n"
    count = ssh_hosts.MAX_FILE_BYTES // len(filler) + 1
    (ssh_dir / "config").write_text(head + filler * count + tail)
    assert sorted(hosts(ssh_dir)) == ["early"]
