import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] || "http://127.0.0.1:8123/";
mkdirSync(new URL("./shots/", import.meta.url).pathname, { recursive: true });
const dir = new URL("./shots/", import.meta.url).pathname;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const problems = [];
page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning") problems.push(t + ": " + m.text());
  if (m.text().startsWith("lax-report")) console.log(m.text());
});
page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
page.on("requestfailed", (r) => problems.push("requestfailed: " + r.url() + " " + r.failure()?.errorText));

await page.goto(base, { waitUntil: "load" });
await page.waitForSelector("body[data-ready='1']", { timeout: 60000 });
await page.waitForTimeout(400);

const shot = async (name, clip) => {
  await page.screenshot({ path: dir + name + ".png", clip, fullPage: true, animations: "disabled" });
  console.log("wrote", name + ".png");
};

// whole document
await page.screenshot({ path: dir + "full.png", fullPage: true });
console.log("wrote full.png");

const box = async (sel) => await page.locator(sel).boundingBox();
const docTop = async (sel) => await page.evaluate((s) => {
  const el = document.querySelector(s);
  const r = el.getBoundingClientRect();
  return { x: r.x + window.scrollX, y: r.y + window.scrollY, h: r.height };
}, sel);
const p1 = await docTop("#page1");
const p2 = await docTop("#page2");
const p3 = await docTop("#page3");
await shot("page1-top", { x: p1.x - 8, y: p1.y - 8, width: 1064, height: 640 });
await shot("page1-bottom", { x: p1.x - 8, y: p1.y + p1.h - 640, width: 1064, height: 648 });
await shot("page2-top", { x: p2.x - 8, y: p2.y - 8, width: 1064, height: 640 });
await shot("page2-bottom", { x: p2.x - 8, y: p2.y + p2.h - 640, width: 1064, height: 648 });
await shot("page3-top", { x: p3.x - 8, y: p3.y - 8, width: 1064, height: 520 });

// interaction: click the card of range 3, then the highlight of range 5
await page.locator("#m3").click();
await page.waitForTimeout(300);
await page.screenshot({ path: dir + "click-card3.png" });
console.log("wrote click-card3.png");
await page.evaluate(() => window.scrollTo(0, 0));
await page.locator(".hl-5").first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: dir + "click-highlight5.png" });
console.log("wrote click-highlight5.png");

console.log("report", JSON.stringify(await page.evaluate(() => window.__laxReport), null, 1));
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "no console errors");
await browser.close();
