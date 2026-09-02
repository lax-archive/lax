// Lax paper viewer spike.
//
// Reads `lax.<n>.b` / `lax.<n>.e` named destinations out of paper.pdf, maps
// each one to a boundary text item by walking the page's text items in
// content-stream order, and paints one highlight per range plus a margin card.
//
// Everything is loaded from same-origin files: the page is served with
//   default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; ...
// so there are no inline scripts and no CDN.

import * as pdfjsLib from "./vendor/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;

const PAGE_WIDTH_PX = 700; // rendered width of a page, CSS px
const YTOL = 3;            // pt — two baselines this close count as one line
const COL_JUMP = 20;       // pt — baseline jumping up by this much starts a new block (new column)
const GAP_SPLIT = 22;      // pt — baseline dropping by this much starts a new block (heading, folio)

const COLORS = [
  null,
  "rgba(255, 214, 0, 0.42)",   // 1
  "rgba(0, 160, 255, 0.30)",   // 2
  "rgba(255, 96, 0, 0.28)",    // 3
  "rgba(0, 190, 120, 0.32)",   // 4
  "rgba(190, 0, 220, 0.28)",   // 5
  "rgba(220, 0, 60, 0.26)",    // 6
];

const LABELS = {
  1: ["Definition 1 (block range)", "own-line markers around the definition environment"],
  2: ["Inline phrase", "three words mid-sentence, both markers inside one line"],
  3: ["Across a page break", "begins in column 2 of page 1, ends in column 1 of page 2"],
  4: ["Across a column break", "begins near the foot of column 1, ends in column 2 of page 2"],
  5: ["Nested in range 1", "inside the definition, from the family to the subtree clause"],
  6: ["Begin marker at a line start", "the ambiguous case: an inline marker whose destination sits on the column's left edge"],
};

const status = document.getElementById("status");
const pagesEl = document.getElementById("pages");
const marginEl = document.getElementById("margin");

main().catch((err) => {
  console.error("viewer failed", err);
  status.textContent = "failed: " + err.message;
});

async function main() {
  const t0 = performance.now();
  const doc = await pdfjsLib.getDocument({ url: "paper.pdf" }).promise;
  const tLoaded = performance.now();

  const ranges = await readMarks(doc);
  const tDests = performance.now();

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) pages.push(await renderPage(doc, p));
  const tRendered = performance.now();

  const placed = [];
  for (const r of ranges) {
    const hit = resolveRange(r, pages);
    if (!hit) {
      console.error("range " + r.n + " could not be resolved");
      continue;
    }
    placed.push(hit);
  }
  paint(placed, pages);

  const report = {
    pages: doc.numPages,
    ranges: placed.map((h) => ({
      n: h.range.n,
      begin: h.begin,
      end: h.end,
      firstText: h.firstText,
      lastText: h.lastText,
    })),
    ms: {
      load: +(tLoaded - t0).toFixed(1),
      dests: +(tDests - tLoaded).toFixed(1),
      render: +(tRendered - tDests).toFixed(1),
      total: +(performance.now() - t0).toFixed(1),
    },
  };
  window.__laxReport = report;
  console.log("lax-report " + JSON.stringify(report));
  status.textContent =
    doc.numPages + " pages, " + placed.length + " ranges, rendered in " +
    report.ms.render.toFixed(0) + " ms (total " + report.ms.total.toFixed(0) + " ms)";
  document.body.dataset.ready = "1";
}

// ---------------------------------------------------------------- destinations

// ?nomode=1 ignores the mode-tagged twins, i.e. it runs the boundary rule with
// exactly the destinations paper-plan.md's laxmark.sty emits today.
const IGNORE_MODE = new URLSearchParams(location.search).has("nomode");

async function readMarks(doc) {
  const raw = await doc.getDestinations();
  // pdf.js >= 4 hands back a Map here, not the plain object the old docs show.
  const entries = raw instanceof Map ? [...raw] : Object.entries(raw);
  const byN = new Map();
  for (const [name, dest] of entries) {
    const m = /^lax\.(\d+)\.([be])(?:\.([vh]))?$/.exec(name);
    if (!m) {
      console.warn("unknown destination", name);
      continue;
    }
    const n = Number(m[1]);
    const kind = m[2];
    const mode = m[3] || null;
    const ref = dest[0];
    const page = typeof ref === "number" ? ref + 1 : (await doc.getPageIndex(ref)) + 1;
    const rec = byN.get(n) || { n, b: null, e: null };
    byN.set(n, rec);
    const point = rec[kind] || {};
    // The mode-tagged twin (lax.<n>.b.v / .h) carries no coordinates we do not
    // already have; it only tells us whether TeX was in vertical or horizontal
    // mode when the destination was emitted.
    if (mode) { if (!IGNORE_MODE) point.mode = mode; }
    else {
      point.page = page;
      point.x = dest[2];
      point.y = dest[3];
    }
    rec[kind] = point;
  }
  return [...byN.values()].filter((r) => r.b && r.e).sort((a, b) => a.n - b.n);
}

// ------------------------------------------------------------------- rendering

async function renderPage(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const unscaled = page.getViewport({ scale: 1 });
  const scale = PAGE_WIDTH_PX / unscaled.width;
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  const el = document.createElement("div");
  el.className = "page";
  el.id = "page" + pageNo;
  el.style.width = viewport.width + "px";
  el.style.height = viewport.height + "px";
  el.style.setProperty("--scale-factor", String(scale));
  el.style.setProperty("--total-scale-factor", String(scale));
  pagesEl.append(el);

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  el.append(canvas);
  const ctx = canvas.getContext("2d");
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
  }).promise;

  const textContent = await page.getTextContent();

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  el.append(textLayerDiv);
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();

  const hl = document.createElement("div");
  hl.className = "hl-layer";
  el.append(hl);

  const items = textContent.items.filter((it) => !it.type); // drop marked-content pseudo items
  const blocks = computeBlocks(items);
  return { pageNo, el, hl, viewport, scale, items, blocks, flow: flowSpan(blocks) };
}

// ----------------------------------------------------------------- block model
//
// Content-stream order is reading order for a LaTeX page: column 1 top to
// bottom, then column 2, then the folio. Within one column the baseline
// decreases monotonically, so a *rise* in baseline means the stream moved to
// the next column (or the next float). That is the only structure we need:
// blocks are runs of the content order, never a re-sort of it.

function computeBlocks(items) {
  const blocks = [];
  let cur = null;
  items.forEach((it, i) => {
    const y = it.transform[5];
    if (cur && (y > cur.minY + COL_JUMP || y < cur.lastY - GAP_SPLIT)) {
      blocks.push(cur);
      cur = null;
    }
    if (!cur) cur = { idx: [], minY: y, maxY: y, x0: Infinity, x1: -Infinity, lastY: y };
    cur.idx.push(i);
    cur.minY = Math.min(cur.minY, y);
    cur.maxY = Math.max(cur.maxY, y);
    cur.lastY = y;
    if (it.width > 0) {
      cur.x0 = Math.min(cur.x0, it.transform[4]);
      cur.x1 = Math.max(cur.x1, it.transform[4] + it.width);
    }
  });
  if (cur) blocks.push(cur);
  return blocks;
}

// The folio ("2" at the foot of the page) is in content order at the very end
// of the page but is not part of the flow: a range that runs to the end of a
// page must not swallow it.
function flowSpan(blocks) {
  let last = blocks.length - 1;
  while (last > 0) {
    const b = blocks[last];
    const prev = blocks[last - 1];
    if (b.idx.length <= 3 && b.maxY < prev.minY - 15) last--;
    else break;
  }
  return { first: blocks[0].idx[0], last: blocks[last].idx[blocks[last].idx.length - 1] };
}

function findBlock(blocks, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const b of blocks) {
    const dx = Math.max(b.x0 - x, x - b.x1, 0);
    const dy = Math.max(b.minY - y, y - b.maxY, 0);
    const d = Math.hypot(dx, dy);
    if (d < bestD - 1e-6) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function sameLine(pd, blk, y) {
  return blk.idx.filter((i) => Math.abs(pd.items[i].transform[5] - y) <= YTOL);
}

// ------------------------------------------------------------ boundary finding
//
// The rule, for a begin point (page P, x, y) with TeX mode m:
//
//  0. Pick the block (column) the point belongs to: the one whose bounding box
//     contains it, else the nearest one. Never compare y across blocks — in two
//     columns the same baseline occurs twice on a page.
//  1. Let S be the items of that block whose baseline is within 3 pt of y
//     (3 pt keeps subscripts on their line and is far below the 12 pt leading).
//  2. m = h (destination emitted inside a line): the first item of S whose
//     right edge is past x. If the item straddles x, the highlight is clipped
//     at x, so no per-character work is needed. If nothing on the line reaches
//     past x, take the first item after S.
//  3. m = v (destination emitted between blocks): S, if it is non-empty, is the
//     *preceding* line — pdfTeX reports the baseline of the last line already
//     typeset — so the range starts at the first item after S.
//  4. S empty (the point falls between two baselines): the first item of the
//     block below y. If the block has none, the first item of the next block:
//     that is what makes "begins at the foot of column 1" land in column 2.
//  5. Nothing left on the page: the first flow item of the next page.
//
// End points are the mirror image, with "last" for "first" and the clip on the
// right edge. Everything past step 0 is content order; y and x are used only to
// find the two boundary items.

function resolveBegin(pd, mark) {
  const blk = findBlock(pd.blocks, mark.x, mark.y);
  const S = sameLine(pd, blk, mark.y);
  const mode = mark.mode || guessMode(pd, S, mark);
  if (S.length) {
    if (mode === "h") {
      for (const i of S) {
        const it = pd.items[i];
        if (it.transform[4] + it.width > mark.x + 0.1) return { index: i, clipX: mark.x };
      }
    }
    const after = S[S.length - 1] + 1;
    return after <= pd.flow.last ? { index: after } : { overflow: true };
  }
  for (const i of blk.idx) if (pd.items[i].transform[5] < mark.y - YTOL) return { index: i };
  const next = pd.blocks[pd.blocks.indexOf(blk) + 1];
  if (next && next.idx[0] <= pd.flow.last) return { index: next.idx[0] };
  return { overflow: true };
}

function resolveEnd(pd, mark) {
  const blk = findBlock(pd.blocks, mark.x, mark.y);
  const S = sameLine(pd, blk, mark.y);
  const mode = mark.mode || guessMode(pd, S, mark);
  if (S.length) {
    if (mode === "h") {
      for (let k = S.length - 1; k >= 0; k--) {
        const it = pd.items[S[k]];
        if (it.transform[4] < mark.x - 0.1) return { index: S[k], clipX: mark.x };
      }
      const before = S[0] - 1;
      return before >= pd.flow.first ? { index: before } : { underflow: true };
    }
    return { index: S[S.length - 1] };
  }
  let last = -1;
  for (const i of blk.idx) if (pd.items[i].transform[5] > mark.y + YTOL) last = i;
  if (last >= 0) return { index: last };
  const prev = pd.blocks[pd.blocks.indexOf(blk) - 1];
  if (prev) return { index: prev.idx[prev.idx.length - 1] };
  return { underflow: true };
}

// Fallback for a plain `lax.<n>.b` with no mode twin: a destination sitting at
// the left edge of the line it shares a baseline with is *probably* a
// vertical-mode marker sitting after that line. Probably — see REPORT.md.
function guessMode(pd, S, mark) {
  if (!S.length) return "v";
  let left = Infinity;
  for (const i of S) left = Math.min(left, pd.items[i].transform[4]);
  return mark.x > left + 0.5 ? "h" : "v";
}

// ------------------------------------------------------------------- ranges

function resolveRange(range, pages) {
  const pb = pages[range.b.page - 1];
  const pe = pages[range.e.page - 1];
  if (!pb || !pe) return null;

  let begin = resolveBegin(pb, range.b);
  let bPage = range.b.page;
  while (begin.overflow) {
    const nxt = pages[bPage];
    if (!nxt) return null;
    bPage += 1;
    begin = { index: nxt.flow.first };
  }

  let end = resolveEnd(pe, range.e);
  let ePage = range.e.page;
  while (end.underflow) {
    const prv = pages[ePage - 2];
    if (!prv) return null;
    ePage -= 1;
    end = { index: prv.flow.last };
  }

  const segments = [];
  for (let p = bPage; p <= ePage; p++) {
    const pd = pages[p - 1];
    const from = p === bPage ? begin.index : pd.flow.first;
    const to = p === ePage ? end.index : pd.flow.last;
    if (to < from) continue;
    segments.push({
      pd,
      from,
      to,
      clipLeft: p === bPage ? begin.clipX : undefined,
      clipRight: p === ePage ? end.clipX : undefined,
    });
  }
  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];
  return {
    range,
    segments,
    begin: { page: bPage, item: begin.index, clipX: begin.clipX ?? null },
    end: { page: ePage, item: end.index, clipX: end.clipX ?? null },
    firstText: snippet(firstSeg.pd.items, firstSeg.from, +1),
    lastText: snippet(lastSeg.pd.items, lastSeg.to, -1),
  };
}

function snippet(items, i, dir) {
  let out = "";
  for (let k = 0; k < 6 && i + k * dir >= 0 && i + k * dir < items.length; k++) {
    const s = items[i + k * dir].str;
    out = dir > 0 ? out + s : s + out;
    if (out.replace(/\s/g, "").length > 24) break;
  }
  return out.slice(0, 60);
}

// ------------------------------------------------------------------- painting

function rectsForSegment(seg) {
  const { pd, from, to } = seg;
  const lines = [];
  let cur = null;
  for (let i = from; i <= to; i++) {
    const it = pd.items[i];
    if (!it || it.width <= 0) continue;
    const y = it.transform[5];
    let x0 = it.transform[4];
    let x1 = x0 + it.width;
    if (i === from && seg.clipLeft !== undefined) x0 = Math.max(x0, seg.clipLeft);
    if (i === to && seg.clipRight !== undefined) x1 = Math.min(x1, seg.clipRight);
    if (x1 <= x0) continue;
    const h = it.height || 10;
    if (cur && Math.abs(cur.y - y) <= YTOL && x0 >= cur.x0 - 60) {
      cur.x0 = Math.min(cur.x0, x0);
      cur.x1 = Math.max(cur.x1, x1);
      cur.top = Math.max(cur.top, y + h * 0.86);
      cur.bot = Math.min(cur.bot, y - h * 0.22);
    } else {
      cur = { y, x0, x1, top: y + h * 0.86, bot: y - h * 0.22 };
      lines.push(cur);
    }
  }
  return lines.map((l) => {
    const [ax, ay] = pd.viewport.convertToViewportPoint(l.x0, l.top);
    const [bx, by] = pd.viewport.convertToViewportPoint(l.x1, l.bot);
    return {
      left: Math.min(ax, bx),
      top: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
    };
  });
}

function paint(placed, pages) {
  const cards = [];
  for (const hit of placed) {
    const n = hit.range.n;
    const colour = COLORS[n] || "rgba(120,120,120,.3)";
    const nodes = [];
    for (const seg of hit.segments) {
      for (const r of rectsForSegment(seg)) {
        const d = document.createElement("div");
        d.className = "hl hl-" + n;
        d.dataset.range = String(n);
        d.style.left = r.left + "px";
        d.style.top = r.top + "px";
        d.style.width = r.width + "px";
        d.style.height = r.height + "px";
        d.style.background = colour;
        d.style.zIndex = String(10 + n); // nested ranges layer on top
        d.title = "range " + n;
        seg.pd.hl.append(d);
        nodes.push(d);
      }
    }
    hit.nodes = nodes;

    const pd = pages[hit.range.b.page - 1];
    const [, vy] = pd.viewport.convertToViewportPoint(hit.range.b.x, hit.range.b.y);
    cards.push({ hit, n, colour, want: pd.el.offsetTop + vy - 6 });
  }

  cards.sort((a, b) => a.want - b.want || a.n - b.n);
  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "card";
    card.id = "m" + c.n;
    card.style.setProperty("--c", c.colour.replace(/[\d.]+\)$/, "0.9)"));
    const label = LABELS[c.n] || ["Range " + c.n, ""];
    card.innerHTML =
      "<b>Range " + c.n + " — " + esc(label[0]) + "</b>" +
      '<span class="meta">p. ' + c.hit.begin.page + " → p. " + c.hit.end.page +
      " · " + c.hit.nodes.length + " line rect(s)</span>" +
      '<span class="body">' + esc(label[1]) +
      "<br><br>starts: <code>" + esc(c.hit.firstText) + "</code>" +
      "<br>ends: <code>" + esc(c.hit.lastText) + "</code></span>";
    marginEl.append(card);
    c.card = card;

    card.addEventListener("click", () => {
      card.classList.toggle("expanded");
      stack(cards);
      const first = c.hit.nodes[0];
      if (!first) return;
      const box = first.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + box.top - 160, behavior: "instant" });
      flash(c.hit.nodes);
    });
    for (const node of c.hit.nodes) {
      node.addEventListener("click", (ev) => {
        ev.stopPropagation();
        card.classList.toggle("expanded");
        stack(cards);
        flash(c.hit.nodes);
      });
    }
  }
  stack(cards);
}

// Greedy rail: every card wants to sit at the y of its range's begin point;
// a card that would collide with the one above is pushed down. Re-run whenever
// a card changes height.
function stack(cards) {
  let cursor = -Infinity;
  for (const c of cards) {
    const top = Math.max(c.want, cursor + 8);
    c.card.style.top = top + "px";
    cursor = top + c.card.offsetHeight;
  }
  marginEl.style.height = Math.max(pagesEl.offsetHeight, cursor + 24) + "px";
}

function flash(nodes) {
  for (const n of nodes) n.classList.add("active");
  setTimeout(() => {
    for (const n of nodes) n.classList.remove("active");
  }, 900);
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
