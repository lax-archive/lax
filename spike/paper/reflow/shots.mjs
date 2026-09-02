// P2-11 render + reflow check: serve site/, render at two viewport widths,
// assert the block painted (SVG present, no .latex-missing-glyph), assert the
// line breaks actually differ between the widths (the reflow proof), and save
// screenshots into shots/.
//
//   node shots.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const SITE = new URL("./site/", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".otf": "font/otf" };

const server = createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(join(SITE, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(8137, resolve));

const browser = await chromium
  .launch()
  .catch(() => chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }));

async function renderAt(width, mode) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:8137/", { waitUntil: "networkidle" });
  await page.waitForSelector(".latex-block svg", { timeout: 15000 });
  if (mode) await page.evaluate((m) => window.__setWidth(m), mode); // template width switch
  await page.waitForTimeout(600); // fonts + lazy paint + reflow settle
  const stats = await page.evaluate(() => {
    const block = document.querySelector(".latex-block");
    return {
      svgs: block.querySelectorAll("svg").length,
      texts: block.querySelectorAll("text").length,
      missing: document.querySelectorAll(".latex-missing-glyph").length,
      height: Math.round(block.getBoundingClientRect().height),
    };
  });
  await page.screenshot({ path: `shots/reflow-${width}.png`, clip: { x: 0, y: 0, width, height: 1000 } });
  await page.close();
  return { width, errors, ...stats };
}

const wide = await renderAt(1400, "wide");   // 64rem column
const narrow = await renderAt(700, "narrow"); // 34rem column
console.log(JSON.stringify(wide));
console.log(JSON.stringify(narrow));

let fail = 0;
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); fail = 1; } };
assert(wide.svgs > 0 && narrow.svgs > 0, "no SVG rendered");
assert(wide.missing === 0 && narrow.missing === 0, "missing-glyph markers present");
assert(wide.errors.length === 0 && narrow.errors.length === 0,
  `page errors: ${wide.errors} ${narrow.errors}`);
assert(narrow.height > wide.height, "narrow render is not taller than wide render");
// The reflow proof: paragraphs paint one <text> per broken line, so a narrower
// column must produce more lines.
assert(narrow.texts > wide.texts, "line count did not change with width");
if (!fail) console.log("OK: rendered at both widths, no missing glyphs, line breaks differ");
await browser.close();
server.close();
process.exit(fail);
