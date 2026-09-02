// The ReflowTeX fork end to end (paper-web-plan.md stage 1): fetch.mjs
// obtains the pinned upstream and applies the lax patches, laxreflow.sty
// injects the extraction hooks in front of an unmodified author document,
// and the patched serializer + encode carry lax markers as exact stream
// positions through the extended wire schema. Skips gracefully wherever a
// prerequisite is absent — the reference clone (LAX_REFLOWTEX_SOURCE, or
// its container default), python3, lualatex — so `npm run check` stays
// green everywhere; the tikz case additionally needs a dvisvgm whose PDF
// backend works (Ubuntu 24.04 pairs dvisvgm 3.2.1 with Ghostscript 10.02,
// which it refuses — `mupdf-tools` provides the mutool fallback).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { rewriteMarkers } from "../../src/submission-validation/paper/rewrite.js";
import { tmpDir } from "../support/host.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reflowtexDir = path.join(repoRoot, "reflowtex");
const checkoutDir = path.join(reflowtexDir, "checkout");
const venvPython = path.join(reflowtexDir, "venv", "bin", "python");
const encodeDriver = path.join(repoRoot, "test", "support", "reflowtex_encode.py");
const laxTexDir = path.join(repoRoot, "assets", "tex");

const source = process.env.LAX_REFLOWTEX_SOURCE ?? "/home/user/radek-p/reflowtex";

function answers(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const hasSource = fs.existsSync(path.join(source, "src", "extract", "serializer.lua"));
const hasPython = answers("python3", ["--version"]);
const hasLualatex = answers("lualatex", ["--version"]);
const hasDvisvgm = answers("dvisvgm", ["--version"]);
const withFork = hasSource && hasPython && hasLualatex;
if (!withFork) {
  const missing = [
    hasSource ? undefined : `no reflowtex checkout at ${source} (set LAX_REFLOWTEX_SOURCE)`,
    hasPython ? undefined : "python3 not found",
    hasLualatex ? undefined : "lualatex not found",
  ].filter((reason) => reason !== undefined);
  console.warn(`reflowtex-fork: skipping — ${missing.join("; ")}`);
}

// ── the fixture: an unmodified author document, markers via the real rewriter ─
// Trimmed from the spike's (spike/paper/reflow/fixture) to one instance of
// each capture site: mark 1 inline inside a paragraph (horizontal mode),
// mark 2 wrapping a theorem between paragraphs (vertical mode — the whatsits
// sit in the page's vertical list), mark 3 wrapping a display with the end
// marker directly after \end{equation} and a blank line after it — which the
// rewriter lowers after the blank line, so e3 is a genuine vertical-mode
// stream item (the phantom-line fix; the author's paragraph resumes empty
// and is discarded exactly as in their own build) — and mark 4 wrapping a
// display with \section directly after the end marker, no blank line: the
// whatsit stays in the resumed paragraph, \section's \par turns it into a
// glyphless capture, and the serializer hoist must surface e4 (without the
// hoist it silently vanishes).

const MAIN_TEX = `\\documentclass{article}

\\usepackage{mathtools}
\\usepackage{amssymb}
\\usepackage{amsthm}
\\usepackage{fontspec}
\\setmainfont{Latin Modern Roman}

\\newtheorem{theorem}{Theorem}
\\newcommand{\\tw}{\\operatorname{tw}}

\\begin{document}

\\input{body}

\\end{document}
`;

const BODY_TEX = `\\section{Introduction}

We use the standard notion of
% lax begin Lax261.Colorings
proper vertex colorings
% lax end
as introduced elsewhere.

% lax begin Lax261.Treewidth
\\begin{theorem}
  A graph $G$ satisfies $\\tw(G) \\le 1$ if and only if $G$ is a forest.
\\end{theorem}
% lax end

The treewidth of a graph never exceeds its vertex count:
% lax begin Lax261.MainBound
\\begin{equation}
  \\tw(G) \\le |V(G)| - 1.
\\end{equation}
% lax end

Equality holds for complete graphs:
% lax begin Lax261.TightCase
\\begin{equation}
  \\tw(K_n) = n - 1.
\\end{equation}
% lax end
\\section{Conclusion}

A closing remark ends the document.
`;

const TIKZ_MAIN_TEX = `\\documentclass{article}

\\usepackage{fontspec}
\\setmainfont{Latin Modern Roman}
\\usepackage{tikz}

\\begin{document}

A picture with an arrow and a label:
\\begin{tikzpicture}
  \\draw[->] (0,0) -- (2,1);
  \\node[draw, circle] at (3,0.5) {$x$};
\\end{tikzpicture}
after it, the text continues.

\\end{document}
`;

// A figure in its own paragraph (blank lines around the tikzpicture): the
// capture holds an externalised picture and no glyph at any depth, so the
// glyph-only body gate dropped it from the content stream — every
// standalone figure vanished from the web view (the has_ink fix). The
// markers land on both sides of the picture: b1 in vertical mode (a
// stream item), e1 inside the picture's paragraph — inline after
// \\end{tikzpicture}, which pins the whatsit inside the ink-bearing
// capture (an own-line end before the blank line would relocate past it
// into vertical mode and leave the hoist guard unexercised).
const STANDALONE_TIKZ_TEX = `\\documentclass{article}

\\usepackage{fontspec}
\\setmainfont{Latin Modern Roman}
\\usepackage{tikz}

\\begin{document}

Text before the figure.

% lax begin Lax261.Figure
\\begin{tikzpicture}
  \\draw[->] (0,0) -- (2,1);
  \\node[draw, circle] at (3,0.5) {$x$};
\\end{tikzpicture} % lax end

Text after the figure.

\\end{document}
`;

/** Write rewritten sources + the fork serializer into a fresh job dir and run
 * the plan's injection command. The job dir leads TEXINPUTS (it is the cwd's
 * `.`), assets/tex supplies laxreflow.sty, the trailing colon keeps TeX
 * Live's default tree; pics/ is pre-created because tikz will not. */
function compileInjected(sources: Record<string, string>): string {
  const jobDir = tmpDir("lax-reflow-");
  fs.mkdirSync(path.join(jobDir, "pics"));
  const files = Object.entries(sources).map(([file, text]) => ({ path: file, text }));
  const rewritten = rewriteMarkers(files);
  expect(rewritten.problems).toEqual([]);
  for (const file of rewritten.rewritten) fs.writeFileSync(path.join(jobDir, file.path), file.text);
  fs.copyFileSync(
    path.join(checkoutDir, "src", "extract", "serializer.lua"),
    path.join(jobDir, "serializer.lua"),
  );
  const result = spawnSync(
    "lualatex",
    [
      "-shell-escape",
      "-interaction=nonstopmode",
      "--jobname=main",
      "\\RequirePackage{laxreflow}\\input{main.tex}",
    ],
    { cwd: jobDir, encoding: "utf8", env: { ...process.env, TEXINPUTS: `.:${laxTexDir}:` } },
  );
  const log = path.join(jobDir, "main.log");
  const transcript = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : result.stdout + result.stderr;
  expect(fs.existsSync(path.join(jobDir, "output.json")), `no output.json:\n${transcript.slice(-3000)}`).toBe(true);
  // nonstopmode repairs the document, so any "! " line means the node list
  // is silently wrong — the same rule the fork's pipeline enforces.
  const errors = transcript.split("\n").filter((line) => line.startsWith("! "));
  expect(errors, `TeX error(s):\n${errors.join("\n")}`).toEqual([]);
  return jobDir;
}

function runEncode(jobDir: string): { stats: EncodeStats; pb: Buffer } {
  const statsFile = path.join(jobDir, "encode-stats.json");
  const result = spawnSync(
    venvPython,
    [
      encodeDriver,
      "--checkout", checkoutDir,
      "--build", jobDir,
      "--fonts", path.join(jobDir, "fonts"),
      "--stats", statsFile,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `encode driver failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return {
    stats: JSON.parse(fs.readFileSync(statsFile, "utf8")) as EncodeStats,
    pb: fs.readFileSync(path.join(jobDir, "nodelist.pb")),
  };
}

interface EncodeStats {
  pb_bytes: number;
  pb_sha256: string;
  node_markers: Array<[string, number]>;
  stream_markers: Array<[string, number]>;
  stream_paragraphs: number[];
  picture_nodes: number;
  pictures: Array<{ svg: string; vb_w: number; vb_h: number }>;
  converted: number;
  stripped: number;
}

// ── a small reader for output.json (the spike's stream_items, in TS) ────────

interface OutputJson {
  fonts: Record<string, unknown>;
  paragraphs: Array<{ nodes: RawNode[] }>;
  content: Array<Record<string, unknown>>;
}
interface RawNode {
  type?: string;
  side?: string;
  n?: number;
  char?: number;
  children?: RawNode[];
  replace?: RawNode[];
  [key: string]: unknown;
}
type Piece = { kind: "text"; piece: string } | { kind: "marker"; side: string; n: number };

const LIGATURES = new Map([[0xfb00, "ff"], [0xfb01, "fi"], [0xfb02, "fl"], [0xfb03, "ffi"], [0xfb04, "ffl"]]);

function linearize(nodes: RawNode[], out: Piece[]): void {
  for (const node of nodes) {
    if (node.type === "marker") {
      out.push({ kind: "marker", side: node.side!, n: node.n! });
    } else if (node.type === "glyph") {
      const char = node.char ?? 0;
      const piece = LIGATURES.get(char) ?? (char < 0x20 || char >= 0xf0000 ? "?" : String.fromCodePoint(char));
      out.push({ kind: "text", piece });
    } else if (node.type === "glue") {
      out.push({ kind: "text", piece: " " });
    } else if (node.type === "disc") {
      linearize(node.replace ?? [], out);
    } else if (node.children) {
      linearize(node.children, out);
    }
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function paragraphText(data: OutputJson, ref: number): string {
  const pieces: Piece[] = [];
  linearize(data.paragraphs[ref - 1]!.nodes, pieces);
  return collapse(pieces.filter((p) => p.kind === "text").map((p) => (p as { piece: string }).piece).join(""));
}

interface MarkerInstance {
  side: string;
  n: number;
  at: "paragraph" | "stream";
  before: string;
  after: string;
}

/** Every marker instance in content-stream order with decoded glyph context:
 * markers inside a referenced paragraph at that paragraph's position (in node
 * order), stream markers between their non-marker neighbours. */
function streamMarkers(data: OutputJson): MarkerInstance[] {
  const content = data.content;
  const itemText = (index: number): string => {
    if (index < 0 || index >= content.length) return "(edge)";
    const item = content[index]!;
    if (item.kind === "paragraph") return paragraphText(data, item.para as number);
    if (item.kind === "display") return "(display)";
    return `(${String(item.kind)})`;
  };
  const neighbour = (index: number, step: number): string => {
    let at = index + step;
    while (at >= 0 && at < content.length && (content[at]!.kind === "marker" || content[at]!.kind === "vspace")) {
      at += step;
    }
    return itemText(at);
  };
  const found: MarkerInstance[] = [];
  content.forEach((item, index) => {
    if (item.kind === "paragraph") {
      const pieces: Piece[] = [];
      linearize(data.paragraphs[(item.para as number) - 1]!.nodes, pieces);
      pieces.forEach((piece, at) => {
        if (piece.kind !== "marker") return;
        const text = (slice: Piece[]): string =>
          collapse(slice.filter((p) => p.kind === "text").map((p) => (p as { piece: string }).piece).join(""));
        found.push({
          side: piece.side,
          n: piece.n,
          at: "paragraph",
          before: text(pieces.slice(0, at)).slice(-60),
          after: text(pieces.slice(at + 1)).slice(0, 60),
        });
      });
    } else if (item.kind === "marker") {
      found.push({
        side: item.side as string,
        n: item.n as number,
        at: "stream",
        before: neighbour(index, -1).slice(-60),
        after: neighbour(index, +1).slice(0, 60),
      });
    }
  });
  return found;
}

function readOutput(jobDir: string): OutputJson {
  return JSON.parse(fs.readFileSync(path.join(jobDir, "output.json"), "utf8")) as OutputJson;
}

describe.skipIf(!withFork)("reflowtex fork (fetch + injection + encode)", () => {
  beforeAll(() => {
    // The fetch is idempotent: clone at the pin, patch strictly, reuse the
    // venv while requirements.lock is unchanged, regenerate latex_pb2.py.
    const result = spawnSync(process.execPath, [path.join(reflowtexDir, "fetch.mjs")], {
      encoding: "utf8",
      env: { ...process.env, LAX_REFLOWTEX_SOURCE: source },
    });
    if (result.status !== 0) {
      throw new Error(`reflowtex:fetch failed:\n${result.stdout}\n${result.stderr}`);
    }
  });

  it("captures every marker at its exact stream position across all four sites", () => {
    const jobDir = compileInjected({ "main.tex": MAIN_TEX, "body.tex": BODY_TEX });
    const found = streamMarkers(readOutput(jobDir));

    // Document order, one b and one e per table mark.
    expect(found.map((f) => [f.side, f.n])).toEqual([
      ["b", 1], ["e", 1], ["b", 2], ["e", 2], ["b", 3], ["e", 3], ["b", 4], ["e", 4],
    ]);

    const at = (side: string, n: number): MarkerInstance => found.find((f) => f.side === side && f.n === n)!;
    // Site 1 — inside a paragraph (horizontal mode): exact node-list
    // positions with the marked phrase between them.
    expect(at("b", 1).at).toBe("paragraph");
    expect(at("b", 1).before.endsWith("notion of")).toBe(true);
    expect(at("b", 1).after.startsWith("proper vertex colorings")).toBe(true);
    expect(at("e", 1).at).toBe("paragraph");
    expect(at("e", 1).before.endsWith("proper vertex colorings")).toBe(true);
    expect(at("e", 1).after.startsWith("as introduced")).toBe(true);

    // Site 2 — the shipout walk (vertical mode): stock reflowtex has no
    // whatsit branch there and drops both of these silently.
    expect(at("b", 2).at).toBe("stream");
    expect(at("b", 2).before.endsWith("as introduced elsewhere.")).toBe(true);
    expect(at("b", 2).after.startsWith("Theorem 1.")).toBe(true);
    expect(at("e", 2).at).toBe("stream");
    expect(at("e", 2).before.endsWith("forest.")).toBe(true);
    expect(at("e", 2).after.startsWith("The treewidth")).toBe(true);

    // Site 3 — an end marker on its own line after \end{equation} with a
    // blank line after it: the rewriter lowers it past the blank line, so
    // the whatsit is typeset in vertical mode and reaches the stream as a
    // real item (and the paragraph TeX resumes after the display is empty
    // and discarded, exactly as in the author's own build — the phantom
    // line the unrelocated form used to add).
    expect(at("b", 3).at).toBe("paragraph");
    expect(at("b", 3).before.endsWith("vertex count:")).toBe(true);
    expect(at("e", 3).at).toBe("stream");
    expect(at("e", 3).before).toBe("(display)");
    expect(at("e", 3).after.startsWith("Equality holds")).toBe(true);

    // Site 4 — the glyphless-resumed-paragraph hoist: \section directly
    // after the end marker (no blank line, so the rewriter leaves it in
    // place) \par-s the resumed paragraph with nothing but the whatsit in
    // it; the walk skips that capture, and without the hoist e4 vanishes.
    expect(at("b", 4).at).toBe("paragraph");
    expect(at("b", 4).before.endsWith("complete graphs:")).toBe(true);
    expect(at("e", 4).at).toBe("stream");
    expect(at("e", 4).before).toBe("(display)");
    expect(at("e", 4).after.startsWith("2 Conclusion")).toBe(true);
  });

  it("is byte-deterministic across fresh runs, for output.json and the encoded nodelist.pb", () => {
    const first = compileInjected({ "main.tex": MAIN_TEX, "body.tex": BODY_TEX });
    const second = compileInjected({ "main.tex": MAIN_TEX, "body.tex": BODY_TEX });
    expect(fs.readFileSync(path.join(first, "output.json")).equals(fs.readFileSync(path.join(second, "output.json")))).toBe(
      true,
    );

    // Encode both through the patched pipeline (deterministic protobuf
    // serialization, markers included through the extended schema).
    const encodedFirst = runEncode(first);
    const encodedSecond = runEncode(second);
    expect(encodedFirst.pb.length).toBeGreaterThan(0);
    expect(encodedFirst.pb.equals(encodedSecond.pb)).toBe(true);
    expect(encodedFirst.stats.pb_sha256).toBe(encodedSecond.stats.pb_sha256);

    // Both marker forms reached the wire: b1/e1, b3 and b4 inside referenced
    // paragraphs, e4 also inside the (unreferenced) glyphless capture the
    // hoist surfaces; the vertical-mode pair, the relocated e3, and the
    // hoisted e4 as stream items. e3 sits in no paragraph at all: the
    // rewriter's blank-line relocation typesets it in vertical mode and the
    // resumed paragraph after its display is empty and discarded.
    expect(encodedFirst.stats.node_markers).toEqual([["b", 1], ["e", 1], ["b", 3], ["b", 4], ["e", 4]]);
    expect(encodedFirst.stats.stream_markers).toEqual([["b", 2], ["e", 2], ["e", 3], ["e", 4]]);
  });

  it("carries a tikz picture end to end through dvisvgm into sanitized SVG in the blob", (context) => {
    context.skip(!hasDvisvgm, "dvisvgm not found");
    const jobDir = compileInjected({ "main.tex": TIKZ_MAIN_TEX });
    // The injected package externalized the picture through the sub-run
    // (laxreflow re-injects itself into tikz's system call) and stamped it.
    expect(fs.existsSync(path.join(jobDir, "pics", "main-figure0.pdf"))).toBe(true);

    const statsFile = path.join(jobDir, "encode-stats.json");
    const result = spawnSync(
      venvPython,
      [encodeDriver, "--checkout", checkoutDir, "--build", jobDir, "--fonts", path.join(jobDir, "fonts"), "--stats", statsFile],
      { encoding: "utf8" },
    );
    // Ubuntu's dvisvgm 3.2.1 refuses Ghostscript >= 10.01 for PDF input and
    // needs mutool (mupdf-tools) as its PDF backend; without either this
    // machine cannot convert at all — skip rather than fail.
    if (result.status !== 0 && /To process PDF files/u.test(result.stdout + result.stderr)) {
      console.warn("reflowtex-fork: dvisvgm has no usable PDF backend (install mupdf-tools) — skipping the tikz case");
      context.skip();
    }
    expect(result.status, `encode driver failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const stats = JSON.parse(fs.readFileSync(statsFile, "utf8")) as EncodeStats;
    expect(stats.converted).toBe(1);
    expect(stats.picture_nodes).toBe(1);
    expect(stats.pictures).toHaveLength(1);
    const picture = stats.pictures[0]!;
    expect(picture.vb_w).toBeGreaterThan(0);
    expect(picture.vb_h).toBeGreaterThan(0);
    // Real drawing content survived (the arrow's path, the label's glyphs)…
    expect(picture.svg).toMatch(/<(?:path|g|use)\b/u);
    // …and nothing executable or external did.
    for (const forbidden of ["<script", "onload", "javascript:", "http://", "https://", "<foreignObject"]) {
      expect(picture.svg).not.toContain(forbidden);
    }
  });

  it("references a standalone-picture paragraph as body content and keeps it through the pb", (context) => {
    context.skip(!hasDvisvgm, "dvisvgm not found");
    const jobDir = compileInjected({ "main.tex": STANDALONE_TIKZ_TEX });
    expect(fs.existsSync(path.join(jobDir, "pics", "main-figure0.pdf"))).toBe(true);
    const data = readOutput(jobDir);

    // Exactly one capture bears the picture — and no glyph at any depth,
    // which is what made the glyph-only gate drop it.
    const flatten = (nodes: RawNode[], out: RawNode[] = []): RawNode[] => {
      for (const node of nodes) {
        out.push(node);
        if (node.children) flatten(node.children, out);
        if (node.replace) flatten(node.replace, out);
      }
      return out;
    };
    const pictureParas = data.paragraphs
      .map((paragraph, index) => ({ ref: index + 1, nodes: flatten(paragraph.nodes) }))
      .filter(({ nodes }) => nodes.some((node) => node.type === "picture"));
    expect(pictureParas).toHaveLength(1);
    const { ref, nodes } = pictureParas[0]!;
    expect(nodes.some((node) => node.type === "glyph")).toBe(false);

    // The walk references it as body content between its text neighbours;
    // before the has_ink gate the paragraph — and every standalone figure —
    // silently vanished from the content stream.
    const refs = data.content.filter((item) => item.kind === "paragraph").map((item) => item.para as number);
    const at = refs.indexOf(ref);
    expect(at).toBeGreaterThan(0);
    expect(paragraphText(data, refs[at - 1]!)).toBe("Text before the figure.");
    expect(paragraphText(data, refs[at + 1]!)).toBe("Text after the figure.");

    // e1 rides inside the referenced paragraph after its picture (the
    // marker-hoist branch must not claim an ink-bearing capture); b1, in
    // vertical mode, is a stream item.
    const eIndex = nodes.findIndex((node) => node.type === "marker" && node.side === "e" && node.n === 1);
    expect(eIndex).toBeGreaterThan(nodes.findIndex((node) => node.type === "picture"));
    const found = streamMarkers(data);
    expect(found.map((f) => [f.side, f.n, f.at])).toEqual([["b", 1, "stream"], ["e", 1, "paragraph"]]);

    // The wire form agrees: the pb's content stream references the picture
    // paragraph, and its sanitized SVG payload made it across.
    const statsFile = path.join(jobDir, "encode-stats.json");
    const result = spawnSync(
      venvPython,
      [encodeDriver, "--checkout", checkoutDir, "--build", jobDir, "--fonts", path.join(jobDir, "fonts"), "--stats", statsFile],
      { encoding: "utf8" },
    );
    if (result.status !== 0 && /To process PDF files/u.test(result.stdout + result.stderr)) {
      console.warn("reflowtex-fork: dvisvgm has no usable PDF backend (install mupdf-tools) — skipping the encode half");
      context.skip();
    }
    expect(result.status, `encode driver failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const stats = JSON.parse(fs.readFileSync(statsFile, "utf8")) as EncodeStats;
    expect(stats.stream_paragraphs).toContain(ref);
    expect(stats.node_markers).toEqual([["e", 1]]);
    expect(stats.stream_markers).toEqual([["b", 1]]);
    expect(stats.converted).toBe(1);
    expect(stats.picture_nodes).toBe(1);
    expect(stats.pictures).toHaveLength(1);
    expect(stats.pictures[0]!.svg).toMatch(/<(?:path|g|use)\b/u);
  });

  it("consumes a pre-converted SVG beside the picture PDF without any dvisvgm, sanitizer still applied", () => {
    // The trusted path (paper-web-plan.md stage 3) converts pictures inside
    // the pinned TeX image right after the compile and pins the encode
    // child's REFLOWTEX_DVISVGM seam to a failing command; the fork must
    // consume the `<src>.svg` beside the PDF as-is — through sanitize_svg,
    // whoever produced it — and never reach for a host binary.
    const jobDir = compileInjected({ "main.tex": TIKZ_MAIN_TEX });
    expect(fs.existsSync(path.join(jobDir, "pics", "main-figure0.pdf"))).toBe(true);
    fs.writeFileSync(
      path.join(jobDir, "pics", "main-figure0.svg"),
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'>" +
        "<script>alert(1)</script>" +
        "<path d='M1 2L3 4' stroke='#f00' fill='none'/>" +
        "</svg>",
    );
    const statsFile = path.join(jobDir, "encode-stats.json");
    const result = spawnSync(
      venvPython,
      [encodeDriver, "--checkout", checkoutDir, "--build", jobDir, "--fonts", path.join(jobDir, "fonts"), "--stats", statsFile],
      { encoding: "utf8", env: { ...process.env, REFLOWTEX_DVISVGM: "false" } },
    );
    expect(result.status, `encode driver failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const stats = JSON.parse(fs.readFileSync(statsFile, "utf8")) as EncodeStats;
    expect(stats.converted).toBe(1);
    expect(stats.pictures).toHaveLength(1);
    const picture = stats.pictures[0]!;
    // The blob carries the planted drawing (color-themed by the rewrite)…
    expect(picture.vb_w).toBe(12);
    expect(picture.vb_h).toBe(8);
    expect(picture.svg).toContain("d='M1 2L3 4'");
    expect(picture.svg).toContain("var(--latex-color-ff0000");
    // …with the attack surface sanitized out, exactly as on the dvisvgm path.
    expect(picture.svg).not.toContain("script");
    expect(picture.svg).not.toContain("alert");
  });

  it("resolves Type1 outlines from the injected directory first, and degrades without kpsewhich", () => {
    // The trusted path exports the .pfb outlines legacy 8-bit faces need
    // (plain lualatex math: cmmi10, cmsy10, …) from the pinned TeX image
    // and points REFLOWTEX_PFB_DIR at them, because the Validate host has
    // no TeX tree; and a host without kpsewhich must yield the metric-box
    // fallback (None), never an uncaught crash.
    const pfbDir = tmpDir("lax-reflow-pfb-");
    fs.writeFileSync(path.join(pfbDir, "fakeface10.pfb"), "%!PS-AdobeFont-1.0 fixture");
    const probe = [
      "import json, os, sys",
      `sys.path.insert(0, ${JSON.stringify(path.join(checkoutDir, "src", "encode"))})`,
      "import t1_convert",
      `os.environ['REFLOWTEX_PFB_DIR'] = ${JSON.stringify(pfbDir)}`,
      "injected = t1_convert.find_pfb('fakeface10')",
      // With the directory set it is the *only* source: this TeX-full host
      // could resolve cmmi10.pfb, and must not (a host tree silently
      // substituting for a missed export would mask the export gap).
      "pinned = t1_convert.find_pfb('cmmi10')",
      "del os.environ['REFLOWTEX_PFB_DIR']",
      "os.environ['PATH'] = '/nonexistent'",
      "bare = t1_convert.find_pfb('cmmi10')",
      "print(json.dumps({'injected': injected, 'pinned': pinned, 'bare': bare}))",
    ].join("\n");
    const result = spawnSync(venvPython, ["-c", probe], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const { injected, pinned, bare } = JSON.parse(result.stdout) as {
      injected: string | null;
      pinned: string | null;
      bare: string | null;
    };
    expect(injected).toBe(path.join(pfbDir, "fakeface10.pfb"));
    expect(pinned).toBeNull();
    expect(bare).toBeNull();
  });

  it("strips disallowed elements and attributes while keeping the drawing", () => {
    const crafted = [
      "<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' viewBox='0 0 10 10' onload='evil()'>",
      "<script>alert(1)</script>",
      "<g id='a' transform='translate(1,2)'>",
      "<path d='M0 0L5 5' fill='url(#grad)' stroke='#f00'/>",
      "<use xlink:href='#a'/>",
      "<use xlink:href='https://evil.example/x'/>",
      "<image href='https://evil.example/i.png' width='5' height='5'/>",
      "<rect x='0' y='0' width='2' height='2' style='fill:red' fill='url(https://evil.example)'/>",
      "<linearGradient id='grad'><stop offset='0' stop-color='#00f'/></linearGradient>",
      "<text x='1' y='1'>ok</text>",
      "</g>",
      "</svg>",
    ].join("");
    const probe = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(path.join(checkoutDir, "src", "encode"))})`,
      "from transforms import sanitize_svg",
      `clean, removed = sanitize_svg(${JSON.stringify(crafted)})`,
      "print(json.dumps({'clean': clean, 'removed': removed}))",
    ].join("\n");
    const result = spawnSync(venvPython, ["-c", probe], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const { clean, removed } = JSON.parse(result.stdout) as { clean: string; removed: string[] };
    // The drawing survives: structure, ids, fragment references, gradients.
    expect(clean).toContain("<path d='M0 0L5 5' fill='url(#grad)' stroke='#f00'/>");
    expect(clean).toContain("<use xlink:href='#a'/>");
    expect(clean).toContain("<linearGradient id='grad'>");
    expect(clean).toContain("<text x='1' y='1'>ok</text>");
    expect(clean).toContain("viewBox='0 0 10 10'");
    // The attack surface does not.
    for (const forbidden of ["script", "onload", "evil.example", "style="]) {
      expect(clean).not.toContain(forbidden);
    }
    expect(removed).toContain("element script");
    expect(removed).toContain("element image");
    expect(removed).toContain("attribute onload");
    expect(removed).toContain("attribute style");
    // the external url() reference cost the rect its fill attribute
    expect(removed).toContain("attribute fill");
    expect(removed).toContain("attribute xlink:href");
  });
});
