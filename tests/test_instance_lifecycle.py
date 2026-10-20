"""One instance allocation lifecycle for the service and the web app."""

import re
from pathlib import Path
from typing import get_args

import pytest

from computedeck.drivers.cloud import INSTANCE_LIFECYCLE, State, instance_lifecycle


def test_web_and_server_share_the_lifecycle_table() -> None:
    source = (Path(__file__).parents[1] / "web/src/domain.ts").read_text()
    table = source.split("export const INSTANCE_LIFECYCLE = {", 1)[1].split("} as const;", 1)[0]
    web = dict(re.findall(r"(\w+): '(held|not_held|unknown)'", table))
    assert web == INSTANCE_LIFECYCLE
    assert set(get_args(State)) <= INSTANCE_LIFECYCLE.keys()


@pytest.mark.parametrize(
    ("state", "expected"),
    [
        ("running", "held"),
        ("reported_running", "held"),
        ("REPORTED_RUNNING", "held"),
        ("stopped", "not_held"),
        ("terminated", "not_held"),
        ("deleted", "not_held"),
        ("desired_stopped", "not_held"),
        ("desired_terminated", "not_held"),
        ("desired_running", "unknown"),
        ("unknown", "unknown"),
        ("missing", "unknown"),
        ("new_state", "unknown"),
        (None, "unknown"),
    ],
)
def test_instance_lifecycle(state: str | None, expected: str) -> None:
    assert instance_lifecycle(state) == expected
