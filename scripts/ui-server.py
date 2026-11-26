"""Serve an isolated example UI; the caller owns and removes the temporary directory."""

import os
import socket
import sys
from pathlib import Path

import uvicorn
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from computedeck.app import create_app
from computedeck.store import Store
from computedeck.tools.chat import plugin as chat
from computedeck.tools.notify import plugin as notify


def main() -> None:
    directory = Path(sys.argv[1])
    os.environ["COMPUTEDECK_DATA_DIR"] = str(directory / "data")
    os.environ["COMPUTEDECK_WEB_DIR"] = str(directory / "web")
    os.environ["COMPUTEDECK_AUTH"] = "off"
    store = Store(directory / "data" / "computedeck.sqlite")
    store.save_settings({"server_name": "Example server", "language": "en"})
    for name in ("notify", "chat"):
        store.set_plugin_enabled(name, True)
    store.db.close()
    # No discovered plugins, collectors, cloud calls or notification loops.
    app = create_app(directory / "data", polling=False, plugins=[notify, chat])
    for name in ("fallback", "plugins"):
        app.router.routes.insert(
            0,
            Mount(
                f"/__ui-{name}",
                app=StaticFiles(directory=directory / name, html=True),
            ),
        )
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        (directory / "url").write_text(f"http://127.0.0.1:{port}")
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
        server.run(sockets=[listener])


if __name__ == "__main__":
    main()
