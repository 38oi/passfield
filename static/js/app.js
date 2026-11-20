"use strict";

const KINDS = {
  ssh: { label: "SSH", color: "#1f8a78" },
  system: { label: "Система", color: "#3d6fad" },
  software: { label: "Софт", color: "#c4841d" },
  web: { label: "Интернет", color: "#6d5bd0" },
  service: { label: "Сервис", color: "#d15a3a" },
  personal: { label: "Личное", color: "#c4476c" },
};

const CARD_W = 236;

const LABEL_MIN_W = 96;
const LABEL_MIN_H = 40;
const LABEL_MAX_W = 2400;
const LABEL_MAX_H = 1600;

const state = {
  entries: [],
  links: [],
  tags: [],
  labels: [],
  notes: [],
  mode: document.documentElement.dataset.mode === "notes" ? "notes" : "pass",
  tab: "all",
  query: "",
  cam: loadCam(),
  selected: new Set(),
  openId: null,
  dropId: null,
  draggingId: null,
  glow: new Set(),
  tool: null,
  draft: null,
  linkMenuId: null,
  hitIndex: -1,
};

const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const search = document.getElementById("search");
const menu = document.getElementById("menu");
const composer = document.getElementById("composer");
const linkmenu = document.getElementById("linkmenu");
const hint = document.getElementById("hint");
const sheet = document.getElementById("sheet");
const scrim = document.getElementById("scrim");
const marquee = document.getElementById("marquee");
let pinching = false;
let suppressMenu = false;

function isCompact() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function isCoarse() {
  return window.matchMedia("(pointer: coarse)").matches;
}
const fTitle = document.getElementById("f-title");
const fUser = document.getElementById("f-user");
const fSecret = document.getElementById("f-secret");
const fComment = document.getElementById("f-comment");
const fUrl = document.getElementById("f-url");

let hintTimer = 0;
let saveTimer = 0;
let camTimer = 0;
let suppressClick = false;
let saveSeq = 0;

const sim = d3.forceSimulation()
  .force("link", d3.forceLink().id((d) => d.id).distance(300).strength(0.42))
  .force("collide", d3.forceCollide(110).strength(0.6).iterations(1))
  .velocityDecay(0.62)
  .alphaDecay(0.08)
  .stop();

function kindOf(id) {
  return KINDS[id] || KINDS.web;
}

function byId(id) {
  return state.entries.find((e) => e.id === id) || null;
}

function tagById(id) {
  return state.tags.find((t) => t.id === id) || null;
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

function loadCam() {
  try {
    const raw = JSON.parse(localStorage.getItem("pole.cam") || "null");
    if (raw && [raw.x, raw.y, raw.k].every(Number.isFinite)) {
      return { x: raw.x, y: raw.y, k: Math.min(2.4, Math.max(0.28, raw.k)) };
    }
  } catch (err) { /* камера по умолчанию */ }
  return { x: 0, y: 0, k: 1 };
}

function saveCam() {
  clearTimeout(camTimer);
  camTimer = setTimeout(() => {
    localStorage.setItem("pole.cam", JSON.stringify(state.cam));
  }, 180);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });
  if (!res.ok) {
    let detail = "не получилось";
    try {
      const payload = await res.json();
      if (typeof payload.detail === "string") detail = payload.detail;
    } catch (err) { /* тело не json */ }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

function notify(text, x, y) {
  const el = document.createElement("div");
  el.className = "toast " + (x == null ? "mid" : "at");
  el.textContent = text;
  if (x == null) {
    el.style.left = "50%";
    el.style.bottom = "28px";
  } else {
    el.style.left = x + "px";
    el.style.top = y + "px";
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function askDialog({ title, body, ok = "Ок", cancel = "Отмена", danger = false } = {}) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("dialog");
    document.getElementById("dialog-title").textContent = title || "";
    document.getElementById("dialog-body").textContent = body || "";
    const okBtn = document.getElementById("dialog-ok");
    const cancelBtn = document.getElementById("dialog-cancel");
    okBtn.textContent = ok;
    cancelBtn.textContent = cancel;
    okBtn.classList.toggle("primary", !danger);
    okBtn.style.color = danger ? "var(--danger)" : "";
    dialog.hidden = false;
    const finish = (value) => {
      dialog.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (event) => {
      if (event.target.id === "dialog") finish(false);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("click", onBackdrop);
  });
}

window.askDialog = askDialog;

function refreshTrashCount(count) {
  if (typeof count === "number") {
    TrashUI.setCount(count);
    return;
  }
  api("/api/trash").then((data) => {
    TrashUI.setCount((data.items || []).length);
  }).catch(() => {});
}

window.refreshTrashCount = refreshTrashCount;

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (fallbackErr) {
      return false;
    }
  }
}

async function copyField(entry, field, x, y, source) {
  if (field === "secret" && entry.secret_ok === false && !(source && source.dataset.dirty === "1")) {
    notify("Не расшифровался", x, y);
    return;
  }
  const value = field === "secret"
    ? (source && source.dataset.dirty === "1" ? source.value : entry.secret)
    : field === "username" ? entry.username : entry.url;
  const label = field === "secret" ? "Пароль скопирован" : field === "username" ? "Логин скопирован" : "Адрес скопирован";
  if (!value) {
    notify(field === "secret" ? "Пароль пустой" : "Пусто", x, y);
    return;
  }
  const ok = await writeClipboard(value);
  notify(ok ? label : "Не удалось скопировать", x, y);
  if (source) {
    source.classList.add("copied");
    setTimeout(() => source.classList.remove("copied"), 350);
  }
}

function passesTab(entry) {
  return state.tab === "all" || entry.tag_ids.includes(state.tab);
}

function visibleEntries() {
  const tokens = state.query.trim().toLocaleLowerCase("ru").split(/\s+/).filter(Boolean);
  return state.entries.filter((entry) => {
    if (!passesTab(entry)) return false;
    if (!tokens.length) return true;
    const tags = entry.tag_ids.map((id) => tagById(id)?.name || "").join(" ");
    const hay = [
      entry.title, entry.username, entry.secret, entry.comment, entry.url,
      tags, kindOf(entry.kind).label, entry.kind,
    ].join("\n").toLocaleLowerCase("ru");
    return tokens.every((token) => hay.includes(token));
  });
}

function clientToWorld(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  return [
    (sx - rect.width / 2) / state.cam.k + state.cam.x,
    (sy - rect.height / 2) / state.cam.k + state.cam.y,
  ];
}

function worldToScreen(x, y) {
  const rect = viewport.getBoundingClientRect();
  return [
    (x - state.cam.x) * state.cam.k + rect.width / 2,
    (y - state.cam.y) * state.cam.k + rect.height / 2,
  ];
}

function applyCamera() {
  const rect = viewport.getBoundingClientRect();
  const { x, y, k } = state.cam;
  // Без scale(): иначе браузер увеличивает растр и всё мылит.
  // Зум = реальные размеры (через --cam-k) + сдвиг в экранных пикселях.
  viewport.style.setProperty("--cam-k", String(k));
  world.style.transform = `translate(${rect.width / 2}px, ${rect.height / 2}px) translate(${-x * k}px, ${-y * k}px)`;
  const size = 28 * k;
  viewport.style.backgroundSize = `${size}px ${size}px`;
  viewport.style.backgroundPosition = `${rect.width / 2 - x * k}px ${rect.height / 2 - y * k}px`;
}

function zoomAt(clientX, clientY, factor) {
  const next = Math.min(2.4, Math.max(0.28, state.cam.k * factor));
  const [wx, wy] = clientToWorld(clientX, clientY);
  const rect = viewport.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  state.cam.k = next;
  state.cam.x = wx - (sx - rect.width / 2) / next;
  state.cam.y = wy - (sy - rect.height / 2) / next;
  applyCamera();
  paintCards();
  paintLabels();
  hideHint();
  saveCam();
}

function cardWorldSize(el) {
  const k = state.cam.k || 1;
  return {
    w: CARD_W,
    h: el ? Math.max(48, el.offsetHeight / k) : 120,
  };
}

function syncSim() {
  sim.nodes(state.entries);
  sim.force("link").links(state.links.map((link) => ({ source: link.a, target: link.b })));
  for (const node of state.entries) {
    node.fx = node.x;
    node.fy = node.y;
    node.vx = 0;
    node.vy = 0;
  }
  if (state.entries.length) {
    sim.alpha(1);
    sim.tick();
    for (const node of state.entries) {
      node.fx = node.x;
      node.fy = node.y;
      node.vx = 0;
      node.vy = 0;
    }
  }
  sim.alpha(0).alphaTarget(0).stop();
}

function componentOf(startId) {
  const visible = new Set(visibleEntries().map((entry) => entry.id));
  const adj = new Map();
  for (const id of visible) adj.set(id, []);
  for (const link of state.links) {
    if (!adj.has(link.a) || !adj.has(link.b)) continue;
    adj.get(link.a).push(link.b);
    adj.get(link.b).push(link.a);
  }
  const seen = new Set();
  if (!adj.has(startId)) return seen;
  const queue = [startId];
  seen.add(startId);
  while (queue.length) {
    const current = queue.pop();
    for (const next of adj.get(current) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function distancesFrom(startId) {
  const adj = new Map(state.entries.map((entry) => [entry.id, []]));
  for (const link of state.links) {
    adj.get(link.a)?.push(link.b);
    adj.get(link.b)?.push(link.a);
  }
  const dist = new Map([[startId, 0]]);
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift();
    for (const next of adj.get(current) || []) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(current) + 1);
        queue.push(next);
      }
    }
  }
  dist.delete(startId);
  return dist;
}

function refreshGlow() {
  state.glow = new Set();
  if (!state.openId) return;
  state.glow.add(state.openId);
  for (const id of distancesFrom(state.openId).keys()) state.glow.add(id);
}

function cardHTML(entry) {
  const kind = kindOf(entry.kind);
  const tags = entry.tag_ids.map(tagById).filter(Boolean);
  const pills = tags.slice(0, 3).map((tag) => (
    `<span class="pill" style="--pill:${esc(tag.color)}">${esc(tag.name)}</span>`
  )).join("") + (tags.length > 3 ? `<span class="pill">+${tags.length - 3}</span>` : "");
  const user = entry.username
    ? `<div class="copyline user" data-copy="username">${esc(entry.username)}</div>`
    : "";
  const secretText = entry.secret_ok === false ? "не расшифровался" : (entry.secret || "нет пароля");
  const url = entry.url ? `<div class="copyline url" data-copy="url">${esc(entry.url)}</div>` : "";
  const bubble = entry.comment && entry.comment.trim() ? `<i class="bubble"></i>` : "";
  return `
    <div class="card-top"><span class="kicker">${esc(kind.label)}</span>${bubble}</div>
    <h2 class="name">${esc(entry.title)}</h2>
    ${user}
    <div class="copyline secret" data-copy="secret">${esc(secretText)}</div>
    ${url}
    ${pills ? `<div class="pills">${pills}</div>` : ""}
  `;
}

const drag = d3.drag()
  .clickDistance(5)
  .filter((event) => event.button === 0 && !event.target.closest("[data-copy]"))
  .on("start", onDragStart)
  .on("drag", onDragMove)
  .on("end", onDragEnd);

let dragState = null;

function onDragStart(event, entry) {
  hideHint();
  state.draggingId = entry.id;
  const [wx, wy] = clientToWorld(event.sourceEvent.clientX, event.sourceEvent.clientY);
  dragState = {
    id: entry.id,
    ox: entry.x,
    oy: entry.y,
    grabX: entry.x - wx,
    grabY: entry.y - wy,
    origins: new Map(state.entries.map((node) => [node.id, { x: node.x, y: node.y }])),
    moved: false,
  };
  for (const node of state.entries) {
    node.vx = 0;
    node.vy = 0;
    node.fx = node.x;
    node.fy = node.y;
  }
}

function onDragMove(event, entry) {
  if (!dragState) return;
  const [wx, wy] = clientToWorld(event.sourceEvent.clientX, event.sourceEvent.clientY);
  const nx = wx + dragState.grabX;
  const ny = wy + dragState.grabY;
  const dx = nx - dragState.ox;
  const dy = ny - dragState.oy;
  if (Math.hypot(dx, dy) > 6) dragState.moved = true;

  const group = state.selected.has(entry.id) && state.selected.size > 1
    ? state.selected
    : new Set([entry.id]);
  const elastic = new Set();
  for (const id of group) {
    for (const other of componentOf(id)) {
      if (!group.has(other)) elastic.add(other);
    }
  }

  for (const node of state.entries) {
    const origin = dragState.origins.get(node.id);
    if (group.has(node.id)) {
      node.fx = origin.x + dx;
      node.fy = origin.y + dy;
    } else if (elastic.has(node.id)) {
      node.fx = null;
      node.fy = null;
    } else {
      node.fx = origin.x;
      node.fy = origin.y;
    }
  }

  sim.alpha(1).alphaTarget(0.5);
  for (let step = 0; step < 4; step += 1) sim.tick();

  state.dropId = dragState.moved ? overlapTarget(entry.id) : null;
  paintCards();
}

function onDragEnd() {
  if (!dragState) return;
  const movedFlag = dragState.moved;
  const draggedId = dragState.id;
  for (const node of state.entries) {
    node.fx = node.x;
    node.fy = node.y;
    node.vx = 0;
    node.vy = 0;
  }
  sim.alpha(0).alphaTarget(0).stop();

  const dropId = state.dropId;
  state.dropId = null;
  state.draggingId = null;

  if (dropId) {
    const dragged = byId(draggedId);
    const target = byId(dropId);
    const gap = Math.hypot(dragged.x - target.x, dragged.y - target.y);
    if (gap < 70) {
      dragged.x = target.x + 52;
      dragged.y = target.y + 64;
      dragged.fx = dragged.x;
      dragged.fy = dragged.y;
    }
  }

  const moved = [];
  for (const node of state.entries) {
    const origin = dragState.origins.get(node.id);
    if (Math.abs(node.x - origin.x) > 0.5 || Math.abs(node.y - origin.y) > 0.5) {
      moved.push({ id: node.id, x: round(node.x), y: round(node.y) });
      node.x = round(node.x);
      node.y = round(node.y);
      node.fx = node.x;
      node.fy = node.y;
    }
  }
  dragState = null;
  paintCards();
  if (movedFlag) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  }
  if (moved.length) savePositions(moved);
  if (dropId && movedFlag) linkEntries(draggedId, dropId);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function overlapTarget(draggedId) {
  const dragged = byId(draggedId);
  const el = cardEl(draggedId);
  const size = cardWorldSize(el);
  const area = size.w * size.h;
  let best = null;
  let bestArea = 0;
  for (const entry of visibleEntries()) {
    if (entry.id === draggedId) continue;
    const other = cardWorldSize(cardEl(entry.id));
    const overlap = intersection(
      dragged.x, dragged.y, size.w, size.h,
      entry.x, entry.y, other.w, other.h,
    );
    if (overlap > bestArea) {
      bestArea = overlap;
      best = entry;
    }
  }
  return best && bestArea >= area * 0.22 ? best.id : null;
}

function intersection(ax, ay, aw, ah, bx, by, bw, bh) {
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const h = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

function cardEl(id) {
  return document.querySelector(`article.card[data-id="${CSS.escape(id)}"]`);
}

async function savePositions(positions) {
  try {
    await api("/api/positions", { method: "PUT", body: { positions } });
  } catch (err) {
    notify(err.message || "Положение не сохранилось");
  }
}

const labelSeq = new Map();
const labelTextTimers = new Map();
let labelDragState = null;

function byLabel(id) {
  return state.labels.find((label) => label.id === id) || null;
}

function labelEl(id) {
  return document.querySelector(`article.label[data-id="${CSS.escape(id)}"]`);
}

async function saveLabel(label, body) {
  const seq = (labelSeq.get(label.id) || 0) + 1;
  labelSeq.set(label.id, seq);
  try {
    await api(`/api/labels/${label.id}`, { method: "PATCH", body });
    if (labelSeq.get(label.id) !== seq) return;
  } catch (err) {
    if (labelSeq.get(label.id) !== seq) return;
    notify(err.message || "Лейбл не сохранился");
  }
}

function scheduleLabelText(label) {
  clearTimeout(labelTextTimers.get(label.id));
  labelTextTimers.set(label.id, setTimeout(() => {
    labelTextTimers.delete(label.id);
    saveLabel(label, { text: label.text });
  }, 320));
}

function flushLabelText(label) {
  if (!labelTextTimers.has(label.id)) return;
  clearTimeout(labelTextTimers.get(label.id));
  labelTextTimers.delete(label.id);
  saveLabel(label, { text: label.text });
}

function onLabelInput(textarea) {
  const label = byLabel(textarea.closest(".label")?.dataset.id);
  if (!label) return;
  if (textarea.value.length > 2000) textarea.value = textarea.value.slice(0, 2000);
  label.text = textarea.value;
  scheduleLabelText(label);
}

function resizeBox(start, edge, dx, dy) {
  const east = edge === "e" || edge === "ne" || edge === "se";
  const west = edge === "w" || edge === "nw" || edge === "sw";
  const south = edge === "s" || edge === "se" || edge === "sw";
  const north = edge === "n" || edge === "ne" || edge === "nw";
  let w = start.w;
  let h = start.h;
  if (east) w = start.w + dx;
  if (west) w = start.w - dx;
  if (south) h = start.h + dy;
  if (north) h = start.h - dy;
  if (w < LABEL_MIN_W) w = LABEL_MIN_W;
  if (w > LABEL_MAX_W) w = LABEL_MAX_W;
  if (h < LABEL_MIN_H) h = LABEL_MIN_H;
  if (h > LABEL_MAX_H) h = LABEL_MAX_H;
  return {
    x: west ? start.x + start.w - w : start.x,
    y: north ? start.y + start.h - h : start.y,
    w,
    h,
  };
}

function startResize(label, edge, event) {
  hideHint();
  const handle = event.target.closest(".resize");
  state.resizingLabelId = label.id;
  handle.setPointerCapture(event.pointerId);
  const start = {
    x: label.x,
    y: label.y,
    w: label.w,
    h: label.h,
    cx: event.clientX,
    cy: event.clientY,
    pointerId: event.pointerId,
  };
  const move = (ev) => {
    if (ev.pointerId !== start.pointerId) return;
    const dx = (ev.clientX - start.cx) / state.cam.k;
    const dy = (ev.clientY - start.cy) / state.cam.k;
    const box = resizeBox(start, edge, dx, dy);
    label.x = box.x;
    label.y = box.y;
    label.w = box.w;
    label.h = box.h;
    paintLabels();
  };
  const up = (ev) => {
    if (ev.pointerId !== start.pointerId) return;
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    state.resizingLabelId = null;
    label.x = round(label.x);
    label.y = round(label.y);
    label.w = round(label.w);
    label.h = round(label.h);
    const changed = Math.abs(label.x - start.x) > 0.5
      || Math.abs(label.y - start.y) > 0.5
      || Math.abs(label.w - start.w) > 0.5
      || Math.abs(label.h - start.h) > 0.5;
    paintLabels();
    if (changed) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      saveLabel(label, { x: label.x, y: label.y, w: label.w, h: label.h });
    }
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  paintLabels();
}

function onLabelDragStart(event, label) {
  hideHint();
  const text = labelEl(label.id)?.querySelector(".label-text");
  if (text && document.activeElement === text) text.blur();
  const [wx, wy] = clientToWorld(event.sourceEvent.clientX, event.sourceEvent.clientY);
  labelDragState = {
    id: label.id,
    ox: label.x,
    oy: label.y,
    grabX: label.x - wx,
    grabY: label.y - wy,
    moved: false,
  };
  state.draggingLabelId = label.id;
  paintLabels();
}

function onLabelDragMove(event, label) {
  if (!labelDragState) return;
  const [wx, wy] = clientToWorld(event.sourceEvent.clientX, event.sourceEvent.clientY);
  const nx = wx + labelDragState.grabX;
  const ny = wy + labelDragState.grabY;
  if (Math.hypot(nx - labelDragState.ox, ny - labelDragState.oy) > 4) {
    labelDragState.moved = true;
    const text = labelEl(label.id)?.querySelector(".label-text");
    if (text && document.activeElement === text) text.blur();
  }
  label.x = nx;
  label.y = ny;
  paintLabels();
}

function onLabelDragEnd(event, label) {
  if (!labelDragState) return;
  const moved = labelDragState.moved;
  labelDragState = null;
  state.draggingLabelId = null;
  label.x = round(label.x);
  label.y = round(label.y);
  paintLabels();
  if (moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    saveLabel(label, { x: label.x, y: label.y, w: round(label.w), h: round(label.h) });
  }
}

const labelDrag = d3.drag()
  .clickDistance(5)
  .filter((event) => {
    if (event.button !== 0) return false;
    if (event.target.closest(".resize, .label-x")) return false;
    const text = event.target.closest(".label-text");
    return !(text && document.activeElement === text);
  })
  .on("start", onLabelDragStart)
  .on("drag", onLabelDragMove)
  .on("end", onLabelDragEnd);

function paintLabels() {
  const k = state.cam.k;
  d3.selectAll("article.label").each(function (label) {
    d3.select(this)
      .style("transform", `translate(${label.x * k}px, ${label.y * k}px)`)
      .style("width", `${label.w * k}px`)
      .style("height", `${label.h * k}px`)
      .classed("is-dragging", state.draggingLabelId === label.id)
      .classed("is-resizing", state.resizingLabelId === label.id);
  });
}

function renderLabels() {
  const sel = d3.select("#labels").selectAll("article.label").data(state.labels, (d) => d.id);
  sel.exit().remove();
  const enter = sel.enter().append("article").attr("class", "label").call(labelDrag);
  enter.append("textarea")
    .attr("class", "label-text")
    .attr("maxlength", "2000")
    .attr("spellcheck", "false")
    .attr("autocomplete", "off")
    .attr("wrap", "soft")
    .attr("draggable", "false");
  for (const edge of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    enter.append("i").attr("class", `resize ${edge}`).attr("data-edge", edge);
  }
  enter.append("button")
    .attr("type", "button")
    .attr("class", "label-x")
    .attr("aria-label", "Удалить")
    .text("×");
  enter.merge(sel).each(function (label) {
    this.dataset.id = label.id;
    const text = this.querySelector(".label-text");
    if (document.activeElement !== text && text.value !== label.text) text.value = label.text;
  });
  paintLabels();
}

async function createLabel(clientX, clientY) {
  const [wx, wy] = clientToWorld(clientX, clientY);
  try {
    const label = await api("/api/labels", {
      method: "POST",
      body: { text: "", x: round(wx - 18), y: round(wy - 16), w: 320, h: 88 },
    });
    state.labels.push(label);
    renderLabels();
    const text = labelEl(label.id)?.querySelector(".label-text");
    if (text) {
      text.focus();
      const end = text.value.length;
      text.setSelectionRange(end, end);
    }
  } catch (err) {
    notify(err.message || "Лейбл не создался");
  }
}

async function deleteLabel(id) {
  clearTimeout(labelTextTimers.get(id));
  labelTextTimers.delete(id);
  labelSeq.set(id, (labelSeq.get(id) || 0) + 1);
  try {
    await api(`/api/labels/${id}`, { method: "DELETE" });
    state.labels = state.labels.filter((label) => label.id !== id);
    if (state.draggingLabelId === id) state.draggingLabelId = null;
    if (state.resizingLabelId === id) state.resizingLabelId = null;
    renderLabels();
    notify("В корзине");
    refreshTrashCount();
  } catch (err) {
    notify(err.message || "Лейбл не удалился");
  }
}

function bindLabels() {
  const root = document.getElementById("labels");
  root.addEventListener("pointerdown", (event) => {
    const host = event.target.closest(".label");
    if (!host) return;
    event.stopPropagation();
    const handle = event.target.closest(".resize");
    if (handle && event.button === 0) {
      event.preventDefault();
      const label = byLabel(host.dataset.id);
      if (label) startResize(label, handle.dataset.edge, event);
    }
  });
  root.addEventListener("input", (event) => {
    if (event.target.classList.contains("label-text")) onLabelInput(event.target);
  });
  root.addEventListener("focusout", (event) => {
    if (!event.target.classList.contains("label-text")) return;
    const label = byLabel(event.target.closest(".label")?.dataset.id);
    if (label) flushLabelText(label);
  });
  root.addEventListener("click", (event) => {
    const kill = event.target.closest(".label-x");
    if (kill) {
      event.stopPropagation();
      deleteLabel(kill.closest(".label").dataset.id);
      return;
    }
    if (suppressClick) return;
    const host = event.target.closest(".label");
    if (!host || event.target.closest(".resize")) return;
    const text = host.querySelector(".label-text");
    if (text && document.activeElement !== text) text.focus();
  });
}

async function linkEntries(a, b) {
  try {
    const link = await api("/api/links", { method: "POST", body: { a, b } });
    if (link.created) {
      state.links.push({ id: link.id, a: link.a, b: link.b });
      syncSim();
      notify("Связано");
    } else {
      notify("Уже связаны");
    }
    refreshGlow();
    paintCards();
    if (state.openId) renderRelated();
  } catch (err) {
    notify(err.message || "Связь не создалась");
  }
}

function renderCards() {
  const visible = visibleEntries();
  const sel = d3.select("#cards").selectAll("article.card").data(visible, (d) => d.id);
  sel.exit().remove();
  const enter = sel.enter().append("article").attr("class", "card").call(drag);
  enter.merge(sel).each(function (entry) {
    this.dataset.id = entry.id;
    this.dataset.hintId = entry.id;
    this.innerHTML = cardHTML(entry);
  });
  paintCards();
  updateChrome();
}

function paintCards() {
  refreshGlow();
  const k = state.cam.k;
  d3.selectAll("article.card").each(function (entry) {
    const kind = kindOf(entry.kind);
    const el = d3.select(this);
    el.style("--kind", kind.color)
      .style("transform", `translate(${entry.x * k}px, ${entry.y * k}px)`)
      .classed("is-open", entry.id === state.openId)
      .classed("is-selected", state.selected.has(entry.id))
      .classed("is-drop", state.dropId === entry.id)
      .classed("is-dragging", state.draggingId === entry.id)
      .classed("is-dim", Boolean(state.openId) && !state.draggingId && !state.glow.has(entry.id));
  });
  renderLinks();
  paintSelection();
}

function renderLinks() {
  const visible = new Map(visibleEntries().map((entry) => [entry.id, entry]));
  const sizes = new Map();
  d3.selectAll("article.card").each(function (entry) {
    sizes.set(entry.id, cardWorldSize(this));
  });
  const lines = [];
  for (const link of state.links) {
    const a = visible.get(link.a);
    const b = visible.get(link.b);
    if (!a || !b) continue;
    const sa = sizes.get(a.id) || { w: CARD_W, h: 120 };
    const sb = sizes.get(b.id) || { w: CARD_W, h: 120 };
    const [x1, y1] = worldToScreen(a.x + sa.w / 2, a.y + sa.h / 2);
    const [x2, y2] = worldToScreen(b.x + sb.w / 2, b.y + sb.h / 2);
    const worldLen = Math.hypot((a.x + sa.w / 2) - (b.x + sb.w / 2), (a.y + sa.h / 2) - (b.y + sb.h / 2));
    const stretch = worldLen / 300;
    lines.push({
      id: link.id,
      path: curve(x1, y1, x2, y2),
      width: Math.max(1.15, 2.7 / Math.sqrt(Math.max(stretch, 0.35))),
      hot: state.glow.size > 1 && state.glow.has(link.a) && state.glow.has(link.b),
    });
  }
  const groups = d3.select("#wires").selectAll("g.wire").data(lines, (d) => d.id);
  groups.exit().remove();
  const enter = groups.enter().append("g").attr("class", "wire");
  enter.append("path").attr("class", "wire-hit");
  enter.append("path").attr("class", "wire-vis");
  enter
    .on("pointerdown", (event) => event.stopPropagation())
    .on("click", (event, line) => {
      event.stopPropagation();
      openLinkMenu(line.id, event.clientX, event.clientY);
    });
  const all = enter.merge(groups);
  all.select(".wire-vis")
    .attr("d", (d) => d.path)
    .attr("stroke-width", (d) => d.width)
    .classed("hot", (d) => d.hot);
  all.select(".wire-hit").attr("d", (d) => d.path);
}

function curve(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(26, len * 0.08);
  const mx = (x1 + x2) / 2 + (-dy / len) * bow;
  const my = (y1 + y2) / 2 + (dx / len) * bow;
  return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
}

function updateChrome() {
  const visible = visibleEntries();
  const inTab = state.entries.filter(passesTab).length;
  const count = document.getElementById("searchcount");
  count.textContent = state.query.trim() ? `${visible.length} из ${inTab}` : "";
  const empty = document.getElementById("empty");
  const title = document.getElementById("empty-title");
  const sub = document.getElementById("empty-sub");
  if (visible.length) {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
  if (!state.entries.length && !state.query.trim()) {
    title.textContent = "Карта пуста";
    if (sub) sub.textContent = "Клик по фону — новый пароль или лейбл.";
    return;
  }
  title.textContent = state.query.trim() ? "Ничего не нашлось" : "Пусто";
  if (sub) {
    sub.textContent = state.query.trim()
      ? "Попробуйте другой запрос или снимите фильтр метки."
      : "В этой метке пока ничего нет.";
  }
}

function renderTabs() {
  const box = document.getElementById("tabbuttons");
  box.replaceChildren();
  box.append(tabButton("all", "Все", null, state.entries.length));
  const tags = [...state.tags].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ru"));
  for (const tag of tags) {
    const count = state.entries.filter((entry) => entry.tag_ids.includes(tag.id)).length;
    box.append(tabButton(tag.id, tag.name, tag.color, count));
  }
  fillTagSelect();
}

function tabButton(id, name, color, count) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab" + (state.tab === id ? " on" : "");
  if (color) {
    const dot = document.createElement("i");
    dot.style.background = color;
    button.append(dot);
  }
  button.append(document.createTextNode(name));
  const badge = document.createElement("span");
  badge.className = "count";
  badge.textContent = String(count);
  button.append(badge);
  button.addEventListener("click", () => {
    state.tab = id;
    hideHint();
    renderTabs();
    renderCards();
  });
  return button;
}

function fillTagSelect() {
  const select = document.getElementById("seltag");
  const current = select.value;
  select.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Метка…";
  select.append(blank);
  for (const tag of [...state.tags].sort((a, b) => a.sort - b.sort)) {
    const option = document.createElement("option");
    option.value = tag.id;
    option.textContent = tag.name;
    select.append(option);
  }
  select.value = [...select.options].some((option) => option.value === current) ? current : "";
}

function paintSelection() {
  const bar = document.getElementById("selectionbar");
  if (state.selected.size < 2) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  document.getElementById("selcount").textContent = `Выбрано ${state.selected.size}`;
}

function hideHint() {
  clearTimeout(hintTimer);
  hint.hidden = true;
}

function scheduleHint(entry, anchor) {
  clearTimeout(hintTimer);
  if (isCoarse() || isCompact()) return;
  const text = (entry.comment || "").trim();
  if (!text || state.draggingId) return;
  hintTimer = setTimeout(() => {
    if (state.draggingId) return;
    showHint(entry, anchor);
  }, 220);
}

function syncScrim() {
  if (!scrim) return;
  if (!isCompact()) {
    scrim.hidden = true;
    return;
  }
  const dockedOpen = [menu, composer].some((el) => el && !el.hidden && el.classList.contains("is-docked"));
  const notesOpen = document.documentElement.classList.contains("notes-nav-open");
  scrim.hidden = sheet.hidden && !dockedOpen && !notesOpen;
}

function closeNotesNav() {
  document.documentElement.classList.remove("notes-nav-open");
  syncScrim();
}

function openNotesNav() {
  document.documentElement.classList.add("notes-nav-open");
  syncScrim();
}

function frameAll() {
  const boxes = [
    ...visibleEntries().map((entry) => ({ x: entry.x, y: entry.y, w: CARD_W, h: 130 })),
    ...state.labels.map((label) => ({ x: label.x, y: label.y, w: label.w, h: label.h })),
  ];
  if (!boxes.length) {
    state.cam = { x: 0, y: 0, k: 1 };
    applyCamera();
    paintCards();
    paintLabels();
    renderLinks();
    saveCam();
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  const rect = viewport.getBoundingClientRect();
  const pad = 48;
  const w = Math.max(80, maxX - minX);
  const h = Math.max(80, maxY - minY);
  const k = Math.min(2.2, Math.max(0.28, Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h)));
  state.cam.x = (minX + maxX) / 2;
  state.cam.y = (minY + maxY) / 2;
  state.cam.k = k;
  applyCamera();
  paintCards();
  paintLabels();
  renderLinks();
  saveCam();
}

function showHint(entry, anchor) {
  hint.replaceChildren();
  const kicker = document.createElement("div");
  kicker.className = "hint-kicker";
  kicker.textContent = "Комментарий";
  const body = document.createElement("div");
  body.className = "hint-body";
  body.textContent = entry.comment.trim();
  hint.append(kicker, body);
  hint.hidden = false;
  hint.style.visibility = "hidden";
  hint.style.left = "0px";
  hint.style.top = "0px";
  const box = hint.getBoundingClientRect();
  const host = anchor.getBoundingClientRect();
  let x = host.right + 12;
  let y = host.top;
  if (x + box.width > window.innerWidth - 8) x = host.left - box.width - 12;
  if (x < 8) x = 8;
  if (y + box.height > window.innerHeight - 8) y = window.innerHeight - box.height - 8;
  if (y < 8) y = 8;
  hint.style.left = x + "px";
  hint.style.top = y + "px";
  hint.style.visibility = "visible";
}

function placeFloating(el, x, y) {
  el.hidden = false;
  if ((el === menu || el === composer) && isCompact()) {
    el.classList.add("is-docked");
    el.style.left = "";
    el.style.top = "";
    el.style.visibility = "visible";
    syncScrim();
    return;
  }
  el.classList.remove("is-docked");
  el.style.visibility = "hidden";
  el.style.left = x + "px";
  el.style.top = y + "px";
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let nx = Math.min(x, window.innerWidth - width - 12);
  let ny = Math.min(y, window.innerHeight - height - 12);
  el.style.left = Math.max(12, nx) + "px";
  el.style.top = Math.max(12, ny) + "px";
  el.style.visibility = "visible";
  syncScrim();
}

function closeMenu() {
  menu.hidden = true;
  menu.classList.remove("is-docked");
  syncScrim();
}

function openMenu(x, y) {
  closeComposer();
  linkmenu.hidden = true;
  placeFloating(menu, x, y);
  menu.dataset.x = String(x);
  menu.dataset.y = String(y);
}

function closeComposer() {
  composer.hidden = true;
  composer.classList.remove("is-docked");
  state.draft = null;
  syncScrim();
}

function openComposer(clientX, clientY) {
  const worldPoint = clientToWorld(clientX, clientY);
  const preset = state.tab !== "all" ? [state.tab] : [];
  state.draft = {
    world: { x: worldPoint[0], y: worldPoint[1] },
    kind: localStorage.getItem("pole.kind") || "web",
    tagIds: new Set(preset.filter((id) => tagById(id))),
  };
  composer.reset();
  const pickKind = (kind) => {
    state.draft.kind = kind;
    renderKindPicker(document.getElementById("composer-kinds"), kind, pickKind);
  };
  pickKind(state.draft.kind);
  fillComposerTags();
  placeFloating(composer, clientX, clientY);
  const title = composer.elements.title;
  if (!isCompact()) title.focus();
  else setTimeout(() => title.focus(), 80);
}

function fillComposerTags() {
  renderTagPicker(document.getElementById("composer-tags"), state.draft.tagIds, (set) => {
    state.draft.tagIds = set;
    fillComposerTags();
  });
}

function renderKindPicker(box, current, onPick) {
  box.replaceChildren();
  for (const [id, kind] of Object.entries(KINDS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = kind.label;
    button.className = id === current ? "on" : "";
    button.style.setProperty("--kind", kind.color);
    button.addEventListener("click", () => onPick(id));
    box.append(button);
  }
}

function renderTagPicker(box, selected, onToggle) {
  box.replaceChildren();
  const tags = [...state.tags].sort((a, b) => a.sort - b.sort);
  for (const tag of tags) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = tag.name;
    button.className = selected.has(tag.id) ? "on" : "";
    button.style.setProperty("--pill", tag.color);
    button.addEventListener("click", () => {
      const next = new Set(selected);
      if (next.has(tag.id)) next.delete(tag.id);
      else next.add(tag.id);
      onToggle(next);
    });
    box.append(button);
  }
}

function openLinkMenu(id, x, y) {
  state.linkMenuId = id;
  closeMenu();
  placeFloating(linkmenu, x, y);
}

async function openSheet(id) {
  await flushSave();
  const entry = byId(id);
  if (!entry) return;
  state.openId = id;
  if (!state.selected.has(id) || state.selected.size === 1) state.selected = new Set([id]);
  closeMenu();
  closeComposer();
  sheet.hidden = false;
  fillSheet(entry);
  paintCards();
  ensureVisible(entry);
  syncScrim();
}

function closeSheet() {
  flushSave();
  state.openId = null;
  sheet.hidden = true;
  document.getElementById("delete-confirm").hidden = true;
  paintCards();
  syncScrim();
}

function fillSheet(entry) {
  document.getElementById("sheet-kicker").textContent = kindOf(entry.kind).label;
  document.getElementById("sheet-kicker").style.color = kindOf(entry.kind).color;
  document.getElementById("sheet-name").textContent = entry.title;
  fTitle.value = entry.title;
  fUser.value = entry.username || "";
  fSecret.value = entry.secret_ok === false ? "" : (entry.secret || "");
  fSecret.placeholder = entry.secret_ok === false ? "не расшифровался — введите заново" : "";
  fSecret.dataset.dirty = "0";
  fComment.value = entry.comment || "";
  fUrl.value = entry.url || "";
  const pickKind = (kind) => {
    const current = byId(state.openId);
    if (!current) return;
    current.kind = kind;
    localStorage.setItem("pole.kind", kind);
    document.getElementById("sheet-kicker").textContent = kindOf(kind).label;
    document.getElementById("sheet-kicker").style.color = kindOf(kind).color;
    renderKindPicker(document.getElementById("sheet-kinds"), kind, pickKind);
    refreshCard(current.id);
    saveOpenNow();
  };
  renderKindPicker(document.getElementById("sheet-kinds"), entry.kind, pickKind);
  renderTagPicker(document.getElementById("sheet-tags"), new Set(entry.tag_ids), (set) => {
    const current = byId(state.openId);
    if (!current) return;
    current.tag_ids = [...set];
    refreshCard(current.id);
    renderTabs();
    saveOpenNow();
  });
  renderRelated();
  document.getElementById("delete-confirm").hidden = true;
  document.getElementById("save-state").textContent = "";
}

function refreshCard(id) {
  const el = cardEl(id);
  const entry = byId(id);
  if (!el || !entry) return;
  el.innerHTML = cardHTML(entry);
  paintCards();
}

function renderRelated() {
  const box = document.getElementById("related");
  box.replaceChildren();
  const entry = byId(state.openId);
  if (!entry) return;
  const dists = [...distancesFrom(entry.id).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  if (!dists.length) return;
  for (const [id, dist] of dists) {
    const other = byId(id);
    if (!other) continue;
    const row = document.createElement("div");
    row.className = "rel";
    row.dataset.hintId = other.id;
    row.style.setProperty("--kind", kindOf(other.kind).color);
    const dot = document.createElement("i");
    dot.className = "dot";
    const who = document.createElement("button");
    who.type = "button";
    who.className = "who";
    const strong = document.createElement("strong");
    strong.textContent = other.title;
    who.append(strong);
    if (other.username) {
      const em = document.createElement("em");
      em.textContent = other.username;
      who.append(em);
    }
    who.addEventListener("click", () => focusEntry(other.id));
    const secret = document.createElement("div");
    secret.className = "mini";
    secret.textContent = other.secret_ok === false ? "…" : (other.secret || "пусто");
    secret.addEventListener("click", (event) => {
      event.stopPropagation();
      copyField(other, "secret", event.clientX, event.clientY, secret);
    });
    row.append(dot, who, secret);
    if (dist === 1) {
      const cut = document.createElement("button");
      cut.type = "button";
      cut.className = "cut";
      cut.textContent = "убрать связь";
      cut.addEventListener("click", () => unlinkPair(entry.id, other.id));
      row.append(cut);
    }
    box.append(row);
  }
}

async function focusEntry(id) {
  const entry = byId(id);
  if (!entry) return;
  if (!passesTab(entry) || (state.query && !visibleEntries().some((item) => item.id === id))) {
    state.tab = "all";
    state.query = "";
    search.value = "";
    renderTabs();
  }
  await openSheet(id);
  renderCards();
}

function ensureVisible(entry) {
  const rect = viewport.getBoundingClientRect();
  const compact = isCompact();
  const [sx, sy] = worldToScreen(entry.x + CARD_W / 2, entry.y + 60);
  const pad = compact ? 56 : 80;
  const rightLimit = rect.width - (sheet.hidden || compact ? pad : 420);
  const bottomLimit = rect.height - (compact && !sheet.hidden ? rect.height * 0.42 : pad);
  if (sx > pad && sx < rightLimit && sy > pad && sy < bottomLimit) return;
  state.cam.x = entry.x + CARD_W / 2 + (sheet.hidden || compact ? 0 : 160);
  state.cam.y = entry.y + 60;
  if (compact && !sheet.hidden) {
    state.cam.y += (rect.height * 0.16) / Math.max(state.cam.k, 0.01);
  }
  applyCamera();
  renderLinks();
  saveCam();
}

function setMode(mode) {
  state.mode = mode === "notes" ? "notes" : "pass";
  document.documentElement.dataset.mode = state.mode;
  localStorage.setItem("pole.mode", state.mode);
  closeNotesNav();
  document.getElementById("mode-pass").classList.toggle("on", state.mode === "pass");
  document.getElementById("mode-notes").classList.toggle("on", state.mode === "notes");
  document.getElementById("pass-shell").hidden = state.mode !== "pass";
  document.getElementById("notes-shell").hidden = state.mode !== "notes";
  if (state.mode === "notes") {
    closeMenu();
    closeComposer();
    linkmenu.hidden = true;
    hideHint();
    Notes.render();
  } else {
    applyCamera();
    renderCards();
  }
  renderSearchHits();
}

function notePlain(note) {
  return Notes.plainOf(note);
}

function searchCorpus() {
  const tokens = state.query.trim().toLocaleLowerCase("ru").split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const hits = [];
  for (const entry of state.entries) {
    const tags = entry.tag_ids.map((id) => tagById(id)?.name || "").join(" ");
    const hay = [
      entry.title, entry.username, entry.secret, entry.comment, entry.url,
      tags, kindOf(entry.kind).label, entry.kind,
    ].join("\n").toLocaleLowerCase("ru");
    if (!tokens.every((token) => hay.includes(token))) continue;
    const snippet = entry.comment || entry.username || entry.url || kindOf(entry.kind).label;
    hits.push({
      type: "pass",
      id: entry.id,
      title: entry.title,
      snippet,
      score: entry.title.toLocaleLowerCase("ru").includes(tokens[0]) ? 0 : 1,
    });
  }
  for (const note of state.notes) {
    const hay = [note.title, notePlain(note)].join("\n").toLocaleLowerCase("ru");
    if (!tokens.every((token) => hay.includes(token))) continue;
    const plain = notePlain(note);
    let snippet = "";
    const at = plain.toLocaleLowerCase("ru").indexOf(tokens[0]);
    if (at >= 0) {
      const start = Math.max(0, at - 24);
      snippet = (start > 0 ? "…" : "") + plain.slice(start, start + 90).replace(/\s+/g, " ");
    } else {
      snippet = note.kind === "folder" ? "папка" : plain.slice(0, 90);
    }
    hits.push({
      type: "note",
      id: note.id,
      title: note.title || (note.kind === "folder" ? "Папка" : "Без названия"),
      snippet,
      score: note.title.toLocaleLowerCase("ru").includes(tokens[0]) ? 0 : 1,
    });
  }
  hits.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title, "ru"));
  return hits.slice(0, 40);
}

function renderSearchHits() {
  const box = document.getElementById("searchhits");
  const count = document.getElementById("searchcount");
  const hits = searchCorpus();
  if (!state.query.trim()) {
    box.hidden = true;
    box.replaceChildren();
    state.hitIndex = -1;
    if (state.mode === "pass") updateChrome();
    else count.textContent = "";
    return;
  }
  count.textContent = String(hits.length);
  box.hidden = false;
  box.replaceChildren();
  if (!hits.length) {
    const empty = document.createElement("div");
    empty.className = "empty-hit";
    empty.textContent = "Ничего не нашлось";
    box.append(empty);
    state.hitIndex = -1;
    return;
  }
  hits.forEach((hit, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "searchhit" + (index === state.hitIndex ? " active" : "");
    button.dataset.index = String(index);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = hit.type === "pass" ? "пароль" : "заметка";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = hit.title;
    const snippet = document.createElement("span");
    snippet.className = "snippet";
    snippet.textContent = hit.snippet || "";
    button.append(kind, title, snippet);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => openSearchHit(hit));
    box.append(button);
  });
}

async function openSearchHit(hit) {
  document.getElementById("searchhits").hidden = true;
  if (hit.type === "pass") {
    setMode("pass");
    state.tab = "all";
    state.query = "";
    search.value = "";
    document.getElementById("searchcount").textContent = "";
    renderTabs();
    renderCards();
    await focusEntry(hit.id);
    const el = cardEl(hit.id);
    if (el) {
      el.classList.add("is-drop");
      setTimeout(() => el.classList.remove("is-drop"), 1200);
    }
    return;
  }
  setMode("notes");
  const query = state.query;
  state.query = "";
  search.value = "";
  document.getElementById("searchcount").textContent = "";
  document.getElementById("searchhits").hidden = true;
  Notes.focusNote(hit.id, query);
}

function moveHit(delta) {
  const hits = [...document.querySelectorAll(".searchhit")];
  if (!hits.length) return;
  state.hitIndex = (state.hitIndex + delta + hits.length) % hits.length;
  hits.forEach((el, index) => el.classList.toggle("active", index === state.hitIndex));
  hits[state.hitIndex].scrollIntoView({ block: "nearest" });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveOpen, 320);
  document.getElementById("save-state").textContent = "пишу…";
}

function saveOpenNow() {
  clearTimeout(saveTimer);
  return saveOpen();
}

function flushSave() {
  if (!saveTimer) return Promise.resolve();
  clearTimeout(saveTimer);
  saveTimer = 0;
  return saveOpen();
}

async function saveOpen() {
  saveTimer = 0;
  const id = state.openId;
  const entry = byId(id);
  if (!entry) return;
  const title = fTitle.value.trim();
  if (!title) {
    document.getElementById("save-state").textContent = "имя обязательно";
    return;
  }
  const seq = ++saveSeq;
  const body = {
    title,
    username: fUser.value,
    comment: fComment.value,
    url: fUrl.value,
    kind: entry.kind,
    tag_ids: entry.tag_ids,
  };
  if (entry.secret_ok !== false || fSecret.dataset.dirty === "1") body.secret = fSecret.value;
  try {
    const updated = await api(`/api/entries/${id}`, { method: "PATCH", body });
    if (seq !== saveSeq) return;
    const x = entry.x;
    const y = entry.y;
    Object.assign(entry, updated);
    entry.x = x;
    entry.y = y;
    entry.fx = x;
    entry.fy = y;
    document.getElementById("save-state").textContent = "сохранено";
    refreshCard(id);
    renderTabs();
    if (state.openId === id) renderRelated();
  } catch (err) {
    document.getElementById("save-state").textContent = err.message || "не сохранилось";
  }
}

function frameIfNeeded() {
  if (localStorage.getItem("pole.cam")) return;
  const boxes = [
    ...state.entries.map((entry) => ({ x: entry.x, y: entry.y, w: CARD_W, h: 130 })),
    ...state.labels.map((label) => ({ x: label.x, y: label.y, w: label.w, h: label.h })),
  ];
  if (!boxes.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  state.cam.x = (minX + maxX) / 2;
  state.cam.y = (minY + maxY) / 2;
  state.cam.k = 1;
}

async function boot() {
  SettingsUI.boot();
  Notes.bind({
    api,
    notify,
    getNotes: () => state.notes,
    setNotes: (notes) => { state.notes = notes; },
  });
  TrashUI.bind({
    api,
    notify,
    ask: askDialog,
    onChange: (count, payload) => {
      TrashUI.setCount(count);
      if (!payload?.restored) return;
      applyRestored(payload.restored);
    },
  });
  try {
    const data = await api("/api/bootstrap");
    state.entries = data.entries;
    state.links = data.links;
    state.tags = data.tags;
    state.labels = data.labels || [];
    state.notes = data.notes || [];
    TrashUI.setCount(data.trash_count || 0);
  } catch (err) {
    document.getElementById("empty").hidden = false;
    document.getElementById("empty-title").textContent = err.message || "База не открылась";
    const sub = document.getElementById("empty-sub");
    if (sub) sub.textContent = "";
    return;
  }
  for (const entry of state.entries) {
    entry.fx = entry.x;
    entry.fy = entry.y;
  }
  frameIfNeeded();
  syncSim();
  applyCamera();
  renderTabs();
  renderLabels();
  renderCards();
  setMode(state.mode);
}

function applyRestored(result) {
  if (!result) return;
  if (result.kind === "entry" && result.item) {
    const entry = result.item;
    entry.fx = entry.x;
    entry.fy = entry.y;
    if (!state.entries.some((item) => item.id === entry.id)) state.entries.push(entry);
    syncSim();
    renderTabs();
    renderCards();
    setMode("pass");
    return;
  }
  if (result.kind === "label" && result.item) {
    if (!state.labels.some((item) => item.id === result.item.id)) state.labels.push(result.item);
    renderLabels();
    setMode("pass");
    return;
  }
  if (result.kind === "note" && result.items) {
    for (const note of result.items) {
      const index = state.notes.findIndex((item) => item.id === note.id);
      if (index >= 0) state.notes[index] = note;
      else state.notes.push(note);
    }
    setMode("notes");
    Notes.render();
  }
}

document.getElementById("cards").addEventListener("pointerdown", (event) => {
  if (event.target.closest(".card")) event.stopPropagation();
});

document.getElementById("cards").addEventListener("click", (event) => {
  const card = event.target.closest(".card");
  if (!card || suppressClick) return;
  const entry = byId(card.dataset.id);
  if (!entry) return;
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    copyField(entry, copy.dataset.copy, event.clientX, event.clientY, copy);
    return;
  }
  if (event.shiftKey) {
    if (state.selected.has(entry.id)) state.selected.delete(entry.id);
    else state.selected.add(entry.id);
    paintCards();
    return;
  }
  state.selected = new Set([entry.id]);
  openSheet(entry.id);
});

document.addEventListener("pointerover", (event) => {
  const host = event.target.closest("[data-hint-id]");
  if (!host || (event.relatedTarget && host.contains(event.relatedTarget))) return;
  const entry = byId(host.dataset.hintId);
  if (entry) scheduleHint(entry, host);
});

document.addEventListener("pointerout", (event) => {
  const host = event.target.closest("[data-hint-id]");
  if (!host || (event.relatedTarget && host.contains(event.relatedTarget))) return;
  hideHint();
});

viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = Math.exp(-event.deltaY * 0.0011);
  zoomAt(event.clientX, event.clientY, factor);
}, { passive: false });

viewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  if (event.target.closest(".card, .wire, .label, .map-tools, .fab")) return;
  if (pinching) return;
  closeMenu();
  linkmenu.hidden = true;
  if (!composer.hidden) {
    closeComposer();
    return;
  }
  if (state.tool === "marquee") {
    startMarquee(event);
    return;
  }
  startPan(event);
});

function touchDist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchMid(a, b) {
  return [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
}

viewport.addEventListener("touchstart", (event) => {
  if (event.touches.length === 2) {
    pinching = true;
    suppressMenu = true;
    const [a, b] = event.touches;
    viewport._pinch = {
      dist: touchDist(a, b),
      k: state.cam.k,
      mid: touchMid(a, b),
    };
  }
}, { passive: true });

viewport.addEventListener("touchmove", (event) => {
  if (!viewport._pinch || event.touches.length !== 2) return;
  event.preventDefault();
  const [a, b] = event.touches;
  const nextDist = touchDist(a, b);
  const [mx, my] = touchMid(a, b);
  const target = Math.min(2.4, Math.max(0.28, viewport._pinch.k * (nextDist / viewport._pinch.dist)));
  const factor = target / state.cam.k;
  if (Math.abs(factor - 1) > 0.001) zoomAt(mx, my, factor);
}, { passive: false });

function endPinch(event) {
  if (event.touches && event.touches.length >= 2) return;
  if (!viewport._pinch && !pinching) return;
  viewport._pinch = null;
  pinching = false;
  setTimeout(() => { suppressMenu = false; }, 80);
  saveCam();
}

viewport.addEventListener("touchend", endPinch);
viewport.addEventListener("touchcancel", endPinch);

function startPan(event) {
  const start = {
    x: event.clientX,
    y: event.clientY,
    camx: state.cam.x,
    camy: state.cam.y,
    moved: false,
  };
  viewport.setPointerCapture(event.pointerId);
  const move = (ev) => {
    if (pinching) return;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (Math.hypot(dx, dy) > 4) {
      start.moved = true;
      viewport.classList.add("is-panning");
    }
    state.cam.x = start.camx - dx / state.cam.k;
    state.cam.y = start.camy - dy / state.cam.k;
    applyCamera();
    renderLinks();
    hideHint();
  };
  const up = (ev) => {
    viewport.removeEventListener("pointermove", move);
    viewport.removeEventListener("pointerup", up);
    viewport.classList.remove("is-panning");
    if (start.moved) saveCam();
    else if (!suppressMenu && !pinching) openMenu(ev.clientX, ev.clientY);
  };
  viewport.addEventListener("pointermove", move);
  viewport.addEventListener("pointerup", up);
}

function startMarquee(event) {
  const rect = viewport.getBoundingClientRect();
  const x0 = event.clientX;
  const y0 = event.clientY;
  marquee.hidden = false;
  const move = (ev) => {
    const left = Math.min(x0, ev.clientX) - rect.left;
    const top = Math.min(y0, ev.clientY) - rect.top;
    marquee.style.left = left + "px";
    marquee.style.top = top + "px";
    marquee.style.width = Math.abs(ev.clientX - x0) + "px";
    marquee.style.height = Math.abs(ev.clientY - y0) + "px";
  };
  const up = (ev) => {
    viewport.removeEventListener("pointermove", move);
    viewport.removeEventListener("pointerup", up);
    marquee.hidden = true;
    state.tool = null;
    const box = {
      left: Math.min(x0, ev.clientX),
      right: Math.max(x0, ev.clientX),
      top: Math.min(y0, ev.clientY),
      bottom: Math.max(y0, ev.clientY),
    };
    if (box.right - box.left < 4 && box.bottom - box.top < 4) return;
    const next = ev.shiftKey ? new Set(state.selected) : new Set();
    for (const entry of visibleEntries()) {
      const el = cardEl(entry.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const hit = r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
      if (hit) next.add(entry.id);
    }
    state.selected = next;
    state.openId = null;
    sheet.hidden = true;
    paintCards();
  };
  move(event);
  viewport.addEventListener("pointermove", move);
  viewport.addEventListener("pointerup", up);
}

menu.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const x = Number(menu.dataset.x);
  const y = Number(menu.dataset.y);
  closeMenu();
  if (button.dataset.act === "create") openComposer(x, y);
  if (button.dataset.act === "label") createLabel(x, y);
  if (button.dataset.act === "select") state.tool = "marquee";
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.draft) return;
  const title = composer.elements.title.value.trim();
  if (!title) {
    composer.elements.title.focus();
    notify("Нужно имя на карте");
    return;
  }
  const body = {
    title,
    secret: composer.elements.secret.value,
    username: composer.elements.username.value,
    comment: composer.elements.comment.value.trim(),
    kind: state.draft.kind,
    x: state.draft.world.x - 28,
    y: state.draft.world.y - 24,
    tag_ids: [...state.draft.tagIds],
  };
  try {
    const entry = await api("/api/entries", { method: "POST", body });
    entry.fx = entry.x;
    entry.fy = entry.y;
    state.entries.push(entry);
    localStorage.setItem("pole.kind", entry.kind);
    closeComposer();
    syncSim();
    state.selected = new Set([entry.id]);
    renderTabs();
    renderCards();
    notify("Положил");
  } catch (err) {
    notify(err.message || "Не сохранилось");
  }
});

document.getElementById("composer-cancel").addEventListener("click", closeComposer);

document.getElementById("composer-newtag").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addTag(event.target, (tag) => {
      state.draft?.tagIds.add(tag.id);
      fillComposerTags();
    });
  }
});

document.getElementById("sheet-newtag").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addTag(event.target, (tag) => {
    const entry = byId(state.openId);
    if (!entry) return;
    if (!entry.tag_ids.includes(tag.id)) entry.tag_ids.push(tag.id);
    fillSheet(entry);
    refreshCard(entry.id);
    saveOpenNow();
  });
});

document.getElementById("tab-new").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addTag(event.target, (tag) => {
    state.tab = tag.id;
    renderTabs();
    renderCards();
  });
});

async function addTag(input, after) {
  const name = input.value.trim();
  if (!name) return;
  try {
    const tag = await api("/api/tags", { method: "POST", body: { name } });
    if (!state.tags.some((item) => item.id === tag.id)) state.tags.push(tag);
    input.value = "";
    renderTabs();
    after(tag);
  } catch (err) {
    notify(err.message || "Метка не создалась");
  }
}

document.getElementById("unlink").addEventListener("click", async () => {
  const id = state.linkMenuId;
  linkmenu.hidden = true;
  if (!id) return;
  try {
    await api(`/api/links/${id}`, { method: "DELETE" });
    state.links = state.links.filter((link) => link.id !== id);
    syncSim();
    refreshGlow();
    paintCards();
    if (state.openId) renderRelated();
  } catch (err) {
    notify(err.message || "Не разорвалось");
  }
});

async function unlinkPair(a, b) {
  const link = state.links.find((item) => (
    (item.a === a && item.b === b) || (item.a === b && item.b === a)
  ));
  if (!link) return;
  try {
    await api(`/api/links/${link.id}`, { method: "DELETE" });
    state.links = state.links.filter((item) => item.id !== link.id);
    syncSim();
    renderRelated();
    paintCards();
  } catch (err) {
    notify(err.message || "Не разорвалось");
  }
}

for (const input of [fTitle, fUser, fSecret, fComment, fUrl]) {
  input.addEventListener("input", () => {
    const entry = byId(state.openId);
    if (!entry) return;
    if (input === fTitle) {
      document.getElementById("sheet-name").textContent = fTitle.value.trim() || entry.title;
      if (fTitle.value.trim()) entry.title = fTitle.value.trim();
    }
    if (input === fUser) entry.username = fUser.value;
    if (input === fSecret) {
      entry.secret = fSecret.value;
      entry.secret_ok = true;
      fSecret.dataset.dirty = "1";
    }
    if (input === fComment) entry.comment = fComment.value;
    if (input === fUrl) entry.url = fUrl.value;
    refreshCard(entry.id);
    scheduleSave();
  });
}

fTitle.addEventListener("blur", () => {
  const entry = byId(state.openId);
  if (!entry) return;
  if (!fTitle.value.trim()) {
    fTitle.value = entry.title;
    document.getElementById("sheet-name").textContent = entry.title;
    notify("Имя обязательно");
  }
});

fSecret.addEventListener("pointerdown", (event) => {
  if (document.activeElement === fSecret) return;
  const entry = byId(state.openId);
  if (!entry) return;
  copyField(entry, "secret", event.clientX, event.clientY, fSecret);
});

document.getElementById("sheet-close").addEventListener("click", closeSheet);

document.getElementById("delete").addEventListener("click", () => {
  document.getElementById("delete-confirm").hidden = false;
});

document.getElementById("delete-no").addEventListener("click", () => {
  document.getElementById("delete-confirm").hidden = true;
});

document.getElementById("delete-yes").addEventListener("click", async () => {
  const id = state.openId;
  if (!id) return;
  try {
    clearTimeout(saveTimer);
    saveTimer = 0;
    await api(`/api/entries/${id}`, { method: "DELETE" });
    state.entries = state.entries.filter((entry) => entry.id !== id);
    state.links = state.links.filter((link) => link.a !== id && link.b !== id);
    state.selected.delete(id);
    state.openId = null;
    sheet.hidden = true;
    syncSim();
    renderTabs();
    renderCards();
    notify("В корзине");
    refreshTrashCount();
  } catch (err) {
    notify(err.message || "Не удалилось");
  }
});

document.getElementById("selclear").addEventListener("click", () => {
  state.selected.clear();
  paintCards();
});

document.getElementById("seltag").addEventListener("change", async (event) => {
  const tagId = event.target.value;
  event.target.value = "";
  if (!tagId || state.selected.size < 2) return;
  const ids = [...state.selected];
  try {
    await Promise.all(ids.map(async (id) => {
      const entry = byId(id);
      if (!entry || entry.tag_ids.includes(tagId)) return;
      entry.tag_ids = [...entry.tag_ids, tagId];
      const updated = await api(`/api/entries/${id}`, {
        method: "PATCH",
        body: { tag_ids: entry.tag_ids },
      });
      entry.tag_ids = updated.tag_ids;
    }));
    renderTabs();
    renderCards();
    if (state.openId) fillSheet(byId(state.openId));
  } catch (err) {
    notify(err.message || "Метка не встала");
  }
});

search.addEventListener("input", () => {
  state.query = search.value;
  state.hitIndex = -1;
  hideHint();
  renderSearchHits();
  if (state.mode === "pass") renderCards();
});

search.addEventListener("keydown", (event) => {
  const open = !document.getElementById("searchhits").hidden;
  if (event.key === "ArrowDown" && open) {
    event.preventDefault();
    moveHit(1);
  } else if (event.key === "ArrowUp" && open) {
    event.preventDefault();
    moveHit(-1);
  } else if (event.key === "Enter" && open) {
    const active = document.querySelector(".searchhit.active") || document.querySelector(".searchhit");
    if (active) {
      event.preventDefault();
      active.click();
    }
  } else if (event.key === "Escape") {
    document.getElementById("searchhits").hidden = true;
  }
});

document.getElementById("mode-pass").addEventListener("click", () => setMode("pass"));
document.getElementById("mode-notes").addEventListener("click", () => setMode("notes"));

document.getElementById("map-add").addEventListener("click", (event) => {
  event.stopPropagation();
  const rect = viewport.getBoundingClientRect();
  openMenu(rect.left + rect.width / 2, rect.top + rect.height * 0.42);
});

document.getElementById("zoom-in").addEventListener("click", (event) => {
  event.stopPropagation();
  const rect = viewport.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.18);
});

document.getElementById("zoom-out").addEventListener("click", (event) => {
  event.stopPropagation();
  const rect = viewport.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.18);
});

document.getElementById("zoom-fit").addEventListener("click", (event) => {
  event.stopPropagation();
  frameAll();
});

document.getElementById("notes-menu").addEventListener("click", () => openNotesNav());
document.getElementById("notes-side-close").addEventListener("click", () => closeNotesNav());

scrim.addEventListener("click", () => {
  if (!sheet.hidden) closeSheet();
  if (!composer.hidden) closeComposer();
  if (!menu.hidden) closeMenu();
  closeNotesNav();
});

document.addEventListener("pointerdown", (event) => {
  const hits = document.getElementById("searchhits");
  if (hits.hidden) return;
  if (event.target.closest("#searchhits, #search")) return;
  hits.hidden = true;
});

window.addEventListener("resize", () => {
  applyCamera();
  renderLinks();
  syncScrim();
});

document.addEventListener("keydown", (event) => {
  const typing = event.target.closest("input, textarea, select, [contenteditable='true'], .nb");
  if (event.key === "Escape") {
    if (!document.getElementById("dialog").hidden) {
      document.getElementById("dialog-cancel").click();
      return;
    }
    if (!document.getElementById("trash").hidden) {
      TrashUI.close();
      return;
    }
    if (!document.getElementById("settings").hidden) {
      SettingsUI.close();
      return;
    }
    if (document.documentElement.classList.contains("notes-nav-open")) {
      closeNotesNav();
      return;
    }
    if (event.target.closest("textarea.label-text")) {
      event.target.blur();
      return;
    }
    if (!document.getElementById("searchhits").hidden) {
      document.getElementById("searchhits").hidden = true;
      return;
    }
    if (!menu.hidden) { closeMenu(); return; }
    if (!composer.hidden) { closeComposer(); return; }
    if (!linkmenu.hidden) { linkmenu.hidden = true; return; }
    if (state.tool === "marquee") {
      state.tool = null;
      return;
    }
    if (state.openId) { closeSheet(); return; }
    if (state.selected.size) {
      state.selected.clear();
      paintCards();
      return;
    }
    if (search.value) {
      search.value = "";
      state.query = "";
      renderSearchHits();
      if (state.mode === "pass") renderCards();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    search.focus();
    search.select();
    return;
  }
  if (!typing && event.key === "/") {
    event.preventDefault();
    search.focus();
  } else if (!typing && state.mode === "pass" && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
    search.focus();
  }
});

window.syncScrim = syncScrim;
window.closeNotesNav = closeNotesNav;
window.openNotesNav = openNotesNav;

bindLabels();
boot();
