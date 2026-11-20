const path = require("path");
const { chromium } = require(path.join(process.env.TEMP, "pole-playwright", "node_modules", "playwright"));

const base = process.env.POLE_URL || "http://127.0.0.1:8766";
const shots = path.join(__dirname, "screenshots");
const fs = require("fs");
fs.mkdirSync(shots, { recursive: true });

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const errors = [];
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("console: " + msg.text());
  });

  try {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.locator(".mark").waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(shots, "01-empty-dark.png") });

    await page.locator("#viewport").click({ position: { x: 520, y: 280 } });
    await page.locator("#menu").waitFor({ state: "visible" });
    const menuText = await page.locator("#menu").innerText();
    assert(menuText.includes("Создать пароль здесь"), "меню без создания: " + menuText);
    assert(menuText.includes("Выделить"), "меню без выделения: " + menuText);
    await page.screenshot({ path: path.join(shots, "02-menu.png") });
    await page.locator("#menu button[data-act=create]").click();
    await page.locator("#composer").waitFor({ state: "visible" });
    await page.locator("#composer input[name=title]").fill("Прод шлюз");
    await page.locator("#composer input[name=secret]").fill("s3cr3t-value");
    await page.locator("#composer input[name=username]").fill("root");
    await page.locator("#composer input[name=comment]").fill("заходить через vpn");
    await page.locator("#composer-tags button", { hasText: "Личное" }).click();
    await page.screenshot({ path: path.join(shots, "03-composer.png") });
    await page.locator("#composer button.primary").click();
    await page.locator("article.card", { hasText: "Прод шлюз" }).waitFor({ state: "visible" });
    await page.locator("#composer").waitFor({ state: "hidden" });

    const card = page.locator("article.card", { hasText: "Прод шлюз" });
    assert(await card.getAttribute("title") === null, "у карточки не должно быть native title");
    await card.hover();
    await page.waitForTimeout(400);
    const hint = page.locator("#hint");
    await hint.waitFor({ state: "visible" });
    const hintText = await hint.innerText();
    assert(hintText.toLocaleLowerCase("ru").includes("комментарий"), "нет подписи комментария: " + hintText);
    assert(hintText.includes("заходить через vpn"), "комментарий не в подсказке: " + hintText);
    await page.screenshot({ path: path.join(shots, "04-hint.png") });

    await card.locator(".secret").click();
    await page.waitForTimeout(100);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied === "s3cr3t-value", "в буфере не пароль: " + copied);

    await page.locator("#search").fill("vpn");
    await page.waitForTimeout(50);
    assert(await card.count() === 1, "поиск по комментарию не нашёл карточку");
    await page.locator("#search").fill("неттакого");
    await page.waitForTimeout(50);
    assert(await page.locator("article.card").count() === 0, "поиск не скрыл лишнее");
    await page.locator("#search").fill("");
    await page.locator("#tabbuttons .tab", { hasText: "Pedant" }).click();
    await page.waitForTimeout(50);
    assert(await page.locator("article.card").count() === 0, "чужая вкладка показывает карточку");
    await page.locator("#tabbuttons .tab", { hasText: "Личное" }).click();
    await page.locator("article.card", { hasText: "Прод шлюз" }).waitFor({ state: "visible" });
    await page.locator("#tabbuttons .tab", { hasText: "Все" }).click();

    await card.locator(".name").click();
    await page.locator("#sheet").waitFor({ state: "visible" });
    assert((await page.locator("#f-title").inputValue()) === "Прод шлюз", "имя в карточке");
    assert((await page.locator("#f-comment").inputValue()) === "заходить через vpn", "комментарий в карточке");
    await page.screenshot({ path: path.join(shots, "05-sheet-dark.png") });
    await page.locator("#sheet-close").click();

    const started = await page.locator("html").getAttribute("data-theme");
    await page.locator("#theme").click();
    const toggled = await page.locator("html").getAttribute("data-theme");
    assert(toggled && toggled !== started, "тема не переключилась: " + started + " -> " + toggled);
    await page.screenshot({ path: path.join(shots, "06-toggled-" + toggled + ".png") });
    await page.reload({ waitUntil: "networkidle" });
    assert((await page.locator("html").getAttribute("data-theme")) === toggled, "тема не сохранилась");
    await page.locator("article.card", { hasText: "Прод шлюз" }).waitFor({ state: "visible" });
    await page.evaluate(() => {
      localStorage.setItem("pole.theme", "dark");
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({ path: path.join(shots, "06-dark.png") });
    await page.evaluate(() => {
      localStorage.setItem("pole.theme", "light");
      document.documentElement.dataset.theme = "light";
    });
    await page.screenshot({ path: path.join(shots, "06-light.png") });
    await page.evaluate(() => {
      localStorage.setItem("pole.theme", "dark");
      document.documentElement.dataset.theme = "dark";
    });

    const graph = await page.evaluate(async () => {
      const data = await fetch("/api/bootstrap").then((r) => r.json());
      return data;
    });
    const gate = graph.entries.find((entry) => entry.title === "Прод шлюз");
    assert(gate, "запись не попала в базу");
    await page.evaluate(async (origin) => {
      const post = (body) => fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await post({ title: "Бастион", secret: "bbb", username: "ops", kind: "ssh", x: origin.x + 380, y: origin.y, comment: "вторая машина" });
      await post({ title: "Сторож", secret: "ccc", kind: "system", x: origin.x, y: origin.y + 340, comment: "не связан" });
    }, gate);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("article.card", { hasText: "Бастион" }).waitFor({ state: "visible" });
    await page.locator("article.card", { hasText: "Сторож" }).waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(shots, "07-three.png") });

    const gateCard = page.locator("article.card", { hasText: "Прод шлюз" });
    const bastion = page.locator("article.card", { hasText: "Бастион" });
    const a = await gateCard.boundingBox();
    const b = await bastion.boundingBox();
    await page.mouse.move(a.x + 28, a.y + 16);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.screenshot({ path: path.join(shots, "08-drop.png") });
    const linkWait = page.waitForResponse((res) => res.url().includes("/api/links") && res.request().method() === "POST", { timeout: 4000 });
    await page.mouse.up();
    const linkRes = await linkWait;
    const linkBody = await linkRes.json();
    assert(linkBody.created === true, "связь не создалась: " + JSON.stringify(linkBody));
    await page.waitForTimeout(200);
    assert(await page.locator("path.wire-vis").count() === 1, "линия связи не нарисована");
    await page.screenshot({ path: path.join(shots, "09-linked.png") });

    const before = await page.evaluate(async () => {
      const data = await fetch("/api/bootstrap").then((r) => r.json());
      const by = Object.fromEntries(data.entries.map((entry) => [entry.title, entry]));
      return { gate: by["Прод шлюз"], bastion: by["Бастион"], watch: by["Сторож"] };
    });
    const handle = page.locator("article.card", { hasText: "Бастион" }).locator(".name");
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 220, box.y + box.height / 2, { steps: 16 });
    await page.screenshot({ path: path.join(shots, "10-rubber.png") });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.evaluate(async () => {
      const data = await fetch("/api/bootstrap").then((r) => r.json());
      const by = Object.fromEntries(data.entries.map((entry) => [entry.title, entry]));
      return { gate: by["Прод шлюз"], bastion: by["Бастион"], watch: by["Сторож"] };
    });
    const gateDx = Math.abs(after.gate.x - before.gate.x);
    const bastionDx = Math.hypot(after.bastion.x - before.bastion.x, after.bastion.y - before.bastion.y);
    const watchDx = Math.hypot(after.watch.x - before.watch.x, after.watch.y - before.watch.y);
    console.log(JSON.stringify({ gateDx, bastionDx, watchDx, before, after }, null, 2));
    assert(bastionDx > 40, "карточка не уехала");
    assert(gateDx > 8, "связанная карточка не потянулась");
    assert(gateDx < bastionDx - 5, "связанная уехала так же, без растяжения");
    assert(watchDx < 3, "чужая карточка сдвинулась: " + watchDx);

    await page.reload({ waitUntil: "networkidle" });
    const restored = await page.evaluate(async () => {
      const data = await fetch("/api/bootstrap").then((r) => r.json());
      return data.entries.find((entry) => entry.title === "Прод шлюз");
    });
    assert(Math.abs(restored.x - after.gate.x) < 0.2, "позиция не сохранилась");
    await page.screenshot({ path: path.join(shots, "11-restored.png") });

    const realErrors = errors.filter((line) => !line.includes("favicon"));
    assert(realErrors.length === 0, realErrors.join("\n"));
    console.log("UI_OK");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("UI_FAIL");
  console.error(err);
  process.exit(1);
});
