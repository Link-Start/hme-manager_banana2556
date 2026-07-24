from __future__ import annotations

import argparse
import json
import os
import threading
import time
from pathlib import Path
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Mapping
from urllib.parse import urlparse

from api_service import (
    create_alias,
    delete_alias,
    disable_alias,
    enable_alias,
    error_response,
    export_aliases_csv,
    import_session,
    list_aliases,
    ok_response,
    refresh_session,
    require_api_key,
    session_status,
)
from hme import HmeError
from icloud_web_session import ICloudSessionManager


def create_manager_from_env(env: Mapping[str, str] | None = None) -> ICloudSessionManager:
    env = os.environ if env is None else env
    return ICloudSessionManager(
        state_dir=env.get("HME_STATE_DIR", "state"),
        config_path=env.get("ICLOUD_HME_CONFIG", "hme-config.json"),
    )


MANAGER = create_manager_from_env()


STATIC_DIR = Path(__file__).resolve().parent / "static"


def _read_static(name: str) -> str:
    return (STATIC_DIR / name).read_text(encoding="utf-8")


def render_index() -> str:
    return _read_static("index.html")


AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS = 600
AUTO_REFRESH_MIN_INTERVAL_SECONDS = 300
AUTO_REFRESH_STOP = threading.Event()
AUTO_REFRESH_THREAD: threading.Thread | None = None


def auto_refresh_config_path(manager: ICloudSessionManager = MANAGER) -> Path:
    return Path(manager.state_dir) / "auto-refresh.json"


def auto_refresh_defaults() -> dict[str, Any]:
    return {
        "enabled": True,
        "intervalSeconds": AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS,
        "lastRunAt": None,
        "lastSuccessAt": None,
        "lastDisabledAt": None,
        "lastError": None,
        "disabledReason": None,
    }


def _normalize_auto_refresh(config: dict[str, Any]) -> dict[str, Any]:
    merged = {**auto_refresh_defaults(), **config}
    try:
        merged["intervalSeconds"] = max(
            AUTO_REFRESH_MIN_INTERVAL_SECONDS,
            int(merged.get("intervalSeconds") or AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS),
        )
    except (TypeError, ValueError):
        merged["intervalSeconds"] = AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS
    merged["enabled"] = bool(merged.get("enabled"))
    return merged


def load_auto_refresh_config(manager: ICloudSessionManager = MANAGER) -> dict[str, Any]:
    path = auto_refresh_config_path(manager)
    data: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, json.JSONDecodeError):
            data = {}
    return _normalize_auto_refresh(data)


def save_auto_refresh_config(config: dict[str, Any], manager: ICloudSessionManager = MANAGER) -> dict[str, Any]:
    merged = _normalize_auto_refresh(config)
    path = auto_refresh_config_path(manager)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return merged


def auto_refresh_status(manager: ICloudSessionManager = MANAGER) -> dict[str, Any]:
    config = load_auto_refresh_config(manager)
    config["workerRunning"] = AUTO_REFRESH_THREAD is not None and AUTO_REFRESH_THREAD.is_alive()
    now = time.time()
    interval = config["intervalSeconds"]
    last_run = float(config.get("lastRunAt") or config.get("lastSuccessAt") or 0)
    if config.get("enabled"):
        next_run_at = (last_run + interval) if last_run else now + interval
        config["remainingSeconds"] = max(0, int(round(next_run_at - now)))
        config["nextRunAt"] = next_run_at
    else:
        config["remainingSeconds"] = None
        config["nextRunAt"] = None
    config["serverNow"] = now
    return config


def update_auto_refresh(payload: Mapping[str, Any], manager: ICloudSessionManager = MANAGER) -> dict[str, Any]:
    current = load_auto_refresh_config(manager)
    if "enabled" in payload:
        current["enabled"] = bool(payload.get("enabled"))
        if current["enabled"]:
            current["disabledReason"] = None
            current["lastDisabledAt"] = None
            current["lastError"] = None
    if "intervalSeconds" in payload:
        current["intervalSeconds"] = payload.get("intervalSeconds")
    return save_auto_refresh_config(current, manager)


def disable_auto_refresh(reason: str, manager: ICloudSessionManager = MANAGER) -> dict[str, Any]:
    current = load_auto_refresh_config(manager)
    current.update({"enabled": False, "lastDisabledAt": time.time(), "disabledReason": reason, "lastError": reason})
    return save_auto_refresh_config(current, manager)


def refresh_result_requires_disable(status: dict[str, Any]) -> str | None:
    if not isinstance(status, dict):
        return None
    if status.get("needsReauth"):
        return "session requires re-import"
    error = str(status.get("lastError") or "")
    if "HTTP 401" in error or "HTTP 403" in error or "HTTP 421" in error:
        return error
    return None


def run_auto_refresh_once(manager: ICloudSessionManager = MANAGER) -> dict[str, Any]:
    now = time.time()
    config = load_auto_refresh_config(manager)
    config["lastRunAt"] = now
    try:
        status = manager.check()
    except HmeError as exc:
        reason = str(exc)
        if any(code in reason for code in ("HTTP 401", "HTTP 403", "HTTP 421")):
            return {"autoRefresh": disable_auto_refresh(reason, manager), "session": None}
        config["lastError"] = reason
        return {"autoRefresh": save_auto_refresh_config(config, manager), "session": None}
    reason = refresh_result_requires_disable(status)
    if reason:
        return {"autoRefresh": disable_auto_refresh(reason, manager), "session": status}
    config.update({"lastSuccessAt": now, "lastError": None, "disabledReason": None})
    return {"autoRefresh": save_auto_refresh_config(config, manager), "session": status}


def auto_refresh_loop(manager: ICloudSessionManager = MANAGER) -> None:
    while not AUTO_REFRESH_STOP.is_set():
        try:
            config = load_auto_refresh_config(manager)
            if config.get("enabled"):
                last_run = float(config.get("lastRunAt") or 0)
                if time.time() - last_run >= config["intervalSeconds"]:
                    run_auto_refresh_once(manager)
        except Exception as exc:  # never let an unexpected error kill the worker
            print(f"auto-refresh worker error: {exc}")
        AUTO_REFRESH_STOP.wait(30)


def start_auto_refresh_worker(manager: ICloudSessionManager = MANAGER) -> None:
    global AUTO_REFRESH_THREAD
    if AUTO_REFRESH_THREAD is not None and AUTO_REFRESH_THREAD.is_alive():
        return
    AUTO_REFRESH_STOP.clear()
    AUTO_REFRESH_THREAD = threading.Thread(target=auto_refresh_loop, args=(manager,), name="hme-auto-refresh", daemon=True)
    AUTO_REFRESH_THREAD.start()


def stop_auto_refresh_worker() -> None:
    AUTO_REFRESH_STOP.set()
    if AUTO_REFRESH_THREAD is not None:
        AUTO_REFRESH_THREAD.join(timeout=5)


def health_payload() -> dict[str, Any]:
    return ok_response({"status": "ok"})


def is_api_path(path: str) -> bool:
    return urlparse(path).path.startswith("/v1/")


def dispatch_private_api(
    method: str,
    path: str,
    headers: Mapping[str, str],
    body: bytes,
    manager: ICloudSessionManager,
    api_key: str | None,
) -> tuple[HTTPStatus, dict[str, Any]]:
    parsed_path = urlparse(path).path
    try:
        require_api_key(headers, api_key)
        if method == "GET" and parsed_path == "/v1/session/status":
            return HTTPStatus.OK, session_status(manager)
        if method == "POST" and parsed_path == "/v1/session/refresh":
            return HTTPStatus.OK, refresh_session(manager)
        if method == "POST" and parsed_path == "/v1/session/import":
            return HTTPStatus.OK, import_session(manager, _json_body(body))
        if method == "GET" and parsed_path == "/v1/auto-refresh":
            return HTTPStatus.OK, ok_response(auto_refresh_status(manager))
        if method == "POST" and parsed_path == "/v1/auto-refresh":
            return HTTPStatus.OK, ok_response(update_auto_refresh(_json_body(body), manager))
        if method == "POST" and parsed_path == "/v1/auto-refresh/run":
            return HTTPStatus.OK, ok_response(run_auto_refresh_once(manager))
        if method == "GET" and parsed_path == "/v1/aliases":
            return HTTPStatus.OK, list_aliases(manager.get_client())
        if method == "GET" and parsed_path == "/v1/aliases/export.csv":
            csv_data = export_aliases_csv(manager.get_client())
            return HTTPStatus.OK, ok_response(csv_data)
        if method == "POST" and parsed_path == "/v1/aliases":
            return HTTPStatus.OK, create_alias(manager.get_client(), _json_body(body))

        alias_action = _alias_action(parsed_path)
        if alias_action is not None and method == "POST":
            anonymous_id, action = alias_action
            client = manager.get_client()
            if action == "disable":
                return HTTPStatus.OK, disable_alias(client, anonymous_id)
            if action == "delete":
                return HTTPStatus.OK, delete_alias(client, anonymous_id)
            if action == "enable":
                return HTTPStatus.OK, enable_alias(client, anonymous_id)

        return HTTPStatus.NOT_FOUND, error_response("NOT_FOUND", "not found")
    except PermissionError as exc:
        return HTTPStatus.UNAUTHORIZED, error_response("UNAUTHORIZED", str(exc))
    except (ValueError, json.JSONDecodeError) as exc:
        return HTTPStatus.BAD_REQUEST, error_response("BAD_REQUEST", str(exc))
    except HmeError as exc:
        code, status = _hme_error_code_and_status(str(exc))
        return status, error_response(code, str(exc))
    except OSError as exc:
        return HTTPStatus.INTERNAL_SERVER_ERROR, error_response("STORAGE_ERROR", str(exc))


def _json_body(body: bytes) -> dict[str, Any]:
    if not body:
        return {}
    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("JSON body must be an object")
    return payload


def _alias_action(path: str) -> tuple[str, str | None] | None:
    parts = [part for part in path.split("/") if part]
    if len(parts) == 3 and parts[:2] == ["v1", "aliases"]:
        return parts[2], None
    if len(parts) == 4 and parts[:2] == ["v1", "aliases"] and parts[3] in {"disable", "enable", "delete"}:
        return parts[2], parts[3]
    return None


def _hme_error_code_and_status(message: str) -> tuple[str, HTTPStatus]:
    if "尚未匯入" in message or "Missing required config" in message or "Config file not found" in message:
        return "SESSION_MISSING", HTTPStatus.CONFLICT
    if "HTTP 401" in message or "HTTP 403" in message:
        return "SESSION_EXPIRED", HTTPStatus.UNAUTHORIZED
    return "ICLOUD_ERROR", HTTPStatus.BAD_GATEWAY


class HmeWebHandler(BaseHTTPRequestHandler):
    server_version = "HmeWeb/0.1"

    def do_GET(self) -> None:
        try:
            if self.path == "/health":
                self._json(health_payload())
                return
            if is_api_path(self.path):
                status, payload = dispatch_private_api(
                    "GET",
                    self.path,
                    self.headers,
                    b"",
                    MANAGER,
                    os.environ.get("HME_API_KEY"),
                )
                self._json(payload, status=status)
                return
            if self.path == "/" or self.path.startswith("/?"):
                self._html(render_index())
                return
            if self.path.startswith("/static/"):
                self._serve_static(self.path[len("/static/"):])
                return
            if self.path == "/favicon.ico":
                self._send(HTTPStatus.NO_CONTENT, b"", "text/plain")
                return
            self._json({"ok": False, "error": "not found"}, status=HTTPStatus.NOT_FOUND)
        except HmeError as exc:
            self._json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def do_POST(self) -> None:
        try:
            if is_api_path(self.path):
                status, payload = dispatch_private_api(
                    "POST",
                    self.path,
                    self.headers,
                    self._read_body(),
                    MANAGER,
                    os.environ.get("HME_API_KEY"),
                )
                self._json(payload, status=status)
                return
            self._json({"ok": False, "error": "not found"}, status=HTTPStatus.NOT_FOUND)
        except (HmeError, ValueError, json.JSONDecodeError) as exc:
            self._json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def log_message(self, format: str, *args: object) -> None:
        print("%s - %s" % (self.address_string(), format % args))

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or "0")
        return self.rfile.read(length)

    def _json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _html(self, content: str) -> None:
        self._send(HTTPStatus.OK, content.encode("utf-8"), "text/html; charset=utf-8")

    STATIC_CONTENT_TYPES = {
        "app.css": "text/css; charset=utf-8",
        "app.js": "text/javascript; charset=utf-8",
        "logo.svg": "image/svg+xml",
    }

    def _serve_static(self, name: str) -> None:
        content_type = self.STATIC_CONTENT_TYPES.get(name)
        if content_type is None:  # whitelist only; blocks path traversal
            self._json({"ok": False, "error": "not found"}, status=HTTPStatus.NOT_FOUND)
            return
        self._send(HTTPStatus.OK, _read_static(name).encode("utf-8"), content_type)

    def _send(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def create_server(host: str, port: int) -> HTTPServer:
    return HTTPServer((host, port), HmeWebHandler)


def run(host: str, port: int) -> None:
    server = create_server(host, port)
    start_auto_refresh_worker(MANAGER)
    print(f"Listening on http://{host}:{port}")
    try:
        server.serve_forever()
    finally:
        stop_auto_refresh_worker()
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Local web UI for iCloud Hide My Email")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=int(os.environ.get("PORT", "8000")), type=int)
    args = parser.parse_args()
    run(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
