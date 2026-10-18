"""MCP administration API. Credential fields are write-only; errors never echo remote data."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from prism.connectors import registry
from prism.connectors.manager import ConnectionManager
from prism.connectors.sources import import_resource
from prism.connectors.store import ConnectorStore


@asynccontextmanager
async def lifespan(app):
    allowlist = Path(os.environ.get("PRISM_CONNECTORS_CONFIG", "config/connectors.yaml"))
    manager = ConnectionManager(ConnectorStore(app.state.store.db_path), allowlist,
                                enquiry_for=app.state.store.enquiry_text)
    app.state.connectors = manager
    def turn_for(sid):
        tid = app.state.store.active_turn(sid)
        return app.state.turns.get(tid) if tid else None
    registry.bind(manager, turn_for)
    try:
        yield
    finally:
        registry.bind(None)
        await asyncio.to_thread(manager.close)


class SafeRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def safe(request):
            try:
                return await handler(request)
            except RequestValidationError:
                raise HTTPException(422, "Invalid connector request; check the form fields") from None
        return safe


router = APIRouter(route_class=SafeRoute, prefix="/api/connectors", tags=["connectors"], lifespan=lifespan)


class ServerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    transport: Literal["http", "sse", "stdio"] = "http"
    url: str = ""
    stdio_id: str = ""
    auth_kind: Literal["none", "header", "bearer", "api_key", "oauth"] = "none"
    header_name: str = "Authorization"
    secret: str | None = Field(default=None, repr=False)
    enabled: bool = True
    may_receive_assessment: bool = False


class ServerPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    transport: Literal["http", "sse", "stdio"] | None = None
    url: str | None = None
    stdio_id: str | None = None
    auth_kind: Literal["none", "header", "bearer", "api_key", "oauth"] | None = None
    header_name: str | None = None
    secret: str | None = Field(default=None, repr=False)
    enabled: bool | None = None
    may_receive_assessment: bool | None = None


class PermissionsIn(BaseModel):
    permissions: dict[str, Literal["disabled", "allowed", "ask"]]


class ImportIn(BaseModel):
    uri: str
    collection: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=300)


def service(request: Request) -> ConnectionManager:
    return request.app.state.connectors


def attempt(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except (KeyError, StopIteration):
        raise HTTPException(404, "Unknown MCP server") from None
    except ValueError as exc:
        # Only local validation messages reach here; transport/provider exceptions are sanitized in the manager.
        raise HTTPException(422, str(exc)) from None
    except Exception:  # noqa: BLE001 - never return provider exception text
        raise HTTPException(503, "MCP server unavailable; check connection and authentication") from None


@router.get("")
def list_servers(request: Request):
    return service(request).list()


@router.get("/stdio")
def stdio_allowlist(request: Request):
    return [{"id": key, "name": entry.get("name", key)} for key, entry in service(request).local.items()]


@router.get("/audit")
def audit(request: Request, limit: int = Query(100, ge=1, le=500)):
    return service(request).store.latest_audit(limit)


@router.post("/test")
def test_connection(body: ServerIn, request: Request):
    return attempt(service(request).test, body.model_dump(exclude_none=True))


@router.post("")
def create_server(body: ServerIn, request: Request):
    return attempt(service(request).save, body.model_dump(exclude_none=True))


@router.get("/oauth/callback", response_class=HTMLResponse)
def oauth_callback(request: Request, code: str = "", state: str = "", iss: str | None = None,
                   error: str | None = None):
    if error or not code or not state:
        raise HTTPException(400, "OAuth authorization was declined or is incomplete")
    attempt(service(request).oauth_callback, code, state, iss)
    return HTMLResponse("<p>Authorization received. You can return to PRISM Integrations.</p>",
                        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.patch("/{sid}")
def update_server(sid: str, body: ServerPatch, request: Request):
    return attempt(service(request).save, body.model_dump(exclude_none=True), sid)


@router.delete("/{sid}")
def delete_server(sid: str, request: Request):
    attempt(service(request).delete, sid)
    return {"deleted": True}


@router.post("/{sid}/test")
def test_saved_connection(sid: str, body: ServerPatch, request: Request):
    return attempt(service(request).test, body.model_dump(exclude_none=True), sid)


@router.post("/{sid}/connect")
def connect(sid: str, request: Request):
    return attempt(service(request).connect, sid)


@router.post("/{sid}/disconnect")
def disconnect(sid: str, request: Request):
    return attempt(service(request).disconnect, sid)


@router.post("/{sid}/enable")
def enable(sid: str, request: Request):
    return attempt(service(request).save, {"enabled": True}, sid)


@router.post("/{sid}/disable")
def disable(sid: str, request: Request):
    return attempt(service(request).save, {"enabled": False}, sid)


@router.get("/{sid}/tools")
def tools(sid: str, request: Request, refresh: bool = False):
    return attempt(service(request).catalog, sid, refresh)["tools"]


@router.patch("/{sid}/tools")
def permissions(sid: str, body: PermissionsIn, request: Request):
    manager = service(request)
    config = attempt(manager.store.get, sid)
    catalog = attempt(manager.catalog, sid)
    if set(body.permissions) - {t["name"] for t in catalog["tools"]}:
        raise HTTPException(422, "Choose a discovered tool")
    # Permission updates do not interrupt an in-flight call or transport.
    manager.store.save({**config, "permissions": {**config["permissions"], **body.permissions}},
                       manager.store.secrets(sid), sid)
    return attempt(manager.catalog, sid)["tools"]


@router.get("/{sid}/resources")
def resources(sid: str, request: Request):
    return attempt(service(request).catalog, sid)["resources"]


@router.get("/{sid}/prompts")
def prompts(sid: str, request: Request):
    return attempt(service(request).catalog, sid)["prompts"]


@router.post("/{sid}/resources/import")
def resource_import(sid: str, body: ImportIn, request: Request):
    return attempt(import_resource, service(request), sid, body.uri, body.collection, body.title)


@router.post("/{sid}/oauth/start")
def oauth_start(sid: str, request: Request):
    callback = str(request.url_for("oauth_callback"))
    return attempt(service(request).oauth_start, sid, callback)
