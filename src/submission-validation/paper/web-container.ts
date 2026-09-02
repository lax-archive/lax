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

/**
 * The in-image export step: resolve each requested font file by name and
 * each legacy face's Type1 outline (`<name>.pfb`) with kpsewhich — the
 * same lookups the encode's own provisioning and t1 conversion would do if
 * the host had TeX — into the fonts directory, then convert every
 * externalized picture PDF to SVG with the image's dvisvgm, using exactly
 * the fork's invocation (transforms.py) including the private tmpdir. A
 * file kpsewhich cannot resolve or a picture dvisvgm cannot convert is
 * simply left absent — the deriver checks the required pieces afterwards
 * and skips loudly (a missing pfb is not required: it degrades to metric
 * boxes exactly as on a TeX-full host), so nothing fails silently and the
 * script itself stays simple.
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
    "while IFS= read -r name; do",
    "  [ -n \"$name\" ] || continue",
    "  src=\"$(kpsewhich \"$name.pfb\" || true)\"",
    "  if [ -n \"$src\" ] && [ -f \"$src\" ]; then",
    `    cp -- "$src" '${fontsDir}/'"$name.pfb"`,
    "  fi",
    `done < '${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_PFB_LIST}'`,
    `for pdf in '${PAPER_CONTAINER_PATHS.work}/pics/'*.pdf; do`,
    "  [ -f \"$pdf\" ] || continue",
    "  out=\"${pdf%.pdf}.svg\"",
    "  [ -f \"$out\" ] && continue",
    "  tmp=\"$(mktemp -d)\"",
    "  dvisvgm --pdf --no-fonts --optimize=all \"--tmpdir=$tmp\" \"--output=$out\" \"$pdf\" || true",
    "  rm -rf \"$tmp\"",
    "done",
    "exit 0",
    "",
  ].join("\n");
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
  if (fs.existsSync(picsDir)) {
    for (const name of fs.readdirSync(picsDir).sort()) {
      if (name.endsWith(".svg")) exported.push(path.join(picsDir, name));
    }
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
    if (fontNames.length + legacyNames.length > input.limits.paperWebExportFiles) {
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
