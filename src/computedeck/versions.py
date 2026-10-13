"""Version ranges for plugin compatibility, without a packaging dependency.

A range is comma-separated clauses such as ``>=0.3, <0.5`` or ``==0.3.*``. Versions are
compared by their leading numbers; a pre-release suffix (``0.3.0a0``) counts as that
release, so a development build satisfies the range of the release it leads to.
"""

import re
from importlib.metadata import PackageNotFoundError, version

_CLAUSE = re.compile(r"\s*(>=|<=|==|!=|~=|>|<)\s*([0-9]+(?:\.[0-9]+)*)(\.\*)?\s*")


def core_version() -> str:
    try:
        return version("computedeck")
    except PackageNotFoundError:
        return "0.0.0"


def numbers(value: str) -> tuple[int, ...]:
    match = re.match(r"\s*v?([0-9]+(?:\.[0-9]+)*)", value)
    if not match:
        raise ValueError(f"Not a version: {value}")
    parts = tuple(int(part) for part in match[1].split("."))
    return parts + (0,) * (3 - len(parts)) if len(parts) < 3 else parts


def valid_range(spec: str) -> bool:
    if not spec.strip():
        return True
    for clause in spec.split(","):
        match = _CLAUSE.fullmatch(clause)
        if not match or (match[3] and match[1] not in ("==", "!=")):
            return False
        if match[1] == "~=" and "." not in match[2]:
            return False
    return True


def satisfies(current: str, spec: str | None) -> bool:
    """Whether ``current`` is inside ``spec``. An empty range accepts every version."""
    if not spec or not spec.strip():
        return True
    if not valid_range(spec):
        raise ValueError(f"Not a version range: {spec}")
    have = numbers(current)
    for clause in spec.split(","):
        match = _CLAUSE.fullmatch(clause)
        if not match:
            raise ValueError(f"Not a version range: {spec}")
        operator, text, star = match[1], match[2], match[3]
        want = numbers(text)
        if star:
            prefix = tuple(int(part) for part in text.split("."))
            same = have[: len(prefix)] == prefix
            if (operator == "==" and not same) or (operator == "!=" and same):
                return False
            continue
        if operator == "~=":
            # ~=0.3.1 means >=0.3.1 and ==0.3.*; ~=1.2 means >=1.2 and ==1.*
            head = tuple(int(part) for part in text.split("."))[:-1]
            if have < want or have[: len(head)] != head:
                return False
            continue
        ok = {
            ">=": have >= want,
            "<=": have <= want,
            ">": have > want,
            "<": have < want,
            "==": have == want,
            "!=": have != want,
        }[operator]
        if not ok:
            return False
    return True
