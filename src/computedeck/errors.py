"""Translatable messages. The web app renders ``code`` in the viewer's language."""

import math
import re
from typing import Any

CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")
_PARAM = re.compile(r"[a-z][a-z0-9_]{0,39}")


def message(code: str, **params: Any) -> dict[str, Any]:
    return {"code": code, **params}


def checked(value: Any) -> dict[str, Any] | None:
    """A message from elsewhere (a node, an older database) in the shape the web app renders:
    a code, a text detail of at most 500 characters and short text or number parameters.
    None when it has no usable code."""
    if not isinstance(value, dict) or not isinstance(value.get("code"), str):
        return None
    if not CODE.fullmatch(value["code"]):
        return None
    result: dict[str, Any] = {"code": value["code"]}
    for key, item in list(value.items())[:20]:
        if key == "detail" and isinstance(item, str) and item:
            result["detail"] = item[:500]
        elif key not in ("code", "detail") and isinstance(key, str) and _PARAM.fullmatch(key):
            if isinstance(item, str):
                result[key] = item[:200]
            elif isinstance(item, int | float) and not isinstance(item, bool):
                if math.isfinite(item):
                    result[key] = item
    return result


class SourceError(Exception):
    """A collection failure with a translatable code. ``detail`` is untranslated remote text."""

    def __init__(self, code: str, detail: str | None = None, **params: Any) -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail
        self.params = params

    def message(self) -> dict[str, Any]:
        result = message(self.code, **self.params)
        if self.detail:
            result["detail"] = self.detail
        return result
