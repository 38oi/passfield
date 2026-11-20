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
  await page.addInitScript(() => localStorage.setItem("pole.theme", "dark"));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator("article.card", { hasText: "Бастион" }).waitFor();

  const before = await page.evaluate(async () => {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    return Object.fromEntries(data.entries.map((entry) => [entry.title, { x: entry.x, y: entry.y }]));
  });

  const handle = page.locator("article.card", { hasText: "Бастион" }).locator(".name");
  const box = await handle.boundingBox();
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 280, startY + 40, { steps: 18 });
  await page.screenshot({ path: path.join(shots, "10-rubber.png") });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await page.evaluate(async () => {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    return Object.fromEntries(data.entries.map((entry) => [entry.title, { x: entry.x, y: entry.y }]));
  });
  const moved = (name) => Math.hypot(after[name].x - before[name].x, after[name].y - before[name].y);
  const bastion = moved("Бастион");
  const gate = moved("Прод шлюз");
  const watch = moved("Сторож");
  console.log(JSON.stringify({ bastion, gate, watch, before, after }, null, 2));
  assert(bastion > 80, "бастион не уехал");
  assert(gate > 12, "связанный не потянулся");
  assert(gate < bastion - 8, "нет растяжения, связанный уехал так же");
  assert(watch < 3, "сторож сдвинулся " + watch);

  await page.reload({ waitUntil: "networkidle" });
  const restored = await page.evaluate(async () => {
    const data = await fetch("/api/bootstrap").then((r) => r.json());
    return data.entries.find((entry) => entry.title === "Бастион");
  });
  assert(Math.abs(restored.x - after["Бастион"].x) < 0.2, "позиция не сохранилась");
  await page.screenshot({ path: path.join(shots, "11-restored.png") });
  assert(errors.length === 0, errors.join("\n"));
  console.log("RUBBER_OK");
  await browser.close();
}

main().catch((err) => {
  console.error("RUBBER_FAIL");
  console.error(err);
  process.exit(1);
});
