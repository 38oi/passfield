"use strict";

const TrashUI = (() => {
  let api = null;
  let notify = null;
  let ask = null;
  let onChange = null;
  let items = [];

  function bind(opts) {
    api = opts.api;
    notify = opts.notify;
    ask = opts.ask;
    onChange = opts.onChange || (() => {});
    document.getElementById("trash-open").addEventListener("click", open);
    document.getElementById("trash-close").addEventListener("click", close);
    document.getElementById("trash").addEventListener("click", (event) => {
      if (event.target.id === "trash") close();
    });
    document.getElementById("trash-empty").addEventListener("click", emptyAll);
    document.getElementById("trash-list").addEventListener("click", onListClick);
  }

  function setCount(count) {
    const badge = document.getElementById("trash-badge");
    if (!count) {
      badge.hidden = true;
      badge.textContent = "0";
      return;
    }
    badge.hidden = false;
    badge.textContent = count > 99 ? "99+" : String(count);
  }

  async function open() {
    document.getElementById("trash").hidden = false;
    await refresh();
  }

  function close() {
    document.getElementById("trash").hidden = true;
  }

  async function refresh() {
    const list = document.getElementById("trash-list");
    list.innerHTML = `<div class="trash-empty">Загружаю…</div>`;
    try {
      const data = await api("/api/trash");
      items = data.items || [];
      setCount(items.length);
      renderList();
      onChange(items.length);
    } catch (err) {
      list.innerHTML = `<div class="trash-empty">${esc(err.message || "Не открылась")}</div>`;
    }
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function kindLabel(item) {
    if (item.kind === "entry") return "Пароль";
    if (item.kind === "label") return "Лейбл";
    return item.note_kind === "folder" ? "Папка" : "Статья";
  }

  function renderList() {
    const list = document.getElementById("trash-list");
    if (!items.length) {
      list.innerHTML = `<div class="trash-empty">Корзина пуста</div>`;
      return;
    }
    list.replaceChildren();
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "trash-item";
      row.dataset.kind = item.kind;
      row.dataset.id = item.id;
      const days = item.days_left;
      const ttl = days <= 0
        ? "скоро удалится"
        : days === 1
          ? "остался 1 день"
          : `осталось ${days} дн.`;
      const kindIcon = item.kind === "entry" ? "key-round" : item.kind === "label" ? "type" : (item.note_kind === "folder" ? "folder" : "file-text");
      row.innerHTML = `
        <div class="meta">
          <span class="kind">${Icons.html(kindIcon, "ico")} ${esc(kindLabel(item))}</span>
          <span class="title">${esc(item.title || "Без названия")}</span>
          <span class="ttl">${esc(ttl)}</span>
        </div>
        <div class="actions">
          <button type="button" class="restore" data-act="restore">${Icons.html("rotate-ccw", "ico")} Вернуть</button>
          <button type="button" class="purge" data-act="purge">${Icons.html("trash-2", "ico")} Удалить</button>
        </div>
      `;
      list.append(row);
    }
  }

  async function onListClick(event) {
    const button = event.target.closest("button[data-act]");
    const row = event.target.closest(".trash-item");
    if (!button || !row) return;
    const kind = row.dataset.kind;
    const id = row.dataset.id;
    if (button.dataset.act === "restore") {
      try {
        const result = await api(`/api/trash/${kind}/${id}/restore`, { method: "POST" });
        notify("Вернул");
        await refresh();
        onChange(items.length, { restored: result });
      } catch (err) {
        notify(err.message || "Не вернулось");
      }
      return;
    }
    const ok = await ask({
      title: "Удалить навсегда?",
      body: "Восстановить уже не получится.",
      ok: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/trash/${kind}/${id}`, { method: "DELETE" });
      notify("Удалено навсегда");
      await refresh();
      onChange(items.length);
    } catch (err) {
      notify(err.message || "Не удалилось");
    }
  }

  async function emptyAll() {
    if (!items.length) return;
    const ok = await ask({
      title: "Очистить корзину?",
      body: `Навсегда удалится элементов: ${items.length}.`,
      ok: "Очистить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/trash", { method: "DELETE" });
      notify("Корзина очищена");
      await refresh();
      onChange(0);
    } catch (err) {
      notify(err.message || "Не очистилась");
    }
  }

  return { bind, open, close, setCount, refresh };
})();
