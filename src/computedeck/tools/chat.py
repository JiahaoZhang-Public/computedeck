"""Team messages: short notes and small files shared by everyone who can open this service.

Channels are "general", each cluster or platform, and each collection machine. Names are
whatever each viewer enters on their device; they are not accounts. Files are stored in
the data directory and removed with their message.
"""

import json
import math
import os
import re
import secrets
import shutil
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Query, Request
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..errors import message
from ..plugins import Plugin, PluginContext, SettingField
from ..store import Store, now

CHANNEL = r"^[a-z0-9][a-z0-9-]{0,63}$"
FILE_NAME = re.compile(r"[^\x00-\x1f/\\:]{1,200}")
# Whole numbers from 1: the default, and the largest value.
LIMITS = {"keep_days": (90, 36500), "max_file_mb": (25, 1024)}


def _valid(key: str, value: Any) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and 1 <= value <= LIMITS[key][1]
        and int(value) == value
    )


def check_settings(saved: dict[str, Any]) -> tuple[dict[str, int], dict[str, Any]]:
    """The settings as used, and the stored values that are not valid.

    Settings saved by an older build were not always checked. A value outside the limits
    the Toolbox enforces falls back to the default, as an empty one does.
    """
    values: dict[str, int] = {}
    invalid: dict[str, Any] = {}
    for key, (default, _) in LIMITS.items():
        value = saved.get(key)
        if value is not None and not _valid(key, value):
            invalid[key] = value
        values[key] = default if value is None or key in invalid else int(value)
    return values, invalid


class MessageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel: str = Field(default="general", pattern=CHANNEL)
    author: str = Field(min_length=1, max_length=40)
    body: str = Field(default="", max_length=8000)
    attachment: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")

    @field_validator("author")
    @classmethod
    def plain_author(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("Use a plain name")
        return value


def _prepare(store: Store) -> None:
    with store.db:
        store.db.executescript("""
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel TEXT NOT NULL,
                at TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS chat_messages_channel ON chat_messages (channel, id);
        """)


# A stored message that is not valid JSON must not make the query fail.
_ATTACHMENT = "CASE WHEN json_valid(data) THEN json_extract(data, '$.attachment.id') END"


def _row(store: Store, row: tuple[Any, ...]) -> dict[str, Any] | None:
    data = store.record("chat_messages", row[0], row[3], {})
    return None if data is None else {"id": row[0], "channel": row[1], "at": row[2], **data}


def channels(store: Store) -> list[dict[str, str]]:
    """General, then each cluster or platform with sources, then each collection machine."""
    result = [{"id": "general", "label": "general", "kind": "general"}]
    seen = {"general"}
    for source in store.sources():
        key = source["cluster_id"]
        if key not in seen:
            seen.add(key)
            result.append({"id": key, "label": source["name"], "kind": "group"})
    for node in store.nodes():
        key = f"node-{node['id']}"[:64]
        if key not in seen:
            seen.add(key)
            result.append({"id": key, "label": node["name"], "kind": "node"})
    return result


class Chat:
    def __init__(self, ctx: PluginContext) -> None:
        self.ctx = ctx

    @property
    def files(self) -> Path:
        # Built-in attachments retain their established location across upgrades.
        return self.ctx.runtime.data_dir / "chat-files"

    def settings(self) -> dict[str, int]:
        return check_settings(self.ctx.settings())[0]

    def messages(self, channel: str, after: int, limit: int) -> list[dict[str, Any]]:
        rows = self.ctx.store.db.execute(
            "SELECT id, channel, at, data FROM chat_messages WHERE channel=? AND id>? "
            "ORDER BY id DESC LIMIT ?",
            (channel, after, limit),
        ).fetchall()
        messages = (_row(self.ctx.store, row) for row in reversed(rows))
        return [item for item in messages if item is not None]

    def attachment(self, attachment_id: str) -> dict[str, Any]:
        folder = self.files / attachment_id
        try:
            meta = json.loads((folder / "meta.json").read_text())
            if not isinstance(meta, dict) or meta.get("id") != attachment_id:
                raise ValueError
            if not isinstance(meta.get("name"), str) or not (folder / "data").is_file():
                raise ValueError
        except (OSError, ValueError):
            raise HTTPException(404, message("attachment_not_found")) from None
        return meta

    def add(self, body: MessageInput) -> dict[str, Any]:
        attachment = None
        if body.attachment:
            attachment = self.attachment(body.attachment)
        if not body.body.strip() and not attachment:
            raise HTTPException(422, message("message_empty"))
        data = {"author": body.author, "body": body.body.rstrip(), "attachment": attachment}
        with self.ctx.store.db:
            cursor = self.ctx.store.db.execute(
                "INSERT INTO chat_messages (channel, at, data) VALUES (?, ?, ?)",
                (body.channel, now(), json.dumps(data)),
            )
        row = self.ctx.store.db.execute(
            "SELECT id, channel, at, data FROM chat_messages WHERE id=?", (cursor.lastrowid,)
        ).fetchone()
        return _row(self.ctx.store, row) or {}

    def delete(self, message_id: int) -> bool:
        row = self.ctx.store.db.execute(
            "SELECT data FROM chat_messages WHERE id=?", (message_id,)
        ).fetchone()
        if row is None:
            return False
        attachment = (self.ctx.store.record("chat_messages", message_id, row[0], {}) or {}).get(
            "attachment"
        )
        with self.ctx.store.db:
            self.ctx.store.db.execute("DELETE FROM chat_messages WHERE id=?", (message_id,))
        if isinstance(attachment, dict) and isinstance(attachment.get("id"), str):
            remaining = self.ctx.store.db.execute(
                f"SELECT 1 FROM chat_messages WHERE {_ATTACHMENT}=? LIMIT 1", (attachment["id"],)
            ).fetchone()
            if not remaining:
                shutil.rmtree(self.files / attachment["id"], ignore_errors=True)
        return True

    def prune(self) -> int:
        days = self.settings()["keep_days"]
        cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()
        old = self.ctx.store.db.execute(
            "SELECT id FROM chat_messages WHERE at < ?", (cutoff,)
        ).fetchall()
        for (message_id,) in old:
            self.delete(message_id)
        # Unsent uploads expire after a day, allowing time to compose a message.
        attached = {
            row[0] for row in self.ctx.store.db.execute(f"SELECT {_ATTACHMENT} FROM chat_messages")
        }
        if self.files.is_dir():
            for folder in self.files.iterdir():
                if folder.name not in attached and folder.stat().st_mtime < time.time() - 86400:
                    shutil.rmtree(folder, ignore_errors=True)
        return len(old)


def setup(ctx: PluginContext) -> None:
    chat = Chat(ctx)
    ctx.on_startup(lambda: _prepare(ctx.store))

    def validate_settings(values: dict[str, Any]) -> dict[str, Any]:
        for key, (default, _) in LIMITS.items():
            if not _valid(key, values.get(key, default)):
                raise ValueError("setting_invalid")
        return values

    ctx.validator = validate_settings

    async def housekeeping() -> None:
        import asyncio

        while True:
            chat.prune()
            await asyncio.sleep(3600)

    ctx.background(housekeeping)

    @ctx.router.get("")
    async def overview() -> dict[str, Any]:
        return {
            "channels": channels(ctx.store),
            "max_file_mb": chat.settings()["max_file_mb"],
        }

    @ctx.router.get("/messages")
    async def list_messages(
        channel: str = Query(default="general", pattern=CHANNEL),
        after: int = Query(default=0, ge=0, le=2**63 - 1),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> list[dict[str, Any]]:
        return chat.messages(channel, after, limit)

    @ctx.router.post("/messages", status_code=201)
    async def post_message(body: MessageInput) -> dict[str, Any]:
        return chat.add(body)

    @ctx.router.delete("/messages/{message_id}")
    async def delete_message(message_id: int = PathParam(ge=1, le=2**63 - 1)) -> dict[str, bool]:
        if not chat.delete(message_id):
            raise HTTPException(404, message("message_not_found"))
        return {"deleted": True}

    @ctx.router.post("/attachments", status_code=201)
    async def upload(request: Request, name: str = Query(min_length=1, max_length=200)) -> Any:
        """Store a file sent as the raw request body; the message refers to it by id."""
        if not FILE_NAME.fullmatch(name) or name in (".", ".."):
            raise HTTPException(422, message("file_name_invalid"))
        limit = chat.settings()["max_file_mb"] * 1024 * 1024
        attachment_id = secrets.token_hex(16)
        chat.files.mkdir(parents=True, exist_ok=True, mode=0o700)
        chat.files.chmod(0o700)
        folder = chat.files / attachment_id
        folder.mkdir(mode=0o700)
        size = 0
        try:
            descriptor = os.open(folder / "data", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as out:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > limit:
                        raise HTTPException(413, message("file_too_large", limit=limit // 1048576))
                    out.write(chunk)
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        meta = {"id": attachment_id, "name": name, "size": size}
        descriptor = os.open(folder / "meta.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as out:
            out.write(json.dumps(meta))
        return meta

    @ctx.router.get("/attachments/{attachment_id}")
    async def download(attachment_id: str) -> FileResponse:
        if not re.fullmatch(r"[0-9a-f]{32}", attachment_id):
            raise HTTPException(404, message("attachment_not_found"))
        folder = chat.files / attachment_id
        meta = chat.attachment(attachment_id)
        return FileResponse(
            folder / "data",
            filename=meta["name"],
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store"},
        )

    def health() -> dict[str, Any]:
        count = int(ctx.store.db.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0])
        en, zh = f"{count} message{'s' * (count != 1)}", f"{count} 条留言"
        invalid = check_settings(ctx.settings())[1]
        labels = {field.key: field.label for field in ctx.plugin.settings}
        for key, value in invalid.items():
            label, shown, default = labels[key], str(value)[:80], LIMITS[key][0]
            en += f" · saved “{label['en']}” {shown} is not valid; using {default}"
            zh += f" · 保存的“{label['zh-CN']}” {shown} 无效，改用 {default}"
        return {
            "messages": count,
            "invalid_settings": {key: str(value)[:80] for key, value in invalid.items()},
            "summary": {"en": en, "zh-CN": zh},
        }

    ctx.health = health


plugin = Plugin(
    id="chat",
    setup=setup,
    name={"en": "Team messages", "zh-CN": "团队留言"},
    description={
        "en": "Short notes and small files for everyone who opens this ComputeDeck, by "
        "channel: general, each cluster and each collection machine.",
        "zh-CN": "给所有打开这个 ComputeDeck 的人留言和传小文件，按频道分：综合、每个集群、"
        "每台采集机器。",
    },
    default_enabled=False,
    page="chat",
    icon="chat",
    permissions=(
        {
            "en": "stores messages and files in this service's data folder",
            "zh-CN": "把留言和文件保存在本服务的数据目录中",
        },
        {
            "en": "lets anyone who can open this page post under any name",
            "zh-CN": "能打开本页面的任何人都可以用任意名字留言",
        },
    ),
    settings=(
        SettingField(
            key="keep_days",
            label={"en": "Keep messages for (days)", "zh-CN": "留言保留天数"},
            kind="number",
            default=90,
        ),
        SettingField(
            key="max_file_mb",
            label={"en": "Largest file (MB)", "zh-CN": "单个文件上限（MB）"},
            kind="number",
            default=25,
        ),
    ),
)
