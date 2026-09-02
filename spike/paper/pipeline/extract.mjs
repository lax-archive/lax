#!/usr/bin/env node
// Lax paper-layer destination extractor (spike).
//
//   node extract.mjs <pdf> [marks.json]
//
// Reads every `lax.<n>.<b|e>` named destination out of the PDF with pdf.js
// (legacy build, pure JS) and checks it against the rewriter's mark table.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfjsPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjs = await import(pdfjsPath);

const [, , pdfPath, tablePath] = process.argv;
if (!pdfPath) {
  console.error("usage: extract.mjs <pdf> [marks.json]");
  process.exit(2);
}

const data = new Uint8Array(fs.readFileSync(pdfPath));
const loadingTask = pdfjs.getDocument({ data, useSystemFonts: false });
const doc = await loadingTask.promise;

const pages = [];
for (let i = 1; i <= doc.numPages; i++) {
  const p = await doc.getPage(i);
  pages.push({ page: i, view: p.view, rotate: p.rotate });
}

// getDestinations() -> name => [ref, {name:'XYZ'}, x, y, zoom].
// pdfjs-dist >= 5 returns a Map here; older versions a plain object.
const rawDests = await doc.getDestinations();
const dests = rawDests instanceof Map ? rawDests : new Map(Object.entries(rawDests ?? {}));

const found = [];
const unknown = [];
for (const [name, dest] of dests) {
  const m = /^lax\.(\d+)\.([be])$/.exec(name);
  if (!name.startsWith("lax.")) continue;
  if (!m) {
    unknown.push({ name, reason: "does not match lax.<n>.<b|e>" });
    continue;
  }
  let pageIndex = null;
  try {
    pageIndex = await doc.getPageIndex(dest[0]);
  } catch (e) {
    unknown.push({ name, reason: "unresolvable page ref: " + e.message });
    continue;
  }
  found.push({
    name,
    n: Number(m[1]),
    kind: m[2],
    page: pageIndex + 1,
    x: dest[2] === null || dest[2] === undefined ? null : Math.round(dest[2] * 100) / 100,
    y: dest[3] === null || dest[3] === undefined ? null : Math.round(dest[3] * 100) / 100,
    destType: dest[1] && dest[1].name,
  });
}
found.sort((a, b) => a.n - b.n || (a.kind === "b" ? -1 : 1));

// ---- count check -------------------------------------------------------
const table = tablePath && fs.existsSync(tablePath)
  ? JSON.parse(fs.readFileSync(tablePath, "utf8"))
  : null;
const problems = [];
const byN = new Map();
for (const f of found) {
  if (!byN.has(f.n)) byN.set(f.n, {});
  const slot = byN.get(f.n);
  if (slot[f.kind]) problems.push(`duplicate destination lax.${f.n}.${f.kind}`);
  slot[f.kind] = f;
}
for (const u of unknown) problems.push(`unknown lax destination ${u.name}: ${u.reason}`);

const marks = [];
if (table) {
  for (const { n, id } of table) {
    const slot = byN.get(n);
    if (!slot || !slot.b || !slot.e) {
      const missing = [!slot || !slot.b ? "begin" : null, !slot || !slot.e ? "end" : null]
        .filter(Boolean).join(" and ");
      problems.push(`mark ${n} (${id}): missing ${missing} destination in the PDF ` +
        `- the marker landed in verbatim, listings, or a moving argument`);
      continue;
    }
    const before = slot.b.page < slot.e.page || (slot.b.page === slot.e.page && slot.b.y >= slot.e.y);
    if (!before) problems.push(`mark ${n} (${id}): end precedes begin in reading order`);
    marks.push({
      id, n,
      begin: { page: slot.b.page, x: slot.b.x, y: slot.b.y },
      end: { page: slot.e.page, x: slot.e.x, y: slot.e.y },
      spansPage: slot.b.page !== slot.e.page,
    });
  }
  for (const n of byN.keys()) {
    if (!table.some((t) => t.n === n)) problems.push(`destination for unknown mark number ${n}`);
  }
  const expected = table.length * 2;
  if (found.length !== expected) {
    problems.push(`destination count ${found.length} != 2 x ${table.length} marks in the table`);
  }
}

const result = {
  pdf: path.resolve(pdfPath),
  pages: doc.numPages,
  pageViews: pages.map((p) => p.view),
  destinationsTotal: dests.size,
  laxDestinations: found,
  marks,
  ok: problems.length === 0,
  problems,
};
console.log(JSON.stringify(result, null, 2));

console.error("");
console.error(`pages: ${result.pages}   dests total: ${result.destinationsTotal}   lax dests: ${found.length}`);
if (table) console.error(`mark table: ${table.length} marks -> expected ${table.length * 2} destinations`);
for (const m of marks) {
  console.error(
    `  ${String(m.n).padStart(2)} ${m.id.padEnd(24)} b p${m.begin.page} (${m.begin.x}, ${m.begin.y})` +
    `  e p${m.end.page} (${m.end.x}, ${m.end.y})${m.spansPage ? "   [spans page break]" : ""}`
  );
}
console.error(problems.length ? "COUNT CHECK FAILED:" : "count check: OK");
for (const p of problems) console.error("  - " + p);
await loadingTask.destroy();
process.exit(0);
