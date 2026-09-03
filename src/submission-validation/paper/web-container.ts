// The trusted executor of the paper web derivation (paper-web-plan.md,
// stage 3): the injected lualatex compile runs in the same pinned TeX Live
// image as the PDF compile (paper/container.ts), through the same hardened
// runner, on its own fresh copy (`paper/web/src` — never the PDF compile's
// `paper/src`), with `-shell-escape` for tikz's external library — the one
// deviation from the PDF compile's flags, contained by the sandbox (no
// network, read-only root, caps, none of the Lean mounts).
//
// What leaves the container is enumerated and bounded: `output.json` (read
// through the shared size cap), `pics/*.pdf` plus the SVGs a second
// in-image step converts them to (dvisvgm lives in the TeX image; the
// encode host has none — the fork consumes a pre-converted `<src>.svg`
// as-is, sanitizer still applied), and the font files the run used,
// resolved in-image by kpsewhich from the serializer's font table and
// consumed host-side through `encode_web.py --fonts` (fonts.py's
// `local_dir` injection point). Nothing else. The encode child then runs on
// the Validate job's host under the pdf.js precedent — credential-free,
// untrusted input, bounded output, its own timeout — and everything after
// compile + export (marker sanity, oracle, bundle seal, the `web-*` warning
// vocabulary) is stage 2's shared engine in paper/web.ts, called, not
// copied. Non-blocking throughout: every failure is a warning and the PDF
// path never notices.

import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import { laxmarkDirectory } from "../host/paper.js";
import type { ValidationRunner } from "../sandbox/container.js";
import { paperImage, PAPER_CONTAINER_PATHS } from "./container.js";
import {
  encodeAndSealWebBundle,
  prepareWebSource,
  probeReflowtex,
  reflowtexDirectory,
  runWebDerivation,
  serializedStreamProblem,
  webCompileEnvironment,
  webCompileProblem,
  webFontFilenames,
  webLatexmkArguments,
  webLegacyFontNames,
  type WebDeriver,
  type WebWarning,
} from "./web.js";

/** In-job names of the export step's files: the script, the two requested
 * font lists (real font files by filename; legacy Type1 outlines by TeX
 * name), and the directory the resolved bytes land in. They live in the
 * web compile's copy (already mounted writable) and are written by the
 * host *after* the compile container exited, so the compile cannot tamper
 * with them; none of them can shadow author content (the fresh copy is
 * re-made per run) and none enter the sealed bundle. */
export const WEB_EXPORT_SCRIPT = "lax-web-export.sh";
export const WEB_EXPORT_FONT_LIST = "lax-web-fonts.txt";
export const WEB_EXPORT_PFB_LIST = "lax-web-pfbs.txt";
export const WEB_EXPORT_FONTS_DIR = "lax-fonts";
/** Extension of the marker the export leaves beside a picture it had to
 * redraw with transparency off, so the host can say so in the report. */
export const WEB_EXPORT_FLAT_SUFFIX = "flattened";

/**
 * The in-image export step: resolve each requested font file by name and
 * each legacy face's Type1 outline with kpsewhich — the same lookups the
 * encode's own provisioning and t1 conversion would do if the host had
 * TeX — into the fonts directory, then convert every
 * externalized picture PDF to SVG with the image's dvisvgm — via an EPS
 * detour through the image's own Ghostscript: dvisvgm's direct `--pdf`
 * input needs Ghostscript < 10.01 or mutool, and the pinned TL2025 image
 * ships Ghostscript 10.07 and no mutool (measured 2026-09-03, the first
 * docker smoke of this path), while its `--eps` input runs on any
 * Ghostscript. The dvisvgm options match the fork's invocation
 * (transforms.py), private tmpdir included.
 *
 * Ghostscript rasterizes a page it cannot express in PostScript, which for
 * a tikz picture means any transparency at all (an `opacity=` node, a
 * shading): the whole drawing comes back as one embedded JPEG, which the
 * encode's SVG sanitizer then drops — the reader would get an empty
 * figure, silently (measured 2026-09-03 on lax-65, whose two figures both
 * carry faded nodes). So a converted picture that came back as a raster is
 * redrawn with `-dNOTRANSPARENCY`: the drawing stays vector and the alpha
 * is lost, which is the readable trade. The retry leaves a `.flattened`
 * marker beside the picture so the host can say so in the report; a retry
 * that does not produce vectors keeps the first result rather than
 * claiming more than it has. A file kpsewhich cannot
 * resolve or a picture that does not convert is left absent, with the
 * converter's transcript on stderr — the deriver checks the required
 * pieces afterwards and skips loudly (a missing pfb is not required: it
 * degrades to metric boxes exactly as on a TeX-full host), so nothing
 * fails silently and the script itself stays simple.
 *
 * A legacy face resolves the way the engines resolve it: through its
 * `pdftex.map` line, whose `<file` tokens name the outline and, for a
 * re-encoded face, the encoding vector — `ec-lmr10` is `lmr10.pfb`
 * through `lm-ec.enc`, and there is no `ec-lmr10.pfb` anywhere. Both land
 * under the TeX name (`<name>.pfb`, `<name>.enc`), which is the
 * `REFLOWTEX_PFB_DIR` contract the fork's `find_outline` reads; a
 * re-encoded face whose vector does not resolve exports nothing (metric
 * boxes, never the outline's built-in encoding addressing every slot
 * above ASCII wrongly). A name without a map line is `<name>.pfb` as
 * stock (plain lualatex math's cmmi10, cmsy10, …).
 */
export function webExportScript(): string {
  const fontsDir = `${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_FONTS_DIR}`;
  return [
    "#!/bin/sh",
    "# lax paper-web export (written by the trusted deriver after the compile).",
    "set -u",
    `mkdir -p '${fontsDir}'`,
    "while IFS= read -r name; do",
    "  [ -n \"$name\" ] || continue",
    "  src=\"$(kpsewhich \"$name\" || true)\"",
    "  if [ -n \"$src\" ] && [ -f \"$src\" ]; then",
    `    cp -- "$src" '${fontsDir}/'"$name"`,
    "  fi",
    `done < '${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_FONT_LIST}'`,
    "map=\"$(kpsewhich pdftex.map || true)\"",
    "while IFS= read -r name; do",
    "  [ -n \"$name\" ] || continue",
    "  pfb=\"\"; enc=\"\"",
    "  if [ -n \"$map\" ] && [ -f \"$map\" ]; then",
    "    for tok in $(awk -v n=\"$name\" '$1 == n { print; exit }' \"$map\"); do",
    "      case \"$tok\" in",
    "        '<<'*) f=\"${tok#<<}\" ;;",
    "        '<['*) f=\"${tok#<[}\" ;;",
    "        '<'*) f=\"${tok#<}\" ;;",
    "        *) continue ;;",
    "      esac",
    "      case \"$f\" in",
    "        *.enc) enc=\"$f\" ;;",
    "        *.pfb|*.pfa) pfb=\"$f\" ;;",
    "      esac",
    "    done",
    "  fi",
    "  [ -n \"$pfb\" ] || pfb=\"$name.pfb\"",
    "  src=\"$(kpsewhich \"$pfb\" || true)\"",
    "  [ -n \"$src\" ] && [ -f \"$src\" ] || continue",
    "  if [ -n \"$enc\" ]; then",
    "    esrc=\"$(kpsewhich \"$enc\" || true)\"",
    "    [ -n \"$esrc\" ] && [ -f \"$esrc\" ] || continue",
    `    cp -- "$esrc" '${fontsDir}/'"$name.enc"`,
    "  fi",
    `  cp -- "$src" '${fontsDir}/'"$name.pfb"`,
    `done < '${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_PFB_LIST}'`,
    `for pdf in '${PAPER_CONTAINER_PATHS.work}/pics/'*.pdf; do`,
    "  [ -f \"$pdf\" ] || continue",
    "  out=\"${pdf%.pdf}.svg\"",
    "  [ -f \"$out\" ] && continue",
    "  tmp=\"$(mktemp -d)\"",
    "  eps=\"$tmp/picture.eps\"",
    "  if gs -q -dNOPAUSE -dBATCH -dSAFER -sDEVICE=eps2write \"-sOutputFile=$eps\" \"$pdf\" >&2 &&",
    "     dvisvgm --eps --no-fonts --optimize=all \"--tmpdir=$tmp\" \"--output=$out\" \"$eps\" >&2; then",
    "    if grep -q '<image' \"$out\"; then",
    "      if gs -q -dNOPAUSE -dBATCH -dSAFER -dNOTRANSPARENCY -sDEVICE=eps2write \"-sOutputFile=$tmp/flat.eps\" \"$pdf\" >&2 &&",
    "         dvisvgm --eps --no-fonts --optimize=all \"--tmpdir=$tmp\" \"--output=$tmp/flat.svg\" \"$tmp/flat.eps\" >&2 &&",
    "         ! grep -q '<image' \"$tmp/flat.svg\"; then",
    "        cat \"$tmp/flat.svg\" > \"$out\"",
    `        : > "\${pdf%.pdf}.${WEB_EXPORT_FLAT_SUFFIX}"`,
    "        echo \"lax paper-web export: picture redrawn without transparency: $pdf\" >&2",
    "      fi",
    "    fi",
    "  else",
    "    echo \"lax paper-web export: picture not converted: $pdf\" >&2",
    "    rm -f \"$out\"",
    "  fi",
    "  rm -rf \"$tmp\"",
    "done",
    "exit 0",
    "",
  ].join("\n");
}

/** The root `<svg viewBox='x y w h'>` of a dvisvgm conversion, single-quoted
 * as dvisvgm writes it — the fork's own root pattern, which reads the width
 * and height and ignores the origin. */
const SVG_ROOT =
  /(?<head><svg\b[^>]*\bviewBox=')(?<x>[\d.eE+-]+) (?<y>[\d.eE+-]+) (?<w>[\d.eE+-]+) (?<h>[\d.eE+-]+)(?<tail>'[^>]*>)(?<body>[\s\S]*)<\/svg>/u;

/**
 * One converted picture with its box's origin moved to `0 0`, or undefined
 * when it is there already (every conversion from PDF input) or the markup
 * is not a dvisvgm root.
 *
 * EPS input is drawn in PostScript's upward y: dvisvgm emits `viewBox='0 -h
 * w h'` and draws the page above the origin. Nothing downstream can see
 * that — the encode keeps only the viewBox's width and height, and the
 * viewer places a picture from its box's top-left corner — so the drawing
 * would land one box's height too high, over the text above it. Moving the
 * origin here, on the trusted side and before the encode reads the file,
 * keeps the box's size and puts the drawing back in it.
 */
export function pictureAtOrigin(svg: string): string | undefined {
  const match = SVG_ROOT.exec(svg);
  const groups = match?.groups;
  if (groups === undefined) return undefined;
  const x = Number(groups.x);
  const y = Number(groups.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return undefined;
  return (
    `${groups.head}0 0 ${groups.w} ${groups.h}${groups.tail}` +
    `<g transform='translate(${-x},${-y})'>${groups.body}</g></svg>`
  );
}

/** Every converted picture moved to a `0 0` origin, in place; the number
 * rewritten. Runs on the export's output before the encode child reads it. */
export function normalizePictureBoxes(webSrc: string): number {
  const picsDir = path.join(webSrc, "pics");
  if (!fs.existsSync(picsDir)) return 0;
  let moved = 0;
  for (const name of fs.readdirSync(picsDir).sort()) {
    if (!name.endsWith(".svg")) continue;
    const file = path.join(picsDir, name);
    if (!fs.lstatSync(file).isFile()) continue;
    const rewritten = pictureAtOrigin(fs.readFileSync(file, "utf8"));
    if (rewritten === undefined) continue;
    fs.writeFileSync(file, rewritten);
    moved += 1;
  }
  return moved;
}

/** The pictures the export had to redraw without transparency, by their
 * PDF's name — the `.flattened` markers the script leaves. Read after a
 * successful export, before the encode. */
export function webFlattenedPictures(webSrc: string): string[] {
  const picsDir = path.join(webSrc, "pics");
  if (!fs.existsSync(picsDir)) return [];
  return fs
    .readdirSync(picsDir)
    .filter((name) => name.endsWith(`.${WEB_EXPORT_FLAT_SUFFIX}`))
    .map((name) => `${name.slice(0, -WEB_EXPORT_FLAT_SUFFIX.length - 1)}.pdf`)
    .sort();
}

/** The export set's count + total-bytes bound, over everything the export
 * resolved (fonts, legacy outlines) and the converted pictures, plus the
 * loud check that every requested font *file* actually came out — a name
 * kpsewhich could not resolve would otherwise surface as a confusing
 * host-side crash (the Validate host has no TeX). Legacy outlines are not
 * required: a missing pfb keeps the metric-box fallback, as on any host. */
export function webExportProblem(
  webSrc: string,
  requestedFonts: readonly string[],
  limits: ValidationLimits,
): WebWarning | undefined {
  const fontsDir = path.join(webSrc, WEB_EXPORT_FONTS_DIR);
  const missing = requestedFonts.filter(
    (name) => fs.lstatSync(path.join(fontsDir, name), { throwIfNoEntry: false })?.isFile() !== true,
  );
  if (missing.length > 0) {
    return {
      rule: "web-font-export",
      message:
        "the reflow view was not derived: the TeX image could not resolve " +
        `font file(s) the run used: ${missing.slice(0, 10).join(", ")}` +
        (missing.length > 10 ? ` (and ${missing.length - 10} more)` : "") +
        " (fonts loaded outside the TeX tree cannot be served)",
    };
  }
  const exported: string[] = [];
  for (const name of fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir).sort() : []) {
    exported.push(path.join(fontsDir, name));
  }
  const picsDir = path.join(webSrc, "pics");
  const unconverted: string[] = [];
  if (fs.existsSync(picsDir)) {
    for (const name of fs.readdirSync(picsDir).sort()) {
      if (name.endsWith(".svg")) exported.push(path.join(picsDir, name));
      if (name.endsWith(".pdf") && !fs.existsSync(path.join(picsDir, `${name.slice(0, -4)}.svg`))) {
        unconverted.push(name);
      }
    }
  }
  if (unconverted.length > 0) {
    // Every externalized picture must arrive converted: the host encode has
    // no dvisvgm (its seam is shut), so a missing SVG there would surface as
    // a confusing encode failure instead of naming the picture.
    return {
      rule: "web-picture-export",
      message:
        "the reflow view was not derived: the TeX image could not convert " +
        `picture(s) to SVG: ${unconverted.slice(0, 10).join(", ")}` +
        (unconverted.length > 10 ? ` (and ${unconverted.length - 10} more)` : ""),
    };
  }
  if (exported.length > limits.paperWebExportFiles) {
    return {
      rule: "web-export-cap",
      message:
        `the reflow view was not derived: the container export holds ${exported.length} files, ` +
        `over the ${limits.paperWebExportFiles} cap`,
    };
  }
  let totalBytes = 0;
  for (const filename of exported) {
    totalBytes += fs.lstatSync(filename, { throwIfNoEntry: false })?.size ?? 0;
  }
  if (totalBytes > limits.paperWebExportBytes) {
    return {
      rule: "web-export-cap",
      message:
        `the reflow view was not derived: the container export is ${(totalBytes / (1024 * 1024)).toFixed(1)} MiB, ` +
        `over the ${(limits.paperWebExportBytes / (1024 * 1024)).toFixed(1)} MiB cap`,
    };
  }
  return undefined;
}

/**
 * The container-backed web deriver the trusted pipeline wires by default
 * (ValidationOptions.webDeriver overrides it — the fake-runner seam). The
 * compile and export run in PAPER_IMAGE through the runner with exactly the
 * PDF compile's two mounts — the web copy (writable) and the marker-package
 * directory (read-only, `laxreflow.sty` beside `laxmark.sty`) — and the
 * encode child runs host-side over the fetched fork, its dvisvgm seam
 * pinned shut so a picture that missed the in-image conversion fails loudly
 * instead of reaching for a host binary.
 */
export function containerWebDeriver(
  runner: ValidationRunner,
  options: { reflowtexRoot?: string; styDir?: string } = {},
): WebDeriver {
  return async (input) => runWebDerivation(async (warnings, skip) => {
    // ── prerequisites: the fetched fork (host side) and the pinned image ─
    const reflowtex = probeReflowtex(options.reflowtexRoot ?? reflowtexDirectory());
    if ("missing" in reflowtex) {
      return skip("web-toolchain", `the reflow view was not derived: missing ${reflowtex.missing}`);
    }
    const image = paperImage();
    await runner.verifyImage(image);
    const styDir = options.styDir ?? laxmarkDirectory();

    // ── the fresh web copy and the injected in-image compile ─────────────
    const paper = input.paper;
    const { webSrc, webOut } = prepareWebSource(input, reflowtex.serializer);
    const compile = await runner.run({
      label: "paper-web-compile",
      image,
      args: ["latexmk", ...webLatexmkArguments(paper.manifest.main)],
      mounts: [
        { source: webSrc, target: PAPER_CONTAINER_PATHS.work, writable: true },
        { source: styDir, target: PAPER_CONTAINER_PATHS.tex },
      ],
      workdir: PAPER_CONTAINER_PATHS.work,
      env: {
        ...webCompileEnvironment(PAPER_CONTAINER_PATHS.work, PAPER_CONTAINER_PATHS.tex, input.sourceDateEpoch),
        HOME: "/tmp",
      },
      timeoutMs: input.limits.paperCompileTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    const compileProblem = webCompileProblem(compile, webSrc, paper.manifest.main, input.limits);
    if (compileProblem !== undefined) return skip(compileProblem.rule, compileProblem.message);
    const streamProblem = serializedStreamProblem(webSrc, input.limits);
    if (streamProblem !== undefined) return skip(streamProblem.rule, streamProblem.message);

    // ── the bounded export: fonts and legacy outlines by name, pictures
    //    to SVG, all in-image ───────────────────────────────────────────────
    const fontNames = webFontFilenames(webSrc, input.limits);
    const legacyNames = webLegacyFontNames(webSrc, input.limits);
    // A legacy face may export two files (outline and encoding vector).
    if (fontNames.length + 2 * legacyNames.length > input.limits.paperWebExportFiles) {
      return skip(
        "web-export-cap",
        `the reflow view was not derived: the run used ${fontNames.length + legacyNames.length} font files, ` +
          `over the ${input.limits.paperWebExportFiles} cap`,
      );
    }
    // The compile (author code, -shell-escape) ran before these files are
    // written, so it cannot tamper with them — and the fonts directory is
    // re-made empty so nothing the compile planted pre-seeds the export.
    fs.rmSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR), { recursive: true, force: true });
    fs.writeFileSync(path.join(webSrc, WEB_EXPORT_FONT_LIST), fontNames.map((name) => `${name}\n`).join(""), { mode: 0o600 });
    fs.writeFileSync(path.join(webSrc, WEB_EXPORT_PFB_LIST), legacyNames.map((name) => `${name}\n`).join(""), { mode: 0o600 });
    fs.writeFileSync(path.join(webSrc, WEB_EXPORT_SCRIPT), webExportScript(), { mode: 0o600 });
    const exported = await runner.run({
      label: "paper-web-export",
      image,
      args: ["sh", `${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_SCRIPT}`],
      mounts: [
        { source: webSrc, target: PAPER_CONTAINER_PATHS.work, writable: true },
      ],
      workdir: PAPER_CONTAINER_PATHS.work,
      env: { HOME: "/tmp" },
      timeoutMs: input.limits.paperWebExportTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (exported.code !== 0 || exported.timedOut) {
      return skip(
        "web-export",
        exported.timedOut
          ? `the reflow view was not derived: the export step did not finish within ${Math.round(input.limits.paperWebExportTimeoutMs / 60_000)} minutes`
          : `the reflow view was not derived: the export step failed (exit ${exported.code})`,
      );
    }
    const exportProblem = webExportProblem(webSrc, fontNames, input.limits);
    if (exportProblem !== undefined) return skip(exportProblem.rule, exportProblem.message);
    normalizePictureBoxes(webSrc);
    const flattened = webFlattenedPictures(webSrc);
    if (flattened.length > 0) {
      // Derived, and whole, but not identical: the drawing is there and the
      // transparency is not, so the author is told rather than left to spot
      // a solid node where the paper has a faded one.
      warnings.push({
        rule: "web-pictures-flattened",
        message:
          `the reflow view redrew ${flattened.length} picture(s) without transparency ` +
          `(${flattened.slice(0, 5).join(", ")}${flattened.length > 5 ? ", …" : ""}): ` +
          "Ghostscript renders a transparent picture as a raster image, which the view cannot carry, " +
          "so faded or blended parts are drawn solid",
      });
    }

    // ── everything after compile + export is the shared engine ───────────
    return encodeAndSealWebBundle(input, reflowtex, webSrc, webOut, warnings, skip, {
      extraArgs: ["--fonts", path.join(webSrc, WEB_EXPORT_FONTS_DIR)],
      env: {
        // The dvisvgm seam stays shut: conversion already happened inside
        // the pinned image, and a picture that missed it must fail loudly,
        // never fall back to whatever the host carries.
        REFLOWTEX_DVISVGM: "false",
        // Legacy Type1 outlines resolve from the export, never a host tree.
        REFLOWTEX_PFB_DIR: path.join(webSrc, WEB_EXPORT_FONTS_DIR),
      },
    });
  });
}
