from __future__ import annotations

import hmac
from collections.abc import Mapping
from pathlib import Path
from typing import Any


def require_api_key(headers: Mapping[str, str], expected: str | None) -> None:
    if not expected:
        raise PermissionError("UNAUTHORIZED: HME_API_KEY is not configured")
    candidate = _header_value(headers, "X-API-Key") or ""
    if not hmac.compare_digest(candidate, expected):
        raise PermissionError("UNAUTHORIZED: invalid API key")


def ok_response(data: Any, request_id: str | None = None) -> dict[str, Any]:
    return {"ok": True, "data": data, "error": None, "meta": _meta(request_id)}


def error_response(code: str, message: str, request_id: str | None = None) -> dict[str, Any]:
    return {"ok": False, "data": None, "error": {"code": code, "message": message}, "meta": _meta(request_id)}


def list_aliases(client: Any) -> dict[str, Any]:
    return ok_response(client.list_aliases())


def create_alias(client: Any, payload: Mapping[str, Any]) -> dict[str, Any]:
    label = str(payload.get("label", "")).strip()
    if not label:
        raise ValueError("label is required")
    note = str(payload.get("note", ""))
    return ok_response(client.create_alias(label=label, note=note))


def session_status(source: Any) -> dict[str, Any]:
    if hasattr(source, "status"):
        return ok_response(source.status())
    return ok_response(source.check())


def refresh_session(source: Any) -> dict[str, Any]:
    if hasattr(source, "refresh_via_validate"):
        return ok_response(source.refresh_via_validate())
    return ok_response(source.check())


def import_session(manager: Any, payload: Mapping[str, Any]) -> dict[str, Any]:
    curl_text = str(payload.get("curl_text", "")).strip()
    if not curl_text:
        raise ValueError("curl_text is required")
    from session_import import parse_import_text, save_imported_session

    icloud_region = str(payload.get("icloud_region", "international")).strip().lower()
    config = parse_import_text(curl_text, icloud_region)
    save_imported_session(config, Path(manager.config_path), Path(manager.metadata_path))
    manager.metadata = manager._load_metadata()
    return ok_response(
        {
            "imported": True,
            "icloudRegion": icloud_region,
            "host": config["host"],
        }
    )


def export_aliases_csv(client: Any) -> str:
    from hme import aliases_to_csv
    return aliases_to_csv(client.list_aliases())


def disable_alias(client: Any, anonymous_id: str) -> dict[str, Any]:
    return ok_response(client.deactivate_alias(anonymous_id))


def delete_alias(client: Any, anonymous_id: str) -> dict[str, Any]:
    return ok_response(client.delete_alias(anonymous_id))


def enable_alias(client: Any, anonymous_id: str) -> dict[str, Any]:
    return ok_response(client.activate_alias(anonymous_id))


def _header_value(headers: Mapping[str, str], name: str) -> str | None:
    value = headers.get(name)
    if value is not None:
        return str(value)
    lowered = name.lower()
    for key, candidate in headers.items():
        if str(key).lower() == lowered:
            return str(candidate)
    return None


def _meta(request_id: str | None) -> dict[str, str | None]:
    return {"service": "hme-manager", "version": "1", "requestId": request_id}
