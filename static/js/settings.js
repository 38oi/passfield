"use strict";

const SettingsUI = (() => {
  const STORAGE_THEME = "pole.theme";
  const STORAGE_CUSTOM = "pole.themeCustom";

  const PRESETS = {
    dark: {
      bg: "#13140f",
      bg2: "#1a1b15",
      card: "#23241c",
      ink: "#f3efe4",
      muted: "#a39e90",
      accent: "#d6e36a",
      accentInk: "#1a1c10",
      danger: "#e07a6a",
      menu: "#2c2d24",
    },
    light: {
      bg: "#e6e1d4",
      bg2: "#f3efe6",
      card: "#fbf8f2",
      ink: "#1e1c16",
      muted: "#6d685e",
      accent: "#3d5520",
      accentInk: "#f4f7ea",
      danger: "#a33b32",
      menu: "#fffdf8",
    },
  };

  const FIELDS = [
    { key: "bg", label: "Фон" },
    { key: "bg2", label: "Панель" },
    { key: "card", label: "Карточки" },
    { key: "menu", label: "Меню" },
    { key: "ink", label: "Текст" },
    { key: "muted", label: "Приглушённый" },
    { key: "accent", label: "Акцент" },
    { key: "accentInk", label: "Текст на акценте" },
    { key: "danger", label: "Опасность" },
  ];

  const SWATCHES = [
    "#0b1220", "#132033", "#1b2a4a", "#243b6b", "#0f172a",
    "#111827", "#1f2937", "#374151", "#4b5563", "#6b7280",
    "#f8fafc", "#e2e8f0", "#cbd5e1", "#f5f0e6", "#e8dfd0",
    "#d6e36a", "#a3e635", "#34d399", "#22d3ee", "#60a5fa",
    "#818cf8", "#c084fc", "#f472b6", "#fb7185", "#f59e0b",
    "#ef4444", "#e07a6a", "#a33b32", "#3d5520", "#1f8a78",
    "#f3efe4", "#1e1c16", "#13140f", "#23241c", "#fffdf8",
  ];

  let custom = loadCustom();
  let activeKey = null;
  let hue = 210;
  let sat = 45;
  let light = 28;

  function loadCustom() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_CUSTOM) || "null");
      if (!raw || typeof raw !== "object") return { ...PRESETS.dark };
      const next = { ...PRESETS.dark };
      for (const field of FIELDS) {
        if (typeof raw[field.key] === "string" && /^#[0-9a-fA-F]{6}$/.test(raw[field.key])) {
          next[field.key] = raw[field.key].toLowerCase();
        }
      }
      return next;
    } catch (err) {
      return { ...PRESETS.dark };
    }
  }

  function saveCustom() {
    localStorage.setItem(STORAGE_CUSTOM, JSON.stringify(custom));
  }

  function currentMode() {
    const mode = document.documentElement.dataset.theme;
    return mode === "light" || mode === "custom" ? mode : "dark";
  }

  function hexToRgb(hex) {
    const value = hex.replace("#", "");
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  }

  function rgbToHex(r, g, b) {
    const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function hslToRgb(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    if (s === 0) {
      const v = l * 255;
      return { r: v, g: v, b: v };
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: hue2rgb(p, q, h + 1 / 3) * 255,
      g: hue2rgb(p, q, h) * 255,
      b: hue2rgb(p, q, h - 1 / 3) * 255,
    };
  }

  function withAlpha(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function clearInlineVars() {
    const root = document.documentElement.style;
    [
      "--bg", "--bg-2", "--card", "--ink", "--muted", "--line", "--accent", "--accent-ink",
      "--wire", "--danger", "--shadow", "--grid-dot", "--secret", "--menu", "--hover",
    ].forEach((name) => root.removeProperty(name));
  }

  function applyColors(colors, mode) {
    const root = document.documentElement;
    root.dataset.theme = mode;
    if (mode !== "custom") {
      clearInlineVars();
    } else {
      const ink = colors.ink;
      const accent = colors.accent;
      const bg = colors.bg;
      const bgRgb = hexToRgb(bg);
      const darkish = rgbToHsl(bgRgb.r, bgRgb.g, bgRgb.b).l < 50;
      root.style.setProperty("--bg", colors.bg);
      root.style.setProperty("--bg-2", colors.bg2);
      root.style.setProperty("--card", colors.card);
      root.style.setProperty("--ink", colors.ink);
      root.style.setProperty("--muted", colors.muted);
      root.style.setProperty("--accent", colors.accent);
      root.style.setProperty("--accent-ink", colors.accentInk);
      root.style.setProperty("--danger", colors.danger);
      root.style.setProperty("--menu", colors.menu);
      root.style.setProperty("--line", withAlpha(ink, 0.12));
      root.style.setProperty("--wire", withAlpha(accent, 0.55));
      root.style.setProperty("--grid-dot", withAlpha(ink, 0.22));
      root.style.setProperty("--secret", withAlpha(ink, 0.07));
      root.style.setProperty("--hover", withAlpha(ink, 0.06));
      root.style.setProperty(
        "--shadow",
        darkish ? "0 14px 34px rgba(0, 0, 0, 0.38)" : "0 14px 32px rgba(70, 48, 16, 0.12)",
      );
      root.style.colorScheme = darkish ? "dark" : "light";
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.content = mode === "custom" ? colors.bg : (PRESETS[mode] || PRESETS.dark).bg;
    }
  }

  function applyMode(mode, opts = {}) {
    const next = mode === "light" || mode === "custom" ? mode : "dark";
    localStorage.setItem(STORAGE_THEME, next);
    if (next === "custom") {
      if (opts.seed === "light" || opts.seed === "dark") custom = { ...PRESETS[opts.seed] };
      applyColors(custom, "custom");
      saveCustom();
    } else {
      applyColors(PRESETS[next], next);
    }
    syncChrome();
  }

  function syncChrome() {
    const mode = currentMode();
    document.querySelectorAll("[data-theme-pick]").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset.themePick === mode);
    });
    const colors = document.getElementById("settings-colors");
    if (colors) colors.hidden = mode !== "custom";
    renderColorRows();
  }

  function renderColorRows() {
    const box = document.getElementById("settings-color-rows");
    if (!box) return;
    box.replaceChildren();
    for (const field of FIELDS) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "color-row";
      row.dataset.key = field.key;
      row.innerHTML = `
        <span class="color-row-label">${field.label}</span>
        <span class="color-row-value">${custom[field.key]}</span>
        <span class="color-swatch" style="--swatch:${custom[field.key]}"></span>
      `;
      row.addEventListener("click", () => openPicker(field.key, row));
      box.append(row);
    }
  }

  function openPicker(key, anchor) {
    activeKey = key;
    const hex = custom[key];
    const { r, g, b } = hexToRgb(hex);
    const hsl = rgbToHsl(r, g, b);
    hue = hsl.h;
    sat = hsl.s;
    light = hsl.l;
    const pop = document.getElementById("color-pop");
    pop.hidden = false;
    document.getElementById("color-hex").value = hex;
    paintPicker();
    placePop(anchor);
  }

  function placePop(anchor) {
    const pop = document.getElementById("color-pop");
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth || 280;
    const height = pop.offsetHeight || 320;
    let left = rect.right - width;
    let top = rect.bottom + 8;
    if (left < 12) left = 12;
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function paintPicker() {
    const board = document.getElementById("color-board");
    const hueEl = document.getElementById("color-hue");
    const preview = document.getElementById("color-preview");
    const rgb = hslToRgb(hue, sat, light);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    board.style.background = `
      linear-gradient(to top, #000, transparent),
      linear-gradient(to right, #fff, hsl(${hue} 100% 50%))
    `;
    hueEl.style.background = "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";
    const knob = document.getElementById("color-board-knob");
    knob.style.left = `${sat}%`;
    knob.style.top = `${100 - light}%`;
    document.getElementById("color-hue-knob").style.left = `${(hue / 360) * 100}%`;
    preview.style.background = hex;
    document.getElementById("color-hex").value = hex;
  }

  function commitColor(hex) {
    if (!activeKey || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    custom[activeKey] = hex.toLowerCase();
    if (activeKey === "accent") {
      const { r, g, b } = hexToRgb(hex);
      const hsl = rgbToHsl(r, g, b);
      custom.accentInk = hsl.l > 55 ? "#1a1c10" : "#f4f7ea";
    }
    saveCustom();
    applyMode("custom");
    paintPicker();
  }

  function closePicker() {
    document.getElementById("color-pop").hidden = true;
    activeKey = null;
  }

  function open() {
    document.getElementById("settings").hidden = false;
    syncChrome();
  }

  function close() {
    document.getElementById("settings").hidden = true;
    closePicker();
  }

  function bind() {
    document.getElementById("settings-open").addEventListener("click", open);
    document.getElementById("settings-close").addEventListener("click", close);
    document.getElementById("settings").addEventListener("click", (event) => {
      if (event.target.id === "settings") close();
    });
    document.getElementById("settings-reset").addEventListener("click", () => {
      custom = { ...PRESETS.dark };
      saveCustom();
      applyMode("custom");
    });
    document.querySelectorAll("[data-theme-pick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.themePick;
        if (mode === "custom" && currentMode() !== "custom") {
          applyMode("custom", { seed: currentMode() === "light" ? "light" : "dark" });
        } else {
          applyMode(mode);
        }
      });
    });

    const swatches = document.getElementById("color-swatches");
    swatches.replaceChildren();
    for (const color of SWATCHES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "palette-swatch";
      btn.style.background = color;
      btn.title = color;
      btn.addEventListener("click", () => commitColor(color));
      swatches.append(btn);
    }

    const board = document.getElementById("color-board");
    const hueTrack = document.getElementById("color-hue");

    const pickBoard = (event) => {
      const rect = board.getBoundingClientRect();
      sat = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
      light = Math.max(0, Math.min(100, 100 - ((event.clientY - rect.top) / rect.height) * 100));
      const rgb = hslToRgb(hue, sat, light);
      commitColor(rgbToHex(rgb.r, rgb.g, rgb.b));
    };
    board.addEventListener("pointerdown", (event) => {
      board.setPointerCapture(event.pointerId);
      pickBoard(event);
      const move = (ev) => pickBoard(ev);
      const up = () => {
        board.removeEventListener("pointermove", move);
        board.removeEventListener("pointerup", up);
      };
      board.addEventListener("pointermove", move);
      board.addEventListener("pointerup", up);
    });

    const pickHue = (event) => {
      const rect = hueTrack.getBoundingClientRect();
      hue = Math.max(0, Math.min(360, ((event.clientX - rect.left) / rect.width) * 360));
      const rgb = hslToRgb(hue, sat, light);
      commitColor(rgbToHex(rgb.r, rgb.g, rgb.b));
    };
    hueTrack.addEventListener("pointerdown", (event) => {
      hueTrack.setPointerCapture(event.pointerId);
      pickHue(event);
      const move = (ev) => pickHue(ev);
      const up = () => {
        hueTrack.removeEventListener("pointermove", move);
        hueTrack.removeEventListener("pointerup", up);
      };
      hueTrack.addEventListener("pointermove", move);
      hueTrack.addEventListener("pointerup", up);
    });

    document.getElementById("color-hex").addEventListener("change", (event) => {
      let value = event.target.value.trim();
      if (/^[0-9a-fA-F]{6}$/.test(value)) value = `#${value}`;
      if (/^#[0-9a-fA-F]{6}$/.test(value)) commitColor(value);
      else paintPicker();
    });

    document.addEventListener("pointerdown", (event) => {
      const pop = document.getElementById("color-pop");
      if (pop.hidden) return;
      if (event.target.closest("#color-pop, .color-row")) return;
      closePicker();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!document.getElementById("color-pop").hidden) {
        closePicker();
        event.stopPropagation();
        return;
      }
      if (!document.getElementById("settings").hidden) close();
    }, true);
  }

  function boot() {
    const mode = currentMode();
    if (mode === "custom") applyColors(custom, "custom");
    else applyColors(PRESETS[mode] || PRESETS.dark, mode);
    bind();
    syncChrome();
  }

  return { boot, open, close, applyMode, currentMode };
})();

window.SettingsUI = SettingsUI;
