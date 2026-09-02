import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
for (const q of ["", "?nomode=1"]) {
  await p.goto("http://127.0.0.1:8123/" + q, { waitUntil: "load" });
  await p.waitForSelector("body[data-ready='1']");
  const r = await p.evaluate(() => window.__laxReport.ranges);
  console.log("--- " + (q || "(mode tags)"));
  for (const x of r) console.log(` n=${x.n} b=p${x.begin.page}#${x.begin.item} e=p${x.end.page}#${x.end.item}  starts "${x.firstText.slice(0,42)}"  ends "${x.lastText.slice(-42)}"`);
}
for (const [q, name] of [["", "range6-modetag"], ["?nomode=1", "range6-nomode"]]) {
  await p.goto("http://127.0.0.1:8123/" + q, { waitUntil: "load" });
  await p.waitForSelector("body[data-ready='1']");
  const box = await p.evaluate(() => {
    const el = document.querySelector(".hl-6");
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY };
  });
  await p.screenshot({
    path: new URL("./shots/" + name + ".png", import.meta.url).pathname,
    fullPage: true,
    clip: { x: box.x - 320, y: box.y - 120, width: 700, height: 240 },
  });
  console.log("wrote " + name + ".png");
}
await b.close();
