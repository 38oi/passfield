const path = require("path");
const { chromium } = require(path.join(process.env.TEMP, "pole-playwright", "node_modules", "playwright"));

const base = "http://127.0.0.1:8766";
const shots = path.join(__dirname, "screenshots");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.addInitScript(() => {
    localStorage.setItem("pole.theme", "dark");
    localStorage.setItem("pole.mode", "pass");
  });
  await page.goto(base, { waitUntil: "networkidle" });

  await page.locator("#mode-notes").click();
  await page.locator("#notes-shell").waitFor({ state: "visible" });
  await page.locator("#note-new").click();
  await page.waitForFunction(() => document.querySelectorAll(".note-row").length >= 1);
  await page.locator("#note-title").fill("Деплой nginx");
  await page.locator(".nb.text").click();
  await page.keyboard.type("Инструкция по выкладке ");
  await page.locator("button[data-cmd=bold]").click();
  await page.keyboard.type("прода");
  await page.locator("button[data-cmd=code]").click();
  await page.locator(".nb.code pre").click();
  await page.keyboard.type("systemctl reload nginx");
  await page.locator("#note-title").click();
  await page.waitForTimeout(500);

  const saved = await page.waitForFunction(async () => {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    const note = data.notes.find((item) => item.title === "Деплой nginx");
    if (!note) return null;
    const code = note.body.blocks.find((block) => block.type === "code");
    return code && code.text.includes("systemctl reload nginx") ? note.id : null;
  });
  assert(await saved.jsonValue(), "статья не сохранилась");

  const beforeSecond = await page.locator(".note-row").count();
  await page.locator("#note-new").click();
  await page.waitForFunction((n) => document.querySelectorAll(".note-row").length > n, beforeSecond);
  await page.waitForFunction(() => document.getElementById("note-title").value === "Без названия");
  await page.locator("#note-title").fill("Откат");
  await page.waitForTimeout(500);

  const rows = page.locator(".note-row");
  await rows.first().waitFor();
  const countBefore = await rows.count();
  assert(countBefore >= 2, "мало статей");

  const source = page.locator(".note-row", { hasText: "Откат" });
  const target = page.locator(".note-row", { hasText: "Деплой nginx" });
  const s = await source.boundingBox();
  const t = await target.boundingBox();
  await page.mouse.move(s.x + 40, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + 40, t.y + t.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const folder = await page.waitForFunction(async () => {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    return data.notes.some((item) => item.kind === "folder" && item.title === "Деплой nginx");
  });
  assert(await folder.jsonValue(), "папка не создалась");

  await page.locator("#mode-pass").click();
  await page.locator("#viewport").waitFor({ state: "visible" });
  await page.mouse.click(220, 420);
  await page.locator("#menu button[data-act=create]").click();
  await page.locator("#composer input[name=title]").fill("Шлюз поиска");
  await page.locator("#composer input[name=secret]").fill("find-me-secret");
  await page.locator("#composer input[name=comment]").fill("комментарий для поиска");
  await page.locator("#composer button[type=submit]").click();
  await page.locator("article.card", { hasText: "Шлюз поиска" }).waitFor();

  await page.locator("#search").fill("systemctl");
  await page.locator(".searchhit", { hasText: "Деплой nginx" }).waitFor();
  await page.locator(".searchhit", { hasText: "Деплой nginx" }).click();
  await page.locator("#notes-shell").waitFor({ state: "visible" });
  await page.locator(".search-mark").waitFor();
  const markText = await page.locator(".search-mark").first().innerText();
  assert(markText.toLowerCase().includes("systemctl"), "нет подсветки " + markText);

  await page.locator("#search").fill("Шлюз");
  await page.locator(".searchhit", { hasText: "Шлюз поиска" }).click();
  await page.locator("#pass-shell").waitFor({ state: "visible" });
  await page.locator("#sheet-name").waitFor();
  assert((await page.locator("#sheet-name").innerText()) === "Шлюз поиска", "пароль не открылся");

  const encrypted = await page.evaluate(async () => {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    return data.notes.some((note) => (note.body?.blocks || []).some((block) => (block.text || "").includes("systemctl")));
  });
  assert(encrypted, "тело не пришло расшифрованным в bootstrap");

  await page.screenshot({ path: path.join(shots, "14-notes.png") });
  assert(errors.length === 0, errors.join("\n"));
  console.log("NOTES_OK");
  await browser.close();
}

main().catch((err) => {
  console.error("NOTES_FAIL");
  console.error(err);
  process.exit(1);
});
