"use strict";

const Notes = (() => {
  const expanded = new Set(loadExpanded());
  let openId = localStorage.getItem("pole.note") || null;
  let saveTimer = 0;
  let saveSeq = 0;
  let dragId = null;
  let blockDragId = null;
  let savedRange = null;
  let api = null;
  let notify = null;
  let getNotes = () => [];
  let setNotes = () => {};
  let onOpen = null;

  function loadExpanded() {
    try {
      const raw = JSON.parse(localStorage.getItem("pole.noteExpand") || "[]");
      return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
    } catch (err) {
      return [];
    }
  }

  function persistExpanded() {
    localStorage.setItem("pole.noteExpand", JSON.stringify([...expanded]));
  }

  function byId(id) {
    return getNotes().find((note) => note.id === id) || null;
  }

  function childrenOf(parentId) {
    return getNotes()
      .filter((note) => note.parent_id === parentId)
      .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title, "ru"));
  }

  function plainOf(note) {
    if (!note || !note.body) return "";
    return (note.body.blocks || []).map((block) => {
      if (block.type === "code") return block.text || "";
      const box = document.createElement("div");
      box.innerHTML = block.html || "";
      return box.textContent || "";
    }).join("\n");
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "n" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function emptyBody() {
    return { blocks: [{ id: uid(), type: "p", html: "" }] };
  }

  function bind(opts) {
    api = opts.api;
    notify = opts.notify;
    getNotes = opts.getNotes;
    setNotes = opts.setNotes;
    onOpen = opts.onOpen || null;
    document.getElementById("note-new").addEventListener("click", () => createNote("page"));
    document.getElementById("note-new-folder").addEventListener("click", () => createNote("folder"));
    document.getElementById("note-title").addEventListener("input", onTitleInput);
    document.getElementById("note-delete").addEventListener("click", deleteOpen);
    const bubble = document.getElementById("note-bubble");
    bubble.addEventListener("mousedown", (event) => {
      const button = event.target.closest("button[data-cmd]");
      if (!button) return;
      event.preventDefault();
      restoreSelection();
      runCommand(button.dataset.cmd);
      updateBubbleState();
    });
    const editor = document.getElementById("note-editor");
    editor.addEventListener("input", scheduleSave);
    editor.addEventListener("keydown", onEditorKey);
    editor.addEventListener("click", onEditorClick);
    editor.addEventListener("paste", onEditorPaste);
    editor.addEventListener("dragstart", onBlockDragStart);
    editor.addEventListener("dragend", onBlockDragEnd);
    editor.addEventListener("dragover", onBlockDragOver);
    editor.addEventListener("drop", onBlockDrop);
    editor.addEventListener("mouseup", scheduleBubble);
    editor.addEventListener("keyup", scheduleBubble);
    document.addEventListener("selectionchange", scheduleBubble);
    document.addEventListener("pointerdown", (event) => {
      if (event.target.closest("#note-bubble, #note-editor")) return;
      hideBubble();
    });
    const tree = document.getElementById("notes-tree");
    const rootDrop = document.getElementById("notes-root-drop");
    tree.addEventListener("dragstart", onTreeDragStart);
    tree.addEventListener("dragend", onTreeDragEnd);
    tree.addEventListener("dragover", onTreeDragOver);
    tree.addEventListener("dragleave", onTreeDragLeave);
    tree.addEventListener("drop", onTreeDrop);
    tree.addEventListener("click", onTreeClick);
    rootDrop.addEventListener("dragover", onRootDragOver);
    rootDrop.addEventListener("dragleave", onRootDragLeave);
    rootDrop.addEventListener("drop", onRootDrop);
  }

  function render() {
    renderTree();
    if (openId && byId(openId)) openNote(openId, { silent: true });
    else showEmpty();
  }

  function renderTree() {
    const root = document.getElementById("notes-tree");
    root.replaceChildren();
    const walk = (parentId, depth) => {
      for (const note of childrenOf(parentId)) {
        root.append(treeRow(note, depth));
        if (note.kind === "folder" && expanded.has(note.id)) walk(note.id, depth + 1);
      }
    };
    walk(null, 0);
  }

  function treeRow(note, depth) {
    const row = document.createElement("div");
    row.className = "note-row" + (note.id === openId ? " on" : "") + (note.kind === "folder" ? " is-folder" : "");
    row.dataset.id = note.id;
    row.draggable = true;
    row.style.paddingLeft = (10 + depth * 14) + "px";

    if (note.kind === "folder") {
      const twist = document.createElement("button");
      twist.type = "button";
      twist.className = "twist" + (expanded.has(note.id) ? " open" : "");
      twist.dataset.twist = note.id;
      twist.append(Icons.svg("chevron-right", "ico twist-ico"));
      row.append(twist);
    } else {
      const pad = document.createElement("span");
      pad.className = "twist-pad";
      row.append(pad);
    }

    const icon = Icons.svg(note.kind === "folder" ? "folder" : "file-text", "ico note-ico");
    const title = document.createElement("span");
    title.className = "note-row-title";
    title.textContent = note.title || (note.kind === "folder" ? "Папка" : "Без названия");
    row.append(icon, title);
    return row;
  }

  function onTreeClick(event) {
    const twist = event.target.closest("[data-twist]");
    if (twist) {
      const id = twist.dataset.twist;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      persistExpanded();
      renderTree();
      return;
    }
    const row = event.target.closest(".note-row");
    if (!row) return;
    openNote(row.dataset.id);
  }

  function onTreeDragStart(event) {
    const row = event.target.closest(".note-row");
    if (!row) return;
    dragId = row.dataset.id;
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragId);
  }

  function clearDragMarks() {
    document.querySelectorAll(".note-row.drag-over, .note-row.dragging").forEach((el) => {
      el.classList.remove("drag-over", "dragging");
    });
    document.getElementById("notes-tree").classList.remove("is-root-over");
    document.getElementById("notes-root-drop").classList.remove("is-over");
  }

  function onTreeDragEnd() {
    dragId = null;
    clearDragMarks();
  }

  function onTreeDragOver(event) {
    if (!dragId) return;
    const row = event.target.closest(".note-row");
    event.preventDefault();
    document.querySelectorAll(".note-row.drag-over").forEach((el) => el.classList.remove("drag-over"));
    document.getElementById("notes-root-drop").classList.remove("is-over");
    if (row && row.dataset.id !== dragId) {
      document.getElementById("notes-tree").classList.remove("is-root-over");
      row.classList.add("drag-over");
      return;
    }
    document.getElementById("notes-tree").classList.add("is-root-over");
  }

  function onTreeDragLeave(event) {
    const row = event.target.closest(".note-row");
    if (row && !row.contains(event.relatedTarget)) row.classList.remove("drag-over");
    const tree = document.getElementById("notes-tree");
    if (!tree.contains(event.relatedTarget)) tree.classList.remove("is-root-over");
  }

  function onRootDragOver(event) {
    if (!dragId) return;
    event.preventDefault();
    document.querySelectorAll(".note-row.drag-over").forEach((el) => el.classList.remove("drag-over"));
    document.getElementById("notes-tree").classList.remove("is-root-over");
    event.currentTarget.classList.add("is-over");
  }

  function onRootDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      event.currentTarget.classList.remove("is-over");
    }
  }

  async function onRootDrop(event) {
    event.preventDefault();
    const from = dragId || event.dataTransfer.getData("text/plain");
    clearDragMarks();
    if (!from) return;
    await moveToRoot(from);
  }

  async function moveToRoot(id) {
    const note = byId(id);
    if (!note) return;
    if (!note.parent_id) {
      notify("Уже на верхнем уровне");
      return;
    }
    try {
      const sort = Math.max(-1, ...getNotes().filter((item) => !item.parent_id).map((item) => item.sort)) + 1;
      const updated = await api(`/api/notes/${id}`, {
        method: "PATCH",
        body: { parent_id: null, sort },
      });
      const notes = getNotes().slice();
      const index = notes.findIndex((item) => item.id === id);
      if (index >= 0) notes[index] = updated;
      setNotes(notes);
      render();
    } catch (err) {
      notify(err.message || "Не перенеслось");
    }
  }

  async function onTreeDrop(event) {
    event.preventDefault();
    const row = event.target.closest(".note-row");
    const targetId = row?.dataset.id;
    const from = dragId || event.dataTransfer.getData("text/plain");
    const toRoot = !targetId || document.getElementById("notes-tree").classList.contains("is-root-over");
    clearDragMarks();
    if (!from) return;
    if (toRoot || !targetId) {
      await moveToRoot(from);
      return;
    }
    if (from === targetId) return;
    try {
      const result = await api("/api/notes/drop", {
        method: "POST",
        body: { dragged_id: from, target_id: targetId },
      });
      applyDropResult(result);
      if (result.folder) {
        expanded.add(result.folder.id);
        persistExpanded();
        openId = result.folder.id;
        localStorage.setItem("pole.note", openId);
      } else if (result.mode === "nest") {
        const target = byId(targetId);
        if (target?.kind === "folder") {
          expanded.add(targetId);
          persistExpanded();
        }
      }
      render();
    } catch (err) {
      notify(err.message || "Не перенеслось");
    }
  }

  function applyDropResult(result) {
    const notes = getNotes().slice();
    if (result.folder) notes.push(result.folder);
    for (const updated of result.notes || []) {
      const index = notes.findIndex((note) => note.id === updated.id);
      if (index >= 0) notes[index] = updated;
      else notes.push(updated);
    }
    setNotes(notes);
  }

  async function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    await saveOpen();
  }

  async function createNote(kind, parentId = null) {
    await flushSave();
    let parent = parentId;
    if (!parent && openId) {
      const current = byId(openId);
      if (current?.kind === "folder") parent = current.id;
      else if (current?.parent_id) parent = current.parent_id;
    }
    try {
      const note = await api("/api/notes", {
        method: "POST",
        body: {
          kind,
          parent_id: parent,
          title: kind === "folder" ? "Папка" : "Без названия",
        },
      });
      setNotes([...getNotes(), note]);
      if (parent) {
        expanded.add(parent);
        persistExpanded();
      }
      openNote(note.id);
      renderTree();
      const title = document.getElementById("note-title");
      title.focus();
      title.select();
      return note;
    } catch (err) {
      notify(err.message || "Не создалось");
      return null;
    }
  }

  function showEmpty() {
    openId = null;
    document.getElementById("note-empty").hidden = false;
    document.getElementById("note-page").hidden = true;
    renderTree();
    if (window.matchMedia("(max-width: 860px)").matches && window.openNotesNav) {
      window.openNotesNav();
    }
  }

  function openNote(id, opts = {}) {
    const note = byId(id);
    if (!note) {
      showEmpty();
      return;
    }
    openId = id;
    localStorage.setItem("pole.note", id);
    let parent = note.parent_id;
    while (parent) {
      expanded.add(parent);
      parent = byId(parent)?.parent_id || null;
    }
    persistExpanded();
    document.getElementById("note-empty").hidden = true;
    document.getElementById("note-page").hidden = false;
    document.getElementById("note-title").value = note.title || "";
    const isFolder = note.kind === "folder";
    document.getElementById("note-folder-body").hidden = !isFolder;
    document.getElementById("note-tools").hidden = false;
    document.getElementById("note-editor").hidden = isFolder;
    document.getElementById("note-save").textContent = "";
    document.getElementById("note-delete").textContent = isFolder ? "Папку в корзину" : "В корзину";
    hideBubble();
    if (isFolder) fillFolderBody(note);
    else mountEditor(note);
    renderTree();
    if (!opts.silent && window.closeNotesNav) window.closeNotesNav();
    if (!opts.silent && onOpen) onOpen(note);
  }

  function fillFolderBody(note) {
    const box = document.getElementById("note-folder-body");
    box.replaceChildren();
    const kids = childrenOf(note.id);
    if (!kids.length) {
      const empty = document.createElement("p");
      empty.className = "folder-empty";
      empty.textContent = "Пока пусто";
      box.append(empty);
    } else {
      const list = document.createElement("div");
      list.className = "folder-links";
      for (const child of kids) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "folder-link";
        button.append(
          Icons.svg(child.kind === "folder" ? "folder" : "file-text", "ico"),
          document.createTextNode(child.title || (child.kind === "folder" ? "Папка" : "Без названия")),
        );
        button.addEventListener("click", () => openNote(child.id));
        list.append(button);
      }
      box.append(list);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "folder-add";
    add.textContent = "+ статья в этой папке";
    add.addEventListener("click", () => createNote("page", note.id));
    box.append(add);
  }

  function mountEditor(note) {
    const host = document.getElementById("note-editor");
    host.replaceChildren();
    const body = note.body && note.body.blocks ? note.body : emptyBody();
    for (const block of body.blocks) host.append(renderBlock(block));
    if (!host.children.length) host.append(renderBlock({ id: uid(), type: "p", html: "" }));
    clearHighlights();
  }

  function makeGrip() {
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "nb-grip";
    grip.draggable = true;
    grip.title = "Перетащить";
    grip.textContent = "⋮⋮";
    return grip;
  }

  function renderBlock(block) {
    const wrap = document.createElement("div");
    wrap.className = "nb " + (block.type === "code" ? "code" : "text");
    wrap.dataset.id = block.id;
    wrap.dataset.type = block.type === "code" ? "code" : "p";
    wrap.append(makeGrip());

    if (block.type === "code") {
      const body = document.createElement("div");
      body.className = "nb-body";
      const head = document.createElement("div");
      head.className = "code-head";
      const label = document.createElement("span");
      label.textContent = "код";
      const actions = document.createElement("div");
      actions.className = "code-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "code-copy";
      copy.textContent = "Копировать";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(body.querySelector("pre").innerText);
          notify("Скопировано");
        } catch (err) {
          notify("Не скопировалось");
        }
      });
      const after = document.createElement("button");
      after.type = "button";
      after.className = "code-after";
      after.textContent = "Блок ниже";
      after.addEventListener("click", () => insertTextAfter(wrap));
      actions.append(copy, after);
      head.append(label, actions);
      const pre = document.createElement("pre");
      pre.contentEditable = "true";
      pre.spellcheck = false;
      pre.textContent = block.text || "";
      body.append(head, pre);
      wrap.append(body);
      return wrap;
    }

    const body = document.createElement("div");
    body.className = "nb-body";
    body.contentEditable = "true";
    body.innerHTML = block.html || "";
    if (!body.innerHTML) body.innerHTML = "<br>";
    wrap.append(body);
    return wrap;
  }

  function serializeBody() {
    const blocks = [];
    for (const node of document.getElementById("note-editor").children) {
      if (node.dataset.type === "code") {
        blocks.push({
          id: node.dataset.id || uid(),
          type: "code",
          text: node.querySelector("pre")?.innerText || "",
        });
      } else {
        let html = node.querySelector(".nb-body")?.innerHTML || "";
        if (html === "<br>" || html === "<br/>") html = "";
        blocks.push({
          id: node.dataset.id || uid(),
          type: "p",
          html,
        });
      }
    }
    if (!blocks.length) return emptyBody();
    return { blocks };
  }

  function isBlockEmpty(block) {
    if (!block) return true;
    if (block.dataset.type === "code") {
      return !(block.querySelector("pre")?.innerText || "").trim();
    }
    const text = (block.querySelector(".nb-body")?.innerText || "").replace(/\u00a0/g, " ").trim();
    return !text;
  }

  function focusBlock(block, atEnd = false) {
    if (!block) return;
    const target = block.dataset.type === "code"
      ? block.querySelector("pre")
      : block.querySelector(".nb-body");
    if (!target) return;
    target.focus();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(!atEnd);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertTextAfter(block) {
    const next = renderBlock({ id: uid(), type: "p", html: "" });
    block.after(next);
    focusBlock(next);
    scheduleSave();
    hideBubble();
    return next;
  }

  function removeBlock(block) {
    const host = document.getElementById("note-editor");
    if (!block || !host.contains(block)) return;
    if (host.children.length <= 1) {
      if (block.dataset.type === "code") {
        const fresh = renderBlock({ id: uid(), type: "p", html: "" });
        block.replaceWith(fresh);
        focusBlock(fresh);
      } else {
        const body = block.querySelector(".nb-body");
        if (body) body.innerHTML = "<br>";
        focusBlock(block);
      }
      scheduleSave();
      return;
    }
    const prev = block.previousElementSibling;
    const next = block.nextElementSibling;
    block.remove();
    focusBlock(prev || next, Boolean(prev));
    scheduleSave();
    hideBubble();
  }

  function onTitleInput() {
    const note = byId(openId);
    if (!note) return;
    note.title = document.getElementById("note-title").value;
    renderTree();
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    document.getElementById("note-save").textContent = "пишу…";
    saveTimer = setTimeout(saveOpen, 380);
  }

  async function saveOpen() {
    saveTimer = 0;
    const note = byId(openId);
    if (!note) return;
    const seq = ++saveSeq;
    const title = document.getElementById("note-title").value.trim() || (note.kind === "folder" ? "Папка" : "Без названия");
    const body = note.kind === "folder" ? undefined : serializeBody();
    const payload = { title };
    if (body) payload.body = body;
    try {
      const updated = await api(`/api/notes/${note.id}`, { method: "PATCH", body: payload });
      if (seq !== saveSeq) return;
      Object.assign(note, updated);
      document.getElementById("note-save").textContent = "сохранено";
      renderTree();
    } catch (err) {
      if (seq !== saveSeq) return;
      document.getElementById("note-save").textContent = err.message || "не сохранилось";
    }
  }

  async function deleteOpen() {
    const note = byId(openId);
    if (!note) return;
    const ask = window.askDialog;
    const ok = ask
      ? await ask({
        title: note.kind === "folder" ? "Папку в корзину?" : "Статью в корзину?",
        body: note.kind === "folder"
          ? "Папка и вложенное попадут в корзину на 30 дней."
          : "Можно будет вернуть из корзины в течение 30 дней.",
        ok: "В корзину",
      })
      : true;
    if (!ok) return;
    clearTimeout(saveTimer);
    try {
      await api(`/api/notes/${note.id}`, { method: "DELETE" });
      const doomed = collectLocal(note.id);
      setNotes(getNotes().filter((item) => !doomed.has(item.id)));
      openId = note.parent_id && byId(note.parent_id) ? note.parent_id : null;
      if (openId) openNote(openId);
      else showEmpty();
      renderTree();
      notify("В корзине");
      window.refreshTrashCount?.();
    } catch (err) {
      notify(err.message || "Не удалилось");
    }
  }

  function collectLocal(id) {
    const found = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const note of getNotes()) {
        if (note.parent_id && found.has(note.parent_id) && !found.has(note.id)) {
          found.add(note.id);
          grew = true;
        }
      }
    }
    return found;
  }

  function currentBlock() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.anchorNode;
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el?.closest?.(".nb") || null;
  }

  function currentTextBlock() {
    const block = currentBlock();
    return block?.dataset.type === "p" ? block : null;
  }

  function runCommand(cmd) {
    if (cmd === "code") {
      insertCodeBlock();
      return;
    }
    if (cmd === "link") {
      wrapLink();
      return;
    }
    document.execCommand(cmd === "strike" ? "strikeThrough" : cmd);
    scheduleSave();
    rememberSelection();
    updateBubbleState();
  }

  function wrapLink() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      notify("Выделите текст");
      return;
    }
    const href = prompt("Адрес ссылки", "https://");
    if (!href) return;
    document.execCommand("createLink", false, href);
    const block = currentTextBlock();
    block?.querySelectorAll("a").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    scheduleSave();
  }

  function insertCodeBlock() {
    const host = document.getElementById("note-editor");
    const current = currentBlock() || host.lastElementChild;
    const block = renderBlock({ id: uid(), type: "code", text: "" });
    if (current && current.parentNode === host) current.after(block);
    else host.append(block);
    hideBubble();
    focusBlock(block);
    scheduleSave();
  }

  function caretAtStart(target) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!target.contains(range.startContainer)) return false;
    const probe = range.cloneRange();
    probe.selectNodeContents(target);
    probe.setEnd(range.startContainer, range.startOffset);
    return probe.toString().length === 0;
  }

  function onEditorKey(event) {
    const block = event.target.closest(".nb");
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && block?.dataset.type === "code") {
      event.preventDefault();
      insertTextAfter(block);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (block?.dataset.type === "code") return;
      if (!block || block.dataset.type !== "p") return;
      event.preventDefault();
      insertTextAfter(block);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && block) {
      const target = block.dataset.type === "code"
        ? block.querySelector("pre")
        : block.querySelector(".nb-body");
      if (target && isBlockEmpty(block) && (event.key === "Delete" || caretAtStart(target))) {
        event.preventDefault();
        removeBlock(block);
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      runCommand("bold");
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      runCommand("italic");
    }
  }

  function onEditorClick(event) {
    if (event.target === event.currentTarget) {
      const last = event.currentTarget.lastElementChild;
      if (last?.dataset.type === "code") insertTextAfter(last);
      return;
    }
    const link = event.target.closest("a[href]");
    if (link && !event.metaKey && !event.ctrlKey && !event.target.closest(".nb-grip")) {
      event.preventDefault();
      window.open(link.href, "_blank", "noopener,noreferrer");
    }
  }

  function onEditorPaste(event) {
    const code = event.target.closest(".nb.code pre");
    if (code) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  }

  function onBlockDragStart(event) {
    const grip = event.target.closest(".nb-grip");
    if (!grip) {
      event.preventDefault();
      return;
    }
    const block = grip.closest(".nb");
    if (!block) return;
    blockDragId = block.dataset.id;
    block.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", blockDragId);
    hideBubble();
  }

  function onBlockDragEnd() {
    blockDragId = null;
    document.querySelectorAll(".nb.is-dragging, .nb.drag-over").forEach((el) => {
      el.classList.remove("is-dragging", "drag-over");
    });
  }

  function onBlockDragOver(event) {
    if (!blockDragId) return;
    const block = event.target.closest(".nb");
    if (!block || block.dataset.id === blockDragId) return;
    event.preventDefault();
    document.querySelectorAll(".nb.drag-over").forEach((el) => el.classList.remove("drag-over"));
    block.classList.add("drag-over");
  }

  function onBlockDrop(event) {
    event.preventDefault();
    const target = event.target.closest(".nb");
    const fromId = blockDragId || event.dataTransfer.getData("text/plain");
    document.querySelectorAll(".nb.drag-over").forEach((el) => el.classList.remove("drag-over"));
    if (!fromId || !target || target.dataset.id === fromId) return;
    const host = document.getElementById("note-editor");
    const dragged = host.querySelector(`.nb[data-id="${CSS.escape(fromId)}"]`);
    if (!dragged || !host.contains(target)) return;
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    if (before) target.before(dragged);
    else target.after(dragged);
    scheduleSave();
  }

  function rememberSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      savedRange = null;
      return;
    }
    const range = sel.getRangeAt(0);
    if (!document.getElementById("note-editor").contains(range.commonAncestorContainer)) {
      savedRange = null;
      return;
    }
    savedRange = range.cloneRange();
  }

  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  function hideBubble() {
    document.getElementById("note-bubble").hidden = true;
  }

  function updateBubbleState() {
    const bubble = document.getElementById("note-bubble");
    for (const button of bubble.querySelectorAll("button[data-cmd]")) {
      const cmd = button.dataset.cmd;
      if (cmd === "code" || cmd === "link") {
        button.classList.remove("on");
        continue;
      }
      const query = cmd === "strike" ? "strikeThrough" : cmd;
      button.classList.toggle("on", document.queryCommandState(query));
    }
  }

  function placeBubble() {
    const sel = window.getSelection();
    const bubble = document.getElementById("note-bubble");
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      hideBubble();
      return;
    }
    const range = sel.getRangeAt(0);
    const editor = document.getElementById("note-editor");
    if (!editor.contains(range.commonAncestorContainer)) {
      hideBubble();
      return;
    }
    if (range.commonAncestorContainer.closest?.(".nb.code") || range.startContainer.parentElement?.closest?.(".nb.code")) {
      hideBubble();
      return;
    }
    rememberSelection();
    bubble.hidden = false;
    updateBubbleState();
    const rect = range.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    let left = rect.left + rect.width / 2 - width / 2;
    let top = rect.top - height - 10;
    if (top < 8) top = rect.bottom + 10;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    bubble.style.left = left + "px";
    bubble.style.top = top + "px";
  }

  let bubbleTimer = 0;
  function scheduleBubble() {
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(placeBubble, 16);
  }

  function clearHighlights() {
    document.querySelectorAll(".search-mark").forEach((mark) => {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  function highlightInOpen(query) {
    const note = byId(openId);
    if (!note || note.kind === "folder") return false;
    clearHighlights();
    const token = query.trim();
    if (!token) return false;
    const lower = token.toLocaleLowerCase("ru");
    let first = null;
    for (const block of document.getElementById("note-editor").querySelectorAll(".nb.text .nb-body, .nb.code pre")) {
      first = highlightNode(block, lower) || first;
    }
    if (first) {
      first.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }
    return false;
  }

  function highlightNode(root, lower) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue || "";
      const index = text.toLocaleLowerCase("ru").indexOf(lower);
      if (index >= 0) hits.push({ node, index, len: lower.length });
    }
    let first = null;
    for (const hit of hits.reverse()) {
      const range = document.createRange();
      range.setStart(hit.node, hit.index);
      range.setEnd(hit.node, hit.index + hit.len);
      const mark = document.createElement("mark");
      mark.className = "search-mark";
      range.surroundContents(mark);
      first = mark;
    }
    return first;
  }

  function focusNote(id, query) {
    openNote(id);
    if (query) {
      requestAnimationFrame(() => {
        highlightInOpen(query);
      });
    }
  }

  function getOpenId() {
    return openId;
  }

  return {
    bind,
    render,
    openNote,
    focusNote,
    createNote,
    plainOf,
    byId,
    getOpenId,
    highlightInOpen,
  };
})();
