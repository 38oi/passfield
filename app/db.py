"""SQLite и кэш расшифрованного графа в памяти.

Чтения идут из памяти. На диск пароль попадает только шифртекстом.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.crypto import decrypt, encrypt, load_key, resolve_key_path

KINDS = ("ssh", "system", "software", "web", "service", "personal")
NOTE_KINDS = ("page", "folder")
EMPTY_NOTE_BODY = {"blocks": [{"id": "seed", "type": "p", "html": ""}]}
TAG_RE = re.compile(r"<[^>]+>")
TRASH_DAYS = 30

PALETTE = (
    "#3f6f54",
    "#8a5a2a",
    "#3d5c8a",
    "#8a3d55",
    "#6a4a2a",
    "#2f6d68",
    "#6d4570",
    "#8d4b3c",
)

DEFAULT_TAGS = (
    ("Аутсорс", "#8a5a2a"),
    ("Фриланс", "#3d5c8a"),
    ("Личное", "#8a3d55"),
)

ROOT = Path(__file__).resolve().parents[1]


def resolve_db_path() -> Path:
    env = os.environ.get("PASSMANAGER_DB")
    if env:
        return Path(env).expanduser()
    return ROOT / "data" / "vault.db"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_ts(value: str) -> datetime:
    raw = value.replace("Z", "+00:00")
    stamp = datetime.fromisoformat(raw)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp


def trash_expires_at(deleted_at: str) -> str:
    return (parse_ts(deleted_at) + timedelta(days=TRASH_DAYS)).isoformat(timespec="seconds")


def trash_days_left(deleted_at: str, touched_at: str | None = None) -> int:
    anchor = parse_ts(touched_at or deleted_at)
    end = anchor + timedelta(days=TRASH_DAYS)
    left = (end - datetime.now(timezone.utc)).total_seconds()
    return max(0, int(left // 86400) + (1 if left % 86400 > 0 else 0))


def empty_note_body() -> dict:
    return {
        "blocks": [{
            "id": str(uuid.uuid4()),
            "type": "p",
            "html": "",
        }]
    }


def body_to_plain(body: dict | None) -> str:
    if not body:
        return ""
    parts: list[str] = []
    for block in body.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "code":
            parts.append(str(block.get("text") or ""))
        else:
            parts.append(TAG_RE.sub("", str(block.get("html") or "")))
    return "\n".join(parts)


def normalize_body(raw) -> dict:
    if raw is None or raw == "":
        return empty_note_body()
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("тело статьи битое") from exc
    if not isinstance(raw, dict):
        raise ValueError("тело статьи битое")
    blocks = raw.get("blocks")
    if not isinstance(blocks, list):
        raise ValueError("тело статьи битое")
    cleaned: list[dict] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("type") or "p"
        if kind == "code":
            cleaned.append({
                "id": str(block.get("id") or uuid.uuid4()),
                "type": "code",
                "text": str(block.get("text") or "")[:200_000],
            })
        else:
            cleaned.append({
                "id": str(block.get("id") or uuid.uuid4()),
                "type": "p",
                "html": str(block.get("html") or "")[:200_000],
            })
    if not cleaned:
        return empty_note_body()
    return {"blocks": cleaned}


class Vault:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.conn: sqlite3.Connection | None = None
        self.key: bytes | None = None
        self.key_path: Path | None = None
        self.db_path: Path | None = None
        self.entries: dict[str, dict] = {}
        self.links: dict[str, dict] = {}
        self.tags: dict[str, dict] = {}
        self.labels: dict[str, dict] = {}
        self.notes: dict[str, dict] = {}
        self.trash_entries: dict[str, dict] = {}
        self.trash_labels: dict[str, dict] = {}
        self.trash_notes: dict[str, dict] = {}

    def open(self) -> None:
        with self.lock:
            self.close_unlocked()
            self.db_path = resolve_db_path()
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self.key_path = resolve_key_path()
            self.key = load_key(self.key_path)
            self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA foreign_keys=ON")
            self._schema()
            self._migrate()
            self._purge_trash_unlocked()
            self._seed_tags()
            self._load()

    def close(self) -> None:
        with self.lock:
            self.close_unlocked()

    def close_unlocked(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None
        self.entries.clear()
        self.links.clear()
        self.tags.clear()
        self.labels.clear()
        self.notes.clear()
        self.trash_entries.clear()
        self.trash_labels.clear()
        self.trash_notes.clear()

    def _schema(self) -> None:
        assert self.conn is not None
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT '',
                secret TEXT NOT NULL DEFAULT '',
                comment TEXT NOT NULL DEFAULT '',
                url TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'web',
                x REAL NOT NULL DEFAULT 0,
                y REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                color TEXT NOT NULL,
                sort INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS entry_tags (
                entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (entry_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS links (
                id TEXT PRIMARY KEY,
                a TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                b TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                CHECK (a < b),
                UNIQUE (a, b)
            );

            CREATE TABLE IF NOT EXISTS labels (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL DEFAULT '',
                x REAL NOT NULL DEFAULT 0,
                y REAL NOT NULL DEFAULT 0,
                w REAL NOT NULL DEFAULT 320,
                h REAL NOT NULL DEFAULT 88,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'page',
                parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
                sort INTEGER NOT NULL DEFAULT 0,
                body TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        self.conn.commit()

    def _migrate(self) -> None:
        assert self.conn is not None
        for table in ("entries", "labels", "notes"):
            cols = {row[1] for row in self.conn.execute(f"PRAGMA table_info({table})")}
            if "deleted_at" not in cols:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN deleted_at TEXT")
            if "trash_touched_at" not in cols:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN trash_touched_at TEXT")
        self.conn.commit()

    def _purge_trash_unlocked(self) -> None:
        assert self.conn is not None
        cutoff = (datetime.now(timezone.utc) - timedelta(days=TRASH_DAYS)).isoformat(timespec="seconds")
        with self.conn:
            for table in ("entries", "labels", "notes"):
                self.conn.execute(
                    f"""
                    DELETE FROM {table}
                    WHERE deleted_at IS NOT NULL
                      AND COALESCE(trash_touched_at, deleted_at) < ?
                    """,
                    (cutoff,),
                )

    def _seed_tags(self) -> None:
        assert self.conn is not None
        count = self.conn.execute("SELECT COUNT(*) AS c FROM tags").fetchone()["c"]
        if count:
            return
        with self.conn:
            for index, (name, color) in enumerate(DEFAULT_TAGS):
                self.conn.execute(
                    "INSERT INTO tags (id, name, color, sort) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), name, color, index),
                )

    def _load(self) -> None:
        assert self.conn is not None and self.key is not None
        self.tags = {
            row["id"]: {
                "id": row["id"],
                "name": row["name"],
                "color": row["color"],
                "sort": row["sort"],
            }
            for row in self.conn.execute("SELECT * FROM tags ORDER BY sort, name")
        }
        tag_map: dict[str, list[str]] = {}
        for row in self.conn.execute("SELECT entry_id, tag_id FROM entry_tags"):
            tag_map.setdefault(row["entry_id"], []).append(row["tag_id"])

        self.entries = {}
        self.trash_entries = {}
        for row in self.conn.execute("SELECT * FROM entries"):
            secret = ""
            secret_ok = True
            blob = row["secret"]
            if blob:
                try:
                    secret = decrypt(self.key, blob)
                except Exception:
                    secret = ""
                    secret_ok = False
            item = {
                "id": row["id"],
                "title": row["title"],
                "username": row["username"],
                "secret": secret,
                "secret_ok": secret_ok,
                "comment": row["comment"],
                "url": row["url"],
                "kind": row["kind"],
                "x": row["x"],
                "y": row["y"],
                "tag_ids": tag_map.get(row["id"], []),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "deleted_at": row["deleted_at"],
                "trash_touched_at": row["trash_touched_at"],
            }
            if row["deleted_at"]:
                self.trash_entries[row["id"]] = item
            else:
                self.entries[row["id"]] = item

        self.links = {
            row["id"]: {"id": row["id"], "a": row["a"], "b": row["b"]}
            for row in self.conn.execute("SELECT * FROM links")
        }
        self.labels = {}
        self.trash_labels = {}
        for row in self.conn.execute("SELECT * FROM labels"):
            item = {
                "id": row["id"],
                "text": row["text"],
                "x": row["x"],
                "y": row["y"],
                "w": row["w"],
                "h": row["h"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "deleted_at": row["deleted_at"],
                "trash_touched_at": row["trash_touched_at"],
            }
            if row["deleted_at"]:
                self.trash_labels[row["id"]] = item
            else:
                self.labels[row["id"]] = item

        self.notes = {}
        self.trash_notes = {}
        for row in self.conn.execute("SELECT * FROM notes"):
            body = empty_note_body()
            body_ok = True
            blob = row["body"]
            if blob:
                try:
                    body = normalize_body(decrypt(self.key, blob))
                except Exception:
                    body = empty_note_body()
                    body_ok = False
            item = {
                "id": row["id"],
                "title": row["title"],
                "kind": row["kind"] if row["kind"] in NOTE_KINDS else "page",
                "parent_id": row["parent_id"],
                "sort": row["sort"],
                "body": body,
                "body_ok": body_ok,
                "plain": body_to_plain(body),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "deleted_at": row["deleted_at"],
                "trash_touched_at": row["trash_touched_at"],
            }
            if row["deleted_at"]:
                self.trash_notes[row["id"]] = item
            else:
                self.notes[row["id"]] = item

    def snapshot(self) -> dict:
        with self.lock:
            entries = sorted(self.entries.values(), key=lambda e: e["created_at"])
            tags = sorted(self.tags.values(), key=lambda t: (t["sort"], t["name"]))
            links = [
                dict(link) for link in self.links.values()
                if link["a"] in self.entries and link["b"] in self.entries
            ]
            labels = sorted(self.labels.values(), key=lambda item: item["created_at"])
            notes = sorted(
                self.notes.values(),
                key=lambda item: (item["parent_id"] or "", item["sort"], item["created_at"]),
            )
            return {
                "entries": [self._public_entry(e) for e in entries],
                "links": links,
                "tags": [dict(t) for t in tags],
                "labels": [self._public_label(item) for item in labels],
                "notes": [self._public_note(item) for item in notes],
                "trash_count": (
                    len(self.trash_entries) + len(self.trash_labels) + len(self.trash_notes)
                ),
            }

    def _public_entry(self, entry: dict) -> dict:
        return {
            "id": entry["id"],
            "title": entry["title"],
            "username": entry["username"],
            "secret": entry["secret"],
            "secret_ok": entry["secret_ok"],
            "comment": entry["comment"],
            "url": entry["url"],
            "kind": entry["kind"],
            "x": entry["x"],
            "y": entry["y"],
            "tag_ids": list(entry["tag_ids"]),
            "created_at": entry["created_at"],
            "updated_at": entry["updated_at"],
        }

    def _public_label(self, label: dict) -> dict:
        return {
            "id": label["id"],
            "text": label["text"],
            "x": label["x"],
            "y": label["y"],
            "w": label["w"],
            "h": label["h"],
            "created_at": label["created_at"],
            "updated_at": label["updated_at"],
        }

    def _public_note(self, note: dict) -> dict:
        return {
            "id": note["id"],
            "title": note["title"],
            "kind": note["kind"],
            "parent_id": note["parent_id"],
            "sort": note["sort"],
            "body": note["body"],
            "body_ok": note["body_ok"],
            "created_at": note["created_at"],
            "updated_at": note["updated_at"],
        }

    def _trash_item(self, kind: str, item: dict) -> dict:
        deleted = item["deleted_at"]
        touched = item.get("trash_touched_at") or deleted
        base = {
            "id": item["id"],
            "kind": kind,
            "deleted_at": deleted,
            "trash_touched_at": touched,
            "expires_at": trash_expires_at(touched),
            "days_left": trash_days_left(deleted, touched),
        }
        if kind == "entry":
            base.update({
                "title": item["title"],
                "entry_kind": item["kind"],
                "username": item["username"],
            })
        elif kind == "label":
            base.update({"title": (item["text"] or "Лейбл").strip() or "Лейбл"})
        else:
            base.update({
                "title": item["title"],
                "note_kind": item["kind"],
                "parent_id": item["parent_id"],
            })
        return base

    def create_entry(self, data: dict) -> dict:
        with self.lock:
            self._require()
            kind = data.get("kind") or "web"
            if kind not in KINDS:
                raise ValueError("неизвестный тип")
            title = (data.get("title") or "").strip()
            if not title:
                raise ValueError("нужно отображаемое имя")
            entry_id = str(uuid.uuid4())
            stamp = now()
            secret = data.get("secret") or ""
            assert self.key is not None and self.conn is not None
            blob = encrypt(self.key, secret)
            tag_ids = self._known_tags(data.get("tag_ids") or [])
            with self.conn:
                self.conn.execute(
                    """
                    INSERT INTO entries (
                        id, title, username, secret, comment, url, kind, x, y, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry_id,
                        title,
                        data.get("username") or "",
                        blob,
                        (data.get("comment") or "").strip(),
                        (data.get("url") or "").strip(),
                        kind,
                        float(data.get("x") or 0),
                        float(data.get("y") or 0),
                        stamp,
                        stamp,
                    ),
                )
                for tag_id in tag_ids:
                    self.conn.execute(
                        "INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)",
                        (entry_id, tag_id),
                    )
            entry = {
                "id": entry_id,
                "title": title,
                "username": data.get("username") or "",
                "secret": secret,
                "secret_ok": True,
                "comment": (data.get("comment") or "").strip(),
                "url": (data.get("url") or "").strip(),
                "kind": kind,
                "x": float(data.get("x") or 0),
                "y": float(data.get("y") or 0),
                "tag_ids": tag_ids,
                "created_at": stamp,
                "updated_at": stamp,
                "deleted_at": None,
                "trash_touched_at": None,
            }
            self.entries[entry_id] = entry
            return self._public_entry(entry)

    def update_entry(self, entry_id: str, data: dict) -> dict:
        with self.lock:
            self._require()
            entry = self.entries.get(entry_id)
            if entry is None:
                raise KeyError(entry_id)
            assert self.conn is not None and self.key is not None
            fields: list[str] = []
            values: list[object] = []

            if "title" in data and data["title"] is not None:
                title = data["title"].strip()
                if not title:
                    raise ValueError("нужно отображаемое имя")
                fields.append("title=?")
                values.append(title)
                entry["title"] = title
            if "username" in data and data["username"] is not None:
                fields.append("username=?")
                values.append(data["username"])
                entry["username"] = data["username"]
            if "comment" in data and data["comment"] is not None:
                comment = data["comment"].strip()
                fields.append("comment=?")
                values.append(comment)
                entry["comment"] = comment
            if "url" in data and data["url"] is not None:
                url = data["url"].strip()
                fields.append("url=?")
                values.append(url)
                entry["url"] = url
            if "kind" in data and data["kind"] is not None:
                if data["kind"] not in KINDS:
                    raise ValueError("неизвестный тип")
                fields.append("kind=?")
                values.append(data["kind"])
                entry["kind"] = data["kind"]
            if "secret" in data and data["secret"] is not None:
                fields.append("secret=?")
                values.append(encrypt(self.key, data["secret"]))
                entry["secret"] = data["secret"]
                entry["secret_ok"] = True

            stamp = now()
            if fields:
                fields.append("updated_at=?")
                values.append(stamp)
                values.append(entry_id)
                with self.conn:
                    self.conn.execute(
                        f"UPDATE entries SET {', '.join(fields)} WHERE id=?",
                        values,
                    )
                entry["updated_at"] = stamp

            if "tag_ids" in data and data["tag_ids"] is not None:
                tag_ids = self._known_tags(data["tag_ids"])
                with self.conn:
                    self.conn.execute("DELETE FROM entry_tags WHERE entry_id=?", (entry_id,))
                    for tag_id in tag_ids:
                        self.conn.execute(
                            "INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)",
                            (entry_id, tag_id),
                        )
                    self.conn.execute(
                        "UPDATE entries SET updated_at=? WHERE id=?",
                        (stamp, entry_id),
                    )
                entry["tag_ids"] = tag_ids
                entry["updated_at"] = stamp

            return self._public_entry(entry)

    def delete_entry(self, entry_id: str) -> None:
        with self.lock:
            self._require()
            entry = self.entries.get(entry_id)
            if entry is None:
                raise KeyError(entry_id)
            assert self.conn is not None
            stamp = now()
            with self.conn:
                self.conn.execute(
                    "UPDATE entries SET deleted_at=?, trash_touched_at=?, updated_at=? WHERE id=?",
                    (stamp, stamp, stamp, entry_id),
                )
            entry["deleted_at"] = stamp
            entry["trash_touched_at"] = stamp
            entry["updated_at"] = stamp
            self.trash_entries[entry_id] = entry
            del self.entries[entry_id]

    def update_positions(self, positions: list[dict]) -> None:
        with self.lock:
            self._require()
            assert self.conn is not None
            stamp = now()
            with self.conn:
                for item in positions:
                    entry = self.entries.get(item["id"])
                    if entry is None:
                        continue
                    self.conn.execute(
                        "UPDATE entries SET x=?, y=?, updated_at=? WHERE id=?",
                        (item["x"], item["y"], stamp, item["id"]),
                    )
                    entry["x"] = item["x"]
                    entry["y"] = item["y"]
                    entry["updated_at"] = stamp

    def create_link(self, a: str, b: str) -> dict:
        with self.lock:
            self._require()
            if a == b or a not in self.entries or b not in self.entries:
                raise ValueError("нечего связывать")
            left, right = (a, b) if a < b else (b, a)
            for link in self.links.values():
                if link["a"] == left and link["b"] == right:
                    return {**link, "created": False}
            link_id = str(uuid.uuid4())
            assert self.conn is not None
            with self.conn:
                self.conn.execute(
                    "INSERT INTO links (id, a, b) VALUES (?, ?, ?)",
                    (link_id, left, right),
                )
            link = {"id": link_id, "a": left, "b": right}
            self.links[link_id] = link
            return {**link, "created": True}

    def delete_link(self, link_id: str) -> None:
        with self.lock:
            self._require()
            if link_id not in self.links:
                raise KeyError(link_id)
            assert self.conn is not None
            with self.conn:
                self.conn.execute("DELETE FROM links WHERE id=?", (link_id,))
            del self.links[link_id]

    def create_label(self, data: dict) -> dict:
        with self.lock:
            self._require()
            assert self.conn is not None
            label_id = str(uuid.uuid4())
            stamp = now()
            label = {
                "id": label_id,
                "text": data.get("text") or "",
                "x": float(data.get("x") or 0),
                "y": float(data.get("y") or 0),
                "w": float(data.get("w") or 320),
                "h": float(data.get("h") or 88),
                "created_at": stamp,
                "updated_at": stamp,
                "deleted_at": None,
                "trash_touched_at": None,
            }
            with self.conn:
                self.conn.execute(
                    """
                    INSERT INTO labels (id, text, x, y, w, h, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        label["id"], label["text"], label["x"], label["y"],
                        label["w"], label["h"], stamp, stamp,
                    ),
                )
            self.labels[label_id] = label
            return self._public_label(label)

    def update_label(self, label_id: str, data: dict) -> dict:
        with self.lock:
            self._require()
            label = self.labels.get(label_id)
            if label is None:
                raise KeyError(label_id)
            assert self.conn is not None
            fields: list[str] = []
            values: list[object] = []
            if "text" in data and data["text"] is not None:
                fields.append("text=?")
                values.append(data["text"])
                label["text"] = data["text"]
            for key in ("x", "y", "w", "h"):
                if key in data and data[key] is not None:
                    fields.append(f"{key}=?")
                    values.append(float(data[key]))
                    label[key] = float(data[key])
            if fields:
                stamp = now()
                fields.append("updated_at=?")
                values.append(stamp)
                values.append(label_id)
                with self.conn:
                    self.conn.execute(
                        f"UPDATE labels SET {', '.join(fields)} WHERE id=?",
                        values,
                    )
                label["updated_at"] = stamp
            return self._public_label(label)

    def delete_label(self, label_id: str) -> None:
        with self.lock:
            self._require()
            label = self.labels.get(label_id)
            if label is None:
                raise KeyError(label_id)
            assert self.conn is not None
            stamp = now()
            with self.conn:
                self.conn.execute(
                    "UPDATE labels SET deleted_at=?, trash_touched_at=?, updated_at=? WHERE id=?",
                    (stamp, stamp, stamp, label_id),
                )
            label["deleted_at"] = stamp
            label["trash_touched_at"] = stamp
            label["updated_at"] = stamp
            self.trash_labels[label_id] = label
            del self.labels[label_id]

    def create_note(self, data: dict) -> dict:
        with self.lock:
            self._require()
            assert self.conn is not None and self.key is not None
            kind = data.get("kind") or "page"
            if kind not in NOTE_KINDS:
                raise ValueError("неизвестный тип заметки")
            parent_id = data.get("parent_id")
            if parent_id:
                parent = self.notes.get(parent_id)
                if parent is None:
                    raise ValueError("нет родителя")
                if parent["kind"] != "folder":
                    raise ValueError("родитель должен быть папкой")
            title = (data.get("title") or "").strip() or ("Папка" if kind == "folder" else "Без названия")
            if len(title) > 200:
                raise ValueError("слишком длинное название")
            body = empty_note_body() if kind == "folder" else normalize_body(data.get("body"))
            note_id = str(uuid.uuid4())
            stamp = now()
            sort = data.get("sort")
            if sort is None:
                sort = self._next_note_sort(parent_id)
            blob = encrypt(self.key, json.dumps(body, ensure_ascii=False))
            with self.conn:
                self.conn.execute(
                    """
                    INSERT INTO notes (id, title, kind, parent_id, sort, body, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (note_id, title, kind, parent_id, int(sort), blob, stamp, stamp),
                )
            note = {
                "id": note_id,
                "title": title,
                "kind": kind,
                "parent_id": parent_id,
                "sort": int(sort),
                "body": body,
                "body_ok": True,
                "plain": body_to_plain(body),
                "created_at": stamp,
                "updated_at": stamp,
                "deleted_at": None,
                "trash_touched_at": None,
            }
            self.notes[note_id] = note
            return self._public_note(note)

    def update_note(self, note_id: str, data: dict) -> dict:
        with self.lock:
            self._require()
            note = self.notes.get(note_id)
            if note is None:
                raise KeyError(note_id)
            assert self.conn is not None and self.key is not None
            fields: list[str] = []
            values: list[object] = []

            if "title" in data and data["title"] is not None:
                title = data["title"].strip() or ("Папка" if note["kind"] == "folder" else "Без названия")
                if len(title) > 200:
                    raise ValueError("слишком длинное название")
                fields.append("title=?")
                values.append(title)
                note["title"] = title

            if "body" in data and data["body"] is not None:
                if note["kind"] == "folder":
                    raise ValueError("у папки нет текста")
                body = normalize_body(data["body"])
                fields.append("body=?")
                values.append(encrypt(self.key, json.dumps(body, ensure_ascii=False)))
                note["body"] = body
                note["body_ok"] = True
                note["plain"] = body_to_plain(body)

            if "parent_id" in data:
                parent_id = data["parent_id"]
                if parent_id == note_id:
                    raise ValueError("нельзя вложить в себя")
                if parent_id:
                    parent = self.notes.get(parent_id)
                    if parent is None:
                        raise ValueError("нет родителя")
                    if parent["kind"] != "folder":
                        raise ValueError("родитель должен быть папкой")
                    if self._is_descendant(parent_id, note_id):
                        raise ValueError("цикл в иерархии")
                fields.append("parent_id=?")
                values.append(parent_id)
                note["parent_id"] = parent_id

            if "sort" in data and data["sort"] is not None:
                fields.append("sort=?")
                values.append(int(data["sort"]))
                note["sort"] = int(data["sort"])

            if fields:
                stamp = now()
                fields.append("updated_at=?")
                values.append(stamp)
                values.append(note_id)
                with self.conn:
                    self.conn.execute(
                        f"UPDATE notes SET {', '.join(fields)} WHERE id=?",
                        values,
                    )
                note["updated_at"] = stamp
            return self._public_note(note)

    def delete_note(self, note_id: str) -> None:
        with self.lock:
            self._require()
            if note_id not in self.notes:
                raise KeyError(note_id)
            assert self.conn is not None
            doomed = self._collect_descendants(note_id)
            doomed.add(note_id)
            stamp = now()
            with self.conn:
                for item_id in doomed:
                    self.conn.execute(
                        "UPDATE notes SET deleted_at=?, trash_touched_at=?, updated_at=? WHERE id=?",
                        (stamp, stamp, stamp, item_id),
                    )
            for item_id in doomed:
                note = self.notes.pop(item_id, None)
                if note is None:
                    continue
                note["deleted_at"] = stamp
                note["trash_touched_at"] = stamp
                note["updated_at"] = stamp
                self.trash_notes[item_id] = note

    def drop_note_on_note(self, dragged_id: str, target_id: str) -> dict:
        with self.lock:
            self._require()
            if dragged_id == target_id:
                raise ValueError("нечего переносить")
            dragged = self.notes.get(dragged_id)
            target = self.notes.get(target_id)
            if dragged is None or target is None:
                raise KeyError("нет такой статьи")
            assert self.conn is not None and self.key is not None

            if target["kind"] == "folder":
                if self._is_descendant(target_id, dragged_id):
                    raise ValueError("цикл в иерархии")
                sort = self._next_note_sort(target_id)
                stamp = now()
                with self.conn:
                    self.conn.execute(
                        "UPDATE notes SET parent_id=?, sort=?, updated_at=? WHERE id=?",
                        (target_id, sort, stamp, dragged_id),
                    )
                dragged["parent_id"] = target_id
                dragged["sort"] = sort
                dragged["updated_at"] = stamp
                return {
                    "mode": "nest",
                    "folder": None,
                    "notes": [self._public_note(dragged), self._public_note(target)],
                }

            if dragged["kind"] == "folder":
                if self._is_descendant(dragged_id, target_id):
                    raise ValueError("цикл в иерархии")
                sort = self._next_note_sort(dragged_id)
                stamp = now()
                with self.conn:
                    self.conn.execute(
                        "UPDATE notes SET parent_id=?, sort=?, updated_at=? WHERE id=?",
                        (dragged_id, sort, stamp, target_id),
                    )
                target["parent_id"] = dragged_id
                target["sort"] = sort
                target["updated_at"] = stamp
                return {
                    "mode": "nest",
                    "folder": None,
                    "notes": [self._public_note(dragged), self._public_note(target)],
                }

            # статья на статью → новая папка с обеими внутри
            parent_id = target["parent_id"]
            folder_sort = target["sort"]
            folder_id = str(uuid.uuid4())
            stamp = now()
            folder_body = empty_note_body()
            folder_blob = encrypt(self.key, json.dumps(folder_body, ensure_ascii=False))
            folder_title = (target["title"] or "Папка").strip() or "Папка"
            with self.conn:
                self.conn.execute(
                    """
                    INSERT INTO notes (id, title, kind, parent_id, sort, body, created_at, updated_at)
                    VALUES (?, ?, 'folder', ?, ?, ?, ?, ?)
                    """,
                    (folder_id, folder_title, parent_id, folder_sort, folder_blob, stamp, stamp),
                )
                self.conn.execute(
                    "UPDATE notes SET parent_id=?, sort=?, updated_at=? WHERE id=?",
                    (folder_id, 0, stamp, target_id),
                )
                self.conn.execute(
                    "UPDATE notes SET parent_id=?, sort=?, updated_at=? WHERE id=?",
                    (folder_id, 1, stamp, dragged_id),
                )
            folder = {
                "id": folder_id,
                "title": folder_title,
                "kind": "folder",
                "parent_id": parent_id,
                "sort": folder_sort,
                "body": folder_body,
                "body_ok": True,
                "plain": "",
                "created_at": stamp,
                "updated_at": stamp,
                "deleted_at": None,
                "trash_touched_at": None,
            }
            self.notes[folder_id] = folder
            target["parent_id"] = folder_id
            target["sort"] = 0
            target["updated_at"] = stamp
            dragged["parent_id"] = folder_id
            dragged["sort"] = 1
            dragged["updated_at"] = stamp
            return {
                "mode": "folder",
                "folder": self._public_note(folder),
                "notes": [self._public_note(target), self._public_note(dragged)],
            }

    def reorder_notes(self, items: list[dict]) -> list[dict]:
        with self.lock:
            self._require()
            assert self.conn is not None
            stamp = now()
            changed: list[dict] = []
            with self.conn:
                for item in items:
                    note = self.notes.get(item["id"])
                    if note is None:
                        continue
                    parent_id = item.get("parent_id", note["parent_id"])
                    if parent_id == note["id"]:
                        raise ValueError("нельзя вложить в себя")
                    if parent_id:
                        parent = self.notes.get(parent_id)
                        if parent is None or parent["kind"] != "folder":
                            raise ValueError("родитель должен быть папкой")
                        if self._is_descendant(parent_id, note["id"]):
                            raise ValueError("цикл в иерархии")
                    sort = int(item.get("sort", note["sort"]))
                    self.conn.execute(
                        "UPDATE notes SET parent_id=?, sort=?, updated_at=? WHERE id=?",
                        (parent_id, sort, stamp, note["id"]),
                    )
                    note["parent_id"] = parent_id
                    note["sort"] = sort
                    note["updated_at"] = stamp
                    changed.append(self._public_note(note))
            return changed

    def _next_note_sort(self, parent_id: str | None) -> int:
        siblings = [
            note["sort"] for note in self.notes.values()
            if note["parent_id"] == parent_id
        ]
        return (max(siblings) + 1) if siblings else 0

    def _is_descendant(self, maybe_child: str, ancestor: str) -> bool:
        current = self.notes.get(maybe_child)
        seen: set[str] = set()
        while current and current["parent_id"]:
            parent_id = current["parent_id"]
            if parent_id == ancestor:
                return True
            if parent_id in seen:
                break
            seen.add(parent_id)
            current = self.notes.get(parent_id)
        return False

    def _collect_descendants(self, note_id: str) -> set[str]:
        found: set[str] = set()
        stack = [note_id]
        while stack:
            current = stack.pop()
            for note in self.notes.values():
                if note["parent_id"] == current and note["id"] not in found:
                    found.add(note["id"])
                    stack.append(note["id"])
        return found

    def list_trash(self) -> list[dict]:
        with self.lock:
            items = (
                [self._trash_item("entry", item) for item in self.trash_entries.values()]
                + [self._trash_item("label", item) for item in self.trash_labels.values()]
                + [self._trash_item("note", item) for item in self.trash_notes.values()]
            )
            items.sort(key=lambda item: item["deleted_at"] or "", reverse=True)
            return items

    def touch_trash(self, kind: str, item_id: str) -> dict:
        with self.lock:
            self._require()
            item, table, bucket = self._trash_bucket(kind, item_id)
            stamp = now()
            assert self.conn is not None
            with self.conn:
                self.conn.execute(
                    f"UPDATE {table} SET trash_touched_at=?, updated_at=? WHERE id=?",
                    (stamp, stamp, item_id),
                )
            item["trash_touched_at"] = stamp
            item["updated_at"] = stamp
            return self._trash_item(kind, item)

    def restore_trash(self, kind: str, item_id: str) -> dict:
        with self.lock:
            self._require()
            assert self.conn is not None
            if kind == "entry":
                item = self.trash_entries.get(item_id)
                if item is None:
                    raise KeyError(item_id)
                with self.conn:
                    self.conn.execute(
                        "UPDATE entries SET deleted_at=NULL, trash_touched_at=NULL, updated_at=? WHERE id=?",
                        (now(), item_id),
                    )
                item["deleted_at"] = None
                item["trash_touched_at"] = None
                self.entries[item_id] = item
                del self.trash_entries[item_id]
                return {"kind": "entry", "item": self._public_entry(item)}

            if kind == "label":
                item = self.trash_labels.get(item_id)
                if item is None:
                    raise KeyError(item_id)
                with self.conn:
                    self.conn.execute(
                        "UPDATE labels SET deleted_at=NULL, trash_touched_at=NULL, updated_at=? WHERE id=?",
                        (now(), item_id),
                    )
                item["deleted_at"] = None
                item["trash_touched_at"] = None
                self.labels[item_id] = item
                del self.trash_labels[item_id]
                return {"kind": "label", "item": self._public_label(item)}

            if kind != "note":
                raise ValueError("неизвестный тип")
            item = self.trash_notes.get(item_id)
            if item is None:
                raise KeyError(item_id)
            restore_ids = {item_id}
            if item["kind"] == "folder":
                restore_ids |= self._collect_trash_descendants(item_id)
            stamp = now()
            restored: list[dict] = []
            with self.conn:
                for nid in restore_ids:
                    note = self.trash_notes.get(nid)
                    if note is None:
                        continue
                    parent_id = note["parent_id"]
                    if parent_id and parent_id not in self.notes and parent_id not in restore_ids:
                        parent_id = None
                    self.conn.execute(
                        """
                        UPDATE notes
                        SET deleted_at=NULL, trash_touched_at=NULL, parent_id=?, updated_at=?
                        WHERE id=?
                        """,
                        (parent_id, stamp, nid),
                    )
                    note["deleted_at"] = None
                    note["trash_touched_at"] = None
                    note["parent_id"] = parent_id
                    note["updated_at"] = stamp
                    self.notes[nid] = note
                    del self.trash_notes[nid]
                    restored.append(self._public_note(note))
            return {"kind": "note", "items": restored}

    def purge_trash_item(self, kind: str, item_id: str) -> None:
        with self.lock:
            self._require()
            assert self.conn is not None
            if kind == "entry":
                if item_id not in self.trash_entries:
                    raise KeyError(item_id)
                with self.conn:
                    self.conn.execute("DELETE FROM entries WHERE id=?", (item_id,))
                del self.trash_entries[item_id]
                self.links = {
                    lid: link for lid, link in self.links.items()
                    if link["a"] != item_id and link["b"] != item_id
                }
                return
            if kind == "label":
                if item_id not in self.trash_labels:
                    raise KeyError(item_id)
                with self.conn:
                    self.conn.execute("DELETE FROM labels WHERE id=?", (item_id,))
                del self.trash_labels[item_id]
                return
            if kind != "note":
                raise ValueError("неизвестный тип")
            if item_id not in self.trash_notes:
                raise KeyError(item_id)
            doomed = self._collect_trash_descendants(item_id)
            doomed.add(item_id)
            with self.conn:
                self.conn.execute("DELETE FROM notes WHERE id=?", (item_id,))
            for nid in doomed:
                self.trash_notes.pop(nid, None)

    def empty_trash(self) -> int:
        with self.lock:
            self._require()
            assert self.conn is not None
            count = len(self.trash_entries) + len(self.trash_labels) + len(self.trash_notes)
            with self.conn:
                self.conn.execute("DELETE FROM entries WHERE deleted_at IS NOT NULL")
                self.conn.execute("DELETE FROM labels WHERE deleted_at IS NOT NULL")
                self.conn.execute("DELETE FROM notes WHERE deleted_at IS NOT NULL")
            self.links = {
                lid: link for lid, link in self.links.items()
                if link["a"] in self.entries and link["b"] in self.entries
            }
            self.trash_entries.clear()
            self.trash_labels.clear()
            self.trash_notes.clear()
            return count

    def _trash_bucket(self, kind: str, item_id: str):
        if kind == "entry":
            item = self.trash_entries.get(item_id)
            if item is None:
                raise KeyError(item_id)
            return item, "entries", self.trash_entries
        if kind == "label":
            item = self.trash_labels.get(item_id)
            if item is None:
                raise KeyError(item_id)
            return item, "labels", self.trash_labels
        if kind == "note":
            item = self.trash_notes.get(item_id)
            if item is None:
                raise KeyError(item_id)
            return item, "notes", self.trash_notes
        raise ValueError("неизвестный тип")

    def _collect_trash_descendants(self, note_id: str) -> set[str]:
        found: set[str] = set()
        stack = [note_id]
        while stack:
            current = stack.pop()
            for note in self.trash_notes.values():
                if note["parent_id"] == current and note["id"] not in found:
                    found.add(note["id"])
                    stack.append(note["id"])
        return found

    def create_tag(self, name: str) -> dict:
        with self.lock:
            self._require()
            cleaned = name.strip()
            if not cleaned:
                raise ValueError("пустое имя метки")
            if len(cleaned) > 40:
                raise ValueError("слишком длинная метка")
            for tag in self.tags.values():
                if tag["name"].casefold() == cleaned.casefold():
                    return dict(tag)
            assert self.conn is not None
            sort = max((tag["sort"] for tag in self.tags.values()), default=-1) + 1
            tag = {
                "id": str(uuid.uuid4()),
                "name": cleaned,
                "color": PALETTE[len(self.tags) % len(PALETTE)],
                "sort": sort,
            }
            with self.conn:
                self.conn.execute(
                    "INSERT INTO tags (id, name, color, sort) VALUES (?, ?, ?, ?)",
                    (tag["id"], tag["name"], tag["color"], tag["sort"]),
                )
            self.tags[tag["id"]] = tag
            return dict(tag)

    def _known_tags(self, tag_ids: list[str]) -> list[str]:
        seen: list[str] = []
        for tag_id in tag_ids:
            if tag_id in self.tags and tag_id not in seen:
                seen.append(tag_id)
        return seen

    def _require(self) -> None:
        if self.conn is None or self.key is None:
            raise RuntimeError("база не открыта")
