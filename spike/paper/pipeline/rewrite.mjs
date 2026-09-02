#!/usr/bin/env node
// Lax paper-layer marker rewriter (spike).
//
// Usage: node rewrite.mjs <srcDir> <outDir> [--main main.tex] [--table marks.json]
//
// Copies srcDir -> outDir, rewriting only *.tex files: every marker comment
// (from the unescaped `%` to end of line) becomes \laxmark{b}{<n>}% or
// \laxmark{e}{<n>}%.  Mark numbers are assigned in file order: main first,
// then the remaining .tex files sorted.  Prints the mark table as JSON.

import fs from "node:fs";
import path from "node:path";

const ID = /^[A-Za-z0-9_][A-Za-z0-9_.]*$/;

// Index of the first unescaped `%` in a line, or -1.
// Unescaped == preceded by an even number of backslashes.
export function firstCommentIndex(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let b = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) b++;
    if (b % 2 === 0) return i;
  }
  return -1;
}

// Parse the comment body (text after `%`).  Returns null if not a marker.
export function parseMarker(body) {
  let m = /^[ \t]*lax[ \t]+(begin|end)(?![A-Za-z])/.exec(body);
  if (!m) return null;
  const kw = m[1];
  let rest = body.slice(m[0].length);
  let id = null;
  const idm = /^[ \t]+([^ \t]+)/.exec(rest);
  if (idm) {
    if (!ID.test(idm[1])) {
      return { kw, id: null, bad: idm[1] };
    }
    id = idm[1];
  }
  if (kw === "begin" && id === null) return { kw, id: null, bad: "" };
  return { kw, id };
}

function listTexFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out;
}

export function rewriteText(text, file, state) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const outLines = lines.map((line, i) => {
    const ci = firstCommentIndex(line);
    if (ci < 0) return line;
    const parsed = parseMarker(line.slice(ci + 1));
    if (!parsed) return line;
    const where = `${file}:${i + 1}`;
    if (parsed.bad !== undefined) {
      throw new Error(`${where}: malformed lax ${parsed.kw} marker (id ${JSON.stringify(parsed.bad)})`);
    }
    if (parsed.kw === "begin") {
      const n = state.marks.length + 1;
      state.marks.push({ n, id: parsed.id, file, line: i + 1 });
      state.stack.push({ n, id: parsed.id, where });
      return line.slice(0, ci) + `\\laxmark{b}{${n}}%`;
    }
    const open = state.stack.pop();
    if (!open) throw new Error(`${where}: 'lax end' with no open marker`);
    if (parsed.id !== null && parsed.id !== open.id) {
      throw new Error(
        `${where}: 'lax end ${parsed.id}' does not match innermost open marker ${open.id} (${open.where})`
      );
    }
    return line.slice(0, ci) + `\\laxmark{e}{${open.n}}%`;
  });
  return outLines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const pos = [];
  let mainFile = "main.tex";
  let tablePath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--main") mainFile = argv[++i];
    else if (argv[i] === "--table") tablePath = argv[++i];
    else pos.push(argv[i]);
  }
  const [srcDir, outDir] = pos;
  if (!srcDir || !outDir) {
    console.error("usage: rewrite.mjs <srcDir> <outDir> [--main main.tex] [--table marks.json]");
    process.exit(2);
  }

  const all = listTexFiles(srcDir);
  const tex = all.filter((f) => f.toLowerCase().endsWith(".tex"));
  if (!tex.includes(mainFile)) throw new Error(`main file ${mainFile} not found under ${srcDir}`);
  const ordered = [mainFile, ...tex.filter((f) => f !== mainFile).sort()];

  const state = { marks: [], stack: [] };
  const rewritten = new Map();
  for (const f of ordered) {
    rewritten.set(f, rewriteText(fs.readFileSync(path.join(srcDir, f), "utf8"), f, state));
  }
  if (state.stack.length) {
    const o = state.stack[state.stack.length - 1];
    throw new Error(`unclosed lax marker ${o.id} opened at ${o.where}`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  for (const f of all) {
    const dst = path.join(outDir, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // Only .tex is rewritten; .sty/.cls/.bbl/.bib and everything else is copied byte for byte.
    if (rewritten.has(f)) fs.writeFileSync(dst, rewritten.get(f));
    else fs.copyFileSync(path.join(srcDir, f), dst);
  }

  const table = state.marks.map((m) => ({ n: m.n, id: m.id }));
  const json = JSON.stringify(table, null, 2);
  if (tablePath) fs.writeFileSync(tablePath, json + "\n");
  console.log(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error("rewrite error: " + e.message);
    process.exit(1);
  }
}
