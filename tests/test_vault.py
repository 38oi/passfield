import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient


class VaultApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        key = root / "key"
        key.write_bytes(b"not-a-real-ssh-key-just-test-material")
        os.environ["PASSMANAGER_KEY"] = str(key)
        os.environ["PASSMANAGER_DB"] = str(root / "vault.db")
        from app.main import app

        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_secret_is_encrypted_and_comment_is_kept(self):
        created = self.client.post("/api/entries", json={
            "title": "  Прод шлюз  ",
            "secret": "s3cr3t-value",
            "comment": "  заходить через vpn  ",
            "username": "root",
            "kind": "ssh",
            "x": 12,
            "y": 34,
        })
        self.assertEqual(created.status_code, 201, created.text)
        body = created.json()
        self.assertEqual(body["title"], "Прод шлюз")
        self.assertEqual(body["comment"], "заходить через vpn")
        self.assertEqual(body["secret"], "s3cr3t-value")

        from app.main import vault

        with vault.lock:
            vault.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        raw = Path(os.environ["PASSMANAGER_DB"]).read_bytes()
        self.assertNotIn(b"s3cr3t-value", raw)
        self.assertIn("Прод шлюз".encode(), raw)
        self.assertIn("заходить через vpn".encode(), raw)

        again = self.client.get("/api/bootstrap")
        self.assertEqual(again.status_code, 200)
        entry = again.json()["entries"][0]
        self.assertEqual(entry["secret"], "s3cr3t-value")
        self.assertEqual(entry["comment"], "заходить через vpn")
        self.assertTrue(entry["secret_ok"])

    def test_display_name_is_required(self):
        empty = self.client.post("/api/entries", json={"title": "   ", "secret": "x"})
        self.assertEqual(empty.status_code, 422)
        self.assertEqual(empty.json()["detail"], "нужно отображаемое имя")

        created = self.client.post("/api/entries", json={"title": "Почта", "secret": "a"})
        self.assertEqual(created.status_code, 201)
        entry_id = created.json()["id"]
        cleared = self.client.patch(f"/api/entries/{entry_id}", json={"title": "  "})
        self.assertEqual(cleared.status_code, 422)

    def test_links_positions_and_tags(self):
        tags = self.client.get("/api/bootstrap").json()["tags"]
        self.assertEqual([tag["name"] for tag in tags], ["Pedant", "Аутсорс", "Фриланс", "Личное"])
        personal = next(tag for tag in tags if tag["name"] == "Личное")

        first = self.client.post("/api/entries", json={
            "title": "А",
            "secret": "one",
            "x": 0,
            "y": 0,
            "tag_ids": [personal["id"]],
        }).json()
        second = self.client.post("/api/entries", json={
            "title": "Б",
            "secret": "two",
            "comment": "второй",
            "x": 400,
            "y": 0,
        }).json()

        linked = self.client.post("/api/links", json={"a": first["id"], "b": second["id"]})
        self.assertEqual(linked.status_code, 200, linked.text)
        self.assertTrue(linked.json()["created"])
        again = self.client.post("/api/links", json={"a": second["id"], "b": first["id"]})
        self.assertFalse(again.json()["created"])

        moved = self.client.put("/api/positions", json={
            "positions": [
                {"id": first["id"], "x": 30.5, "y": -12},
                {"id": second["id"], "x": 480, "y": 20},
            ]
        })
        self.assertEqual(moved.status_code, 200)
        entries = {item["title"]: item for item in self.client.get("/api/bootstrap").json()["entries"]}
        self.assertEqual(entries["А"]["x"], 30.5)
        self.assertEqual(entries["А"]["y"], -12)
        self.assertEqual(entries["Б"]["comment"], "второй")
        self.assertEqual(entries["А"]["tag_ids"], [personal["id"]])
        self.assertEqual(len(self.client.get("/api/bootstrap").json()["links"]), 1)

        self.client.__exit__(None, None, None)
        self.client.__enter__()
        restored = {item["title"]: item for item in self.client.get("/api/bootstrap").json()["entries"]}
        self.assertEqual(restored["А"]["secret"], "one")
        self.assertEqual(restored["А"]["x"], 30.5)
        self.assertEqual(restored["Б"]["comment"], "второй")

    def test_labels_keep_text_and_size(self):
        entry = self.client.post("/api/entries", json={
            "title": "Секрет",
            "secret": "hidden-pass",
            "x": 10,
            "y": 10,
        })
        self.assertEqual(entry.status_code, 201, entry.text)

        created = self.client.post("/api/labels", json={
            "text": "Работа в Педанте",
            "x": 15,
            "y": 25,
            "w": 320,
            "h": 88,
        })
        self.assertEqual(created.status_code, 201, created.text)
        body = created.json()
        self.assertEqual(body["text"], "Работа в Педанте")
        self.assertNotIn("secret", body)
        label_id = body["id"]

        patched = self.client.patch(f"/api/labels/{label_id}", json={
            "text": "Проект Север",
            "x": 40,
            "y": -15,
            "w": 480,
            "h": 140,
        })
        self.assertEqual(patched.status_code, 200, patched.text)
        self.assertEqual(patched.json()["text"], "Проект Север")
        self.assertNotIn("secret", patched.json())

        too_small = self.client.patch(f"/api/labels/{label_id}", json={"w": 10, "h": 10})
        self.assertEqual(too_small.status_code, 422)

        from app.main import vault

        with vault.lock:
            vault.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        raw = Path(os.environ["PASSMANAGER_DB"]).read_bytes()
        self.assertIn("Проект Север".encode(), raw)
        self.assertNotIn(b"hidden-pass", raw)

        self.client.__exit__(None, None, None)
        self.client.__enter__()
        boot = self.client.get("/api/bootstrap").json()
        self.assertEqual(len(boot["labels"]), 1)
        self.assertEqual(len(boot["entries"]), 1)
        label = boot["labels"][0]
        self.assertEqual(label["text"], "Проект Север")
        self.assertEqual(label["x"], 40)
        self.assertEqual(label["y"], -15)
        self.assertEqual(label["w"], 480)
        self.assertEqual(label["h"], 140)
        self.assertEqual(boot["entries"][0]["secret"], "hidden-pass")
        self.assertNotIn("secret", label)

        missing = self.client.delete("/api/labels/nope")
        self.assertEqual(missing.status_code, 404)
        gone = self.client.delete(f"/api/labels/{label_id}")
        self.assertEqual(gone.status_code, 204)
        after = self.client.get("/api/bootstrap").json()
        self.assertEqual(after["labels"], [])
        self.assertEqual(after["entries"][0]["title"], "Секрет")

    def test_notes_are_encrypted_and_nest_into_folders(self):
        first = self.client.post("/api/notes", json={
            "title": "Деплой Pedant",
            "body": {
                "blocks": [
                    {"id": "1", "type": "p", "html": "Шаги установки"},
                    {"id": "2", "type": "code", "text": "systemctl restart nginx"},
                ]
            },
        })
        self.assertEqual(first.status_code, 201, first.text)
        page_a = first.json()
        self.assertEqual(page_a["title"], "Деплой Pedant")
        self.assertEqual(page_a["kind"], "page")
        self.assertEqual(page_a["body"]["blocks"][1]["text"], "systemctl restart nginx")

        second = self.client.post("/api/notes", json={"title": "Откат"}).json()
        dropped = self.client.post("/api/notes/drop", json={
            "dragged_id": second["id"],
            "target_id": page_a["id"],
        })
        self.assertEqual(dropped.status_code, 200, dropped.text)
        payload = dropped.json()
        self.assertEqual(payload["mode"], "folder")
        folder = payload["folder"]
        self.assertEqual(folder["kind"], "folder")
        self.assertEqual(folder["title"], "Деплой Pedant")

        from app.main import vault

        with vault.lock:
            vault.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        raw = Path(os.environ["PASSMANAGER_DB"]).read_bytes()
        self.assertIn("Деплой Pedant".encode(), raw)
        self.assertNotIn(b"systemctl restart nginx", raw)
        self.assertNotIn("Шаги установки".encode(), raw)

        nested = self.client.post("/api/notes", json={
            "title": "Внутри",
            "parent_id": folder["id"],
        })
        self.assertEqual(nested.status_code, 201, nested.text)

        under_page = self.client.post("/api/notes", json={
            "title": "ломаем",
            "parent_id": page_a["id"],
        })
        self.assertEqual(under_page.status_code, 400)

        self.client.__exit__(None, None, None)
        self.client.__enter__()
        boot = self.client.get("/api/bootstrap").json()
        notes = {item["id"]: item for item in boot["notes"]}
        self.assertEqual(notes[page_a["id"]]["parent_id"], folder["id"])
        self.assertEqual(notes[second["id"]]["parent_id"], folder["id"])
        self.assertEqual(notes[page_a["id"]]["body"]["blocks"][1]["text"], "systemctl restart nginx")
        self.assertTrue(notes[page_a["id"]]["body_ok"])

        child = next(item for item in payload["notes"] if item["id"] == second["id"])
        self.assertEqual(child["parent_id"], folder["id"])
        to_root = self.client.patch(f"/api/notes/{folder['id']}", json={"parent_id": None, "sort": 0})
        self.assertEqual(to_root.status_code, 200, to_root.text)
        self.assertIsNone(to_root.json()["parent_id"])

        gone = self.client.delete(f"/api/notes/{folder['id']}")
        self.assertEqual(gone.status_code, 204)
        left = self.client.get("/api/bootstrap").json()["notes"]
        self.assertEqual(left, [])
        trash = self.client.get("/api/trash").json()
        self.assertGreaterEqual(len(trash["items"]), 1)
        self.assertEqual(self.client.get("/api/bootstrap").json()["trash_count"], len(trash["items"]))

    def test_trash_restore_and_purge(self):
        entry = self.client.post("/api/entries", json={
            "title": "Временный",
            "secret": "temp-secret",
        }).json()
        note = self.client.post("/api/notes", json={"title": "Черновик"}).json()
        label = self.client.post("/api/labels", json={"text": "Зона"}).json()

        self.assertEqual(self.client.delete(f"/api/entries/{entry['id']}").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/notes/{note['id']}").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/labels/{label['id']}").status_code, 204)

        boot = self.client.get("/api/bootstrap").json()
        self.assertEqual(boot["entries"], [])
        self.assertEqual(boot["notes"], [])
        self.assertEqual(boot["labels"], [])
        self.assertEqual(boot["trash_count"], 3)

        trash = self.client.get("/api/trash").json()["items"]
        self.assertEqual(len(trash), 3)
        self.assertTrue(all(item["days_left"] >= 29 for item in trash))

        restored = self.client.post(f"/api/trash/entry/{entry['id']}/restore")
        self.assertEqual(restored.status_code, 200, restored.text)
        boot = self.client.get("/api/bootstrap").json()
        self.assertEqual(len(boot["entries"]), 1)
        self.assertEqual(boot["entries"][0]["secret"], "temp-secret")
        self.assertEqual(boot["trash_count"], 2)

        self.assertEqual(self.client.delete(f"/api/trash/note/{note['id']}").status_code, 204)
        self.assertEqual(self.client.delete("/api/trash").status_code, 200)
        boot = self.client.get("/api/bootstrap").json()
        self.assertEqual(boot["trash_count"], 0)
        self.assertEqual(len(boot["entries"]), 1)
        self.assertEqual(boot["labels"], [])
        self.assertEqual(boot["notes"], [])

    def test_lan_client_gate(self):
        from app import main as mainmod

        old = mainmod.LAN_MODE
        try:
            mainmod.LAN_MODE = True
            self.assertTrue(mainmod._client_allowed("192.168.0.20"))
            self.assertTrue(mainmod._client_allowed("10.0.0.5"))
            self.assertFalse(mainmod._client_allowed("8.8.8.8"))
            mainmod.LAN_MODE = False
            self.assertFalse(mainmod._client_allowed("192.168.0.20"))
            self.assertTrue(mainmod._client_allowed("127.0.0.1"))
        finally:
            mainmod.LAN_MODE = old


if __name__ == "__main__":
    unittest.main()
