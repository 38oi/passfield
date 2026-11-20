"""Локальный сервер. По умолчанию только петля; LAN — через PASSMANAGER_LAN=1."""

from __future__ import annotations

import ipaddress
import math
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.requests import Request

from app.db import KINDS, Vault

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"
LOCAL_HOSTS = {"127.0.0.1", "::1", "testclient", "localhost"}
LAN_MODE = os.environ.get("PASSMANAGER_LAN", "0") == "1"


def _client_allowed(host: str) -> bool:
    if host in LOCAL_HOSTS:
        return True
    if not LAN_MODE:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return bool(ip.is_private or ip.is_loopback or ip.is_link_local)

vault = Vault()


@asynccontextmanager
async def lifespan(app: FastAPI):
    vault.open()
    path = vault.key_path
    db = vault.db_path
    print(f"Ключ: {path}", flush=True)
    print(f"База: {db}", flush=True)
    yield
    vault.close()


app = FastAPI(title="passfield", docs_url=None, redoc_url=None, lifespan=lifespan)


class FreshStatic(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


def _finite(value: float) -> float:
    if not math.isfinite(value) or abs(value) > 100_000:
        raise ValueError("плохие координаты")
    return value


def _span(value: float, lo: float, hi: float) -> float:
    value = _finite(value)
    if value < lo or value > hi:
        raise ValueError("плохой размер")
    return value


class EntryIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    username: str = Field(default="", max_length=200)
    secret: str = Field(default="", max_length=4000)
    comment: str = Field(default="", max_length=2000)
    url: str = Field(default="", max_length=500)
    kind: str = "web"
    x: float = 0
    y: float = 0
    tag_ids: list[str] = Field(default_factory=list)

    @field_validator("title", "comment", "url")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        if not value:
            raise ValueError("нужно отображаемое имя")
        return value

    @field_validator("kind")
    @classmethod
    def _kind(cls, value: str) -> str:
        if value not in KINDS:
            raise ValueError("неизвестный тип")
        return value

    @field_validator("x", "y")
    @classmethod
    def _xy(cls, value: float) -> float:
        return _finite(value)


class EntryPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    username: str | None = Field(default=None, max_length=200)
    secret: str | None = Field(default=None, max_length=4000)
    comment: str | None = Field(default=None, max_length=2000)
    url: str | None = Field(default=None, max_length=500)
    kind: str | None = None
    tag_ids: list[str] | None = None

    @field_validator("title", "comment", "url")
    @classmethod
    def _strip(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip()

    @field_validator("title")
    @classmethod
    def _title(cls, value: str | None) -> str | None:
        if value is not None and not value:
            raise ValueError("нужно отображаемое имя")
        return value

    @field_validator("kind")
    @classmethod
    def _kind(cls, value: str | None) -> str | None:
        if value is not None and value not in KINDS:
            raise ValueError("неизвестный тип")
        return value


class Pos(BaseModel):
    id: str
    x: float
    y: float

    @field_validator("x", "y")
    @classmethod
    def _xy(cls, value: float) -> float:
        return _finite(value)


class PositionsIn(BaseModel):
    positions: list[Pos]


class LinkIn(BaseModel):
    a: str
    b: str


class LabelIn(BaseModel):
    text: str = Field(default="", max_length=2000)
    x: float = 0
    y: float = 0
    w: float = 320
    h: float = 88

    @field_validator("x", "y")
    @classmethod
    def _xy(cls, value: float) -> float:
        return _finite(value)

    @field_validator("w")
    @classmethod
    def _w(cls, value: float) -> float:
        return _span(value, 96, 2400)

    @field_validator("h")
    @classmethod
    def _h(cls, value: float) -> float:
        return _span(value, 40, 1600)


class LabelPatch(BaseModel):
    text: str | None = Field(default=None, max_length=2000)
    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None

    @field_validator("x", "y")
    @classmethod
    def _xy(cls, value: float | None) -> float | None:
        if value is None:
            return None
        return _finite(value)

    @field_validator("w")
    @classmethod
    def _w(cls, value: float | None) -> float | None:
        if value is None:
            return None
        return _span(value, 96, 2400)

    @field_validator("h")
    @classmethod
    def _h(cls, value: float | None) -> float | None:
        if value is None:
            return None
        return _span(value, 40, 1600)


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("пустое имя метки")
        return value


class NoteIn(BaseModel):
    title: str = Field(default="", max_length=200)
    kind: str = "page"
    parent_id: str | None = None
    body: dict | None = None
    sort: int | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        return value.strip()

    @field_validator("kind")
    @classmethod
    def _kind(cls, value: str) -> str:
        if value not in ("page", "folder"):
            raise ValueError("неизвестный тип заметки")
        return value


class NotePatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    parent_id: str | None = None
    body: dict | None = None
    sort: int | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip()


class NoteDropIn(BaseModel):
    dragged_id: str
    target_id: str


class NoteOrderItem(BaseModel):
    id: str
    parent_id: str | None = None
    sort: int = 0


class NotesOrderIn(BaseModel):
    items: list[NoteOrderItem]


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    message = "проверьте поля"
    for err in exc.errors():
        loc = err.get("loc") or ()
        if loc and loc[-1] == "title":
            message = "нужно отображаемое имя"
            break
    return JSONResponse(status_code=422, content={"detail": message})


@app.middleware("http")
async def local_only(request: Request, call_next):
    host = request.client.host if request.client else ""
    if not _client_allowed(host):
        detail = "только из домашней сети" if LAN_MODE else "только с этого компьютера"
        return JSONResponse({"detail": detail}, status_code=403)
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/bootstrap")
def bootstrap():
    return vault.snapshot()


@app.post("/api/entries", status_code=201)
def create_entry(body: EntryIn):
    try:
        return vault.create_entry(body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.patch("/api/entries/{entry_id}")
def patch_entry(entry_id: str, body: EntryPatch):
    data = body.model_dump(exclude_unset=True)
    try:
        return vault.update_entry(entry_id, data)
    except KeyError:
        raise HTTPException(404, "нет такой записи") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/entries/{entry_id}", status_code=204)
def remove_entry(entry_id: str):
    try:
        vault.delete_entry(entry_id)
    except KeyError:
        raise HTTPException(404, "нет такой записи") from None


@app.put("/api/positions")
def positions(body: PositionsIn):
    vault.update_positions([item.model_dump() for item in body.positions])
    return {"ok": True}


@app.post("/api/links")
def create_link(body: LinkIn):
    try:
        return vault.create_link(body.a, body.b)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/links/{link_id}", status_code=204)
def remove_link(link_id: str):
    try:
        vault.delete_link(link_id)
    except KeyError:
        raise HTTPException(404, "нет такой связи") from None


@app.post("/api/labels", status_code=201)
def create_label(body: LabelIn):
    return vault.create_label(body.model_dump())


@app.patch("/api/labels/{label_id}")
def patch_label(label_id: str, body: LabelPatch):
    try:
        return vault.update_label(label_id, body.model_dump(exclude_unset=True))
    except KeyError:
        raise HTTPException(404, "нет такого лейбла") from None


@app.delete("/api/labels/{label_id}", status_code=204)
def remove_label(label_id: str):
    try:
        vault.delete_label(label_id)
    except KeyError:
        raise HTTPException(404, "нет такого лейбла") from None


@app.post("/api/tags", status_code=201)
def create_tag(body: TagIn):
    try:
        return vault.create_tag(body.name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/notes", status_code=201)
def create_note(body: NoteIn):
    try:
        return vault.create_note(body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.patch("/api/notes/{note_id}")
def patch_note(note_id: str, body: NotePatch):
    try:
        return vault.update_note(note_id, body.model_dump(exclude_unset=True))
    except KeyError:
        raise HTTPException(404, "нет такой статьи") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/notes/{note_id}", status_code=204)
def remove_note(note_id: str):
    try:
        vault.delete_note(note_id)
    except KeyError:
        raise HTTPException(404, "нет такой статьи") from None


@app.post("/api/notes/drop")
def drop_note(body: NoteDropIn):
    try:
        return vault.drop_note_on_note(body.dragged_id, body.target_id)
    except KeyError:
        raise HTTPException(404, "нет такой статьи") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.put("/api/notes/order")
def order_notes(body: NotesOrderIn):
    try:
        return {"notes": vault.reorder_notes([item.model_dump() for item in body.items])}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/trash")
def get_trash():
    return {"items": vault.list_trash(), "days": 30}


@app.post("/api/trash/{kind}/{item_id}/restore")
def restore_trash_item(kind: str, item_id: str):
    if kind not in ("entry", "label", "note"):
        raise HTTPException(400, "неизвестный тип")
    try:
        return vault.restore_trash(kind, item_id)
    except KeyError:
        raise HTTPException(404, "нет в корзине") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/trash/{kind}/{item_id}/touch")
def touch_trash_item(kind: str, item_id: str):
    if kind not in ("entry", "label", "note"):
        raise HTTPException(400, "неизвестный тип")
    try:
        return vault.touch_trash(kind, item_id)
    except KeyError:
        raise HTTPException(404, "нет в корзине") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/trash/{kind}/{item_id}", status_code=204)
def purge_trash_item(kind: str, item_id: str):
    if kind not in ("entry", "label", "note"):
        raise HTTPException(400, "неизвестный тип")
    try:
        vault.purge_trash_item(kind, item_id)
    except KeyError:
        raise HTTPException(404, "нет в корзине") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/trash", status_code=200)
def empty_trash():
    return {"removed": vault.empty_trash()}


app.mount("/static", FreshStatic(directory=STATIC), name="static")
