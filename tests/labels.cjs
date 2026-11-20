const path = require("path");
const { chromium } = require(path.join(process.env.TEMP, "pole-playwright", "node_modules", "playwright"));

const base = "http://127.0.0.1:8766";
const shots = path.join(__dirname, "screenshots");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function labelGeom(page) {
  return page.evaluate(async () => {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    const label = data.labels[0];
    const entry = data.entries[0];
    return {
      text: label?.text,
      x: label?.x,
      y: label?.y,
      w: label?.w,
      h: label?.h,
      entry: entry ? { title: entry.title, x: entry.x, y: entry.y, hasSecret: Boolean(entry.secret) } : null,
      secretsOnLabel: label ? Object.hasOwn(label, "secret") : null,
    };
  });
}

async function waitGeom(page, pred) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 4000) {
    last = await labelGeom(page);
    if (pred(last)) return last;
    await page.waitForTimeout(80);
  }
  throw new Error("геометрия не доехала: " + JSON.stringify(last));
}

async function dragHandle(page, edge, dx, dy) {
  const handle = page.locator(`article.label .resize.${edge}`);
  const box = await handle.boundingBox();
  assert(box, "нет ручки " + edge);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.addInitScript(() => localStorage.setItem("pole.theme", "dark"));
  await page.goto(base, { waitUntil: "networkidle" });

  const viewport = await page.locator("#viewport").boundingBox();
  const clickAt = async (dx, dy) => {
    await page.mouse.click(viewport.x + dx, viewport.y + dy);
  };

  await clickAt(180, 460);
  await page.locator("#menu button[data-act=create]").click();
  await page.locator("#composer input[name=title]").fill("Секрет");
  await page.locator("#composer input[name=secret]").fill("hidden-pass");
  await page.locator("#composer button[type=submit]").click();
  await page.locator("article.card", { hasText: "Секрет" }).waitFor();

  await clickAt(760, 180);
  await page.locator("#menu button[data-act=label]").click();
  const field = page.locator("textarea.label-text");
  await field.waitFor();
  await field.fill("Работа в Педанте");
  let geom = await waitGeom(page, (item) => item.text === "Работа в Педанте");
  const born = { ...geom };
  assert(geom.secretsOnLabel === false, "у лейбла есть секрет");
  assert(geom.entry.hasSecret, "пароль пропал");

  await page.keyboard.press("Escape");
  const cursors = await page.evaluate(() => {
    const pick = (sel) => getComputedStyle(document.querySelector(sel)).cursor;
    return { e: pick(".resize.e"), s: pick(".resize.s"), se: pick(".resize.se"), ne: pick(".resize.ne") };
  });
  assert(cursors.e === "ew-resize", "курсор ширины " + cursors.e);
  assert(cursors.s === "ns-resize", "курсор высоты " + cursors.s);
  assert(cursors.se === "nwse-resize", "курсор диагонали " + cursors.se);
  assert(cursors.ne === "nesw-resize", "курсор диагонали " + cursors.ne);

  await dragHandle(page, "e", 80, 0);
  geom = await waitGeom(page, (item) => item.w > born.w + 60);
  assert(Math.abs(geom.x - born.x) < 1.5, "ширина сдвинула левый край");
  assert(Math.abs(geom.h - born.h) < 1.5, "ширина изменила высоту");
  const wide = { ...geom };

  await dragHandle(page, "s", 0, 50);
  geom = await waitGeom(page, (item) => item.h > wide.h + 35);
  assert(Math.abs(geom.w - wide.w) < 1.5, "высота изменила ширину");
  const tall = { ...geom };

  await dragHandle(page, "se", 46, 34);
  geom = await waitGeom(page, (item) => item.w > tall.w + 30 && item.h > tall.h + 20);
  assert(Math.abs(geom.x - tall.x) < 1.5 && Math.abs(geom.y - tall.y) < 1.5, "диагональ уехала");
  const sized = { ...geom };

  const labelBox = await page.locator("article.label").boundingBox();
  const startX = labelBox.x + 48;
  const startY = labelBox.y + labelBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 110, startY + 36, { steps: 12 });
  await page.mouse.up();
  geom = await waitGeom(page, (item) => Math.hypot(item.x - sized.x, item.y - sized.y) > 80);
  assert(Math.abs(geom.w - sized.w) < 1.5 && Math.abs(geom.h - sized.h) < 1.5, "перенос изменил размер");
  assert(Math.abs(geom.entry.x - born.entry.x) < 0.2 && Math.abs(geom.entry.y - born.entry.y) < 0.2, "пароль сдвинулся");
  const parked = { ...geom };

  await page.screenshot({ path: path.join(shots, "13-label.png") });
  await page.reload({ waitUntil: "networkidle" });
  geom = await labelGeom(page);
  assert(geom.text === "Работа в Педанте", "текст не сохранился");
  assert(Math.abs(geom.x - parked.x) < 0.2, "x не сохранился");
  assert(Math.abs(geom.y - parked.y) < 0.2, "y не сохранился");
  assert(Math.abs(geom.w - parked.w) < 0.2, "ширина не сохранилась");
  assert(Math.abs(geom.h - parked.h) < 0.2, "высота не сохранилась");
  assert(geom.entry.title === "Секрет" && geom.entry.hasSecret, "пароль не пережил перезагрузку");

  await page.locator("article.card .name").click();
  await page.locator("#sheet-name").waitFor();
  const sheetName = await page.locator("#sheet-name").innerText();
  assert(sheetName === "Секрет", "карточка не открылась");
  await page.locator("#sheet-close").click();

  await page.locator("article.label").hover();
  await page.locator(".label-x").click();
  await page.waitForFunction(async () => {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    return data.labels.length === 0 && data.entries.length === 1;
  });

  assert(errors.length === 0, errors.join("\n"));
  console.log(JSON.stringify({ cursors, born: { w: born.w, h: born.h }, parked }, null, 2));
  console.log("LABELS_OK");
  await browser.close();
}

main().catch((err) => {
  console.error("LABELS_FAIL");
  console.error(err);
  process.exit(1);
});
