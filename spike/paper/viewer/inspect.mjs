import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";

const data = new Uint8Array(readFileSync("fixture/main.pdf"));
const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;
const dests = await doc.getDestinations();
const pageIndex = new Map();
const out = [];
const entries = dests instanceof Map ? [...dests] : Object.entries(dests);
for (const [name, dest] of entries) {
  const m = /^lax\.(\d+)\.([be])$/.exec(name);
  if (!m) { console.log("non-lax dest", name, dest); continue; }
  const ref = dest[0];
  const idx = await doc.getPageIndex(ref);
  out.push({ n: Number(m[1]), kind: m[2], page: idx + 1, type: dest[1]?.name, x: dest[2], y: dest[3], z: dest[4], raw: JSON.stringify(dest) });
}
out.sort((a, b) => a.n - b.n || (a.kind < b.kind ? -1 : 1));
for (const d of out) console.log(`lax.${d.n}.${d.kind}  page ${d.page}  ${d.type}  x=${d.x}  y=${d.y}  z=${d.z}`);
console.log("pages", doc.numPages);
const p1 = await doc.getPage(1);
console.log("view", p1.view, "rotate", p1.rotate);
