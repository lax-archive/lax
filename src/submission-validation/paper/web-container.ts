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
// in-image step converts them to (the encode host has no PDF converter at
// all — the fork consumes a pre-converted `<src>.svg` as-is, sanitizer
// still applied), and the font files the run used,
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
 * host *after* the compile container exited, so the compile cannot change
 * what they say — it can only have left something of its own at these
 * names first, which is what `writeIntoWebCopy` takes away. None of them
 * can shadow author content (the fresh copy is re-made per run) and none
 * enter the sealed bundle. */
export const WEB_EXPORT_SCRIPT = "lax-web-export.sh";
export const WEB_EXPORT_CONVERTER = "lax-web-convert.py";
export const WEB_EXPORT_FONT_LIST = "lax-web-fonts.txt";
export const WEB_EXPORT_PFB_LIST = "lax-web-pfbs.txt";
export const WEB_EXPORT_PICTURE_LIST = "lax-web-pictures.json";
export const WEB_EXPORT_FONTS_DIR = "lax-fonts";
/** Extension of the marker the export leaves beside a raster picture it had
 * to downsample to the long-edge cap. */
export const WEB_EXPORT_DOWNSAMPLED_SUFFIX = "downsampled";
/** Where the unpacked PyMuPDF wheel is mounted, read-only, in the export
 * container — `PYTHONPATH`, and the only thing in it. */
export const WEB_PYMUPDF_PATH = "/opt/lax/pymupdf";

/**
 * Every host-side write into the web copy, with whatever the path holds
 * removed first.
 *
 * The copy is the compile's own writable mount and the compile is author
 * code running with `-shell-escape`, so each name the host writes to after
 * it — the export step's script, the lists that step reads, the rewritten
 * `output.json`, a finished encoding vector — may already exist as a
 * symlink the compile planted, pointing at anything on the runner the job
 * can reach. `writeFileSync` opens by name and follows such a link, which
 * puts host-written bytes at the far end of it. Unlinking takes the
 * redirect away rather than merely noticing it, which is all an `lstat`
 * before the write can do: a check speaks for the moment it ran, and is
 * easy to leave off the next write added here. So every write in this
 * module goes through this one function and no name it writes can be left
 * out. The one *directory* the host later reaches through, `pics`, is a
 * component rather than a name written and is settled by
 * `webPicturesDirectory` instead.
 */
function writeIntoWebCopy(file: string, contents: string, mode?: number): void {
  // `recursive` so a whole directory planted under a host-owned name goes
  // too; node's removal lstats, so a symlink loses the link, never the
  // thing it points at.
  fs.rmSync(file, { recursive: true, force: true });
  fs.writeFileSync(file, contents, mode === undefined ? undefined : { mode });
}

/**
 * The externalized pictures' directory in the web copy, as a real directory
 * the host owns.
 *
 * `prepareWebSource` creates `pics/` before the compile, and the compile —
 * author code, `-shell-escape`, the copy its own writable mount — may throw
 * it away and leave a symlink at that name. Everything the host does with a
 * picture afterwards spells the name out: the slot pre-clears and the box
 * normalization write and delete under `pics/<something>`, the export
 * accounting reads the directory, and the encode sources every converted
 * SVG from it. Removing a symlink at the *leaf* of one of those paths does
 * nothing about a link one component higher, which redirects all of them at
 * once, so the component is settled here — once, before the host touches
 * anything under it — and every later step asks this function where the
 * directory is rather than joining the name itself.
 *
 * Replacing what stands there costs the run nothing it still had: a compile
 * that unlinked `pics/` deleted its own externalized pictures with it, and a
 * picture with no converted SVG is precisely the fork's kern fallback,
 * counted as `web-pictures-dropped` like any picture the converter could not
 * read.
 */
function webPicturesDirectory(webSrc: string): string {
  const picsDir = path.join(webSrc, "pics");
  // A symlink lstats as a link whatever it points at, so this is false for
  // one aimed at a directory; the removal that follows takes the link and
  // never the directory at the far end of it.
  if (fs.lstatSync(picsDir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    fs.rmSync(picsDir, { recursive: true, force: true });
    fs.mkdirSync(picsDir, { recursive: true });
  }
  return picsDir;
}

/**
 * The in-image export step: resolve each requested font file by name and
 * each legacy face's Type1 outline with kpsewhich — the same lookups the
 * encode's own provisioning and t1 conversion would do if the host had
 * TeX — into the fonts directory, then run the picture converter
 * (`webConvertScript`, PyMuPDF over the mounted wheel), which is the only
 * thing in the container that turns a picture into SVG.
 *
 * It used to be the image's own dvisvgm, through a Ghostscript EPS detour,
 * and both halves of that were losses. dvisvgm's direct `--pdf` input needs
 * Ghostscript < 10.01 or mutool, and the pinned TL2025 image ships
 * Ghostscript 10.07 and no mutool (measured 2026-09-03, the first docker
 * smoke of this path), so the PDF had to go through `gs -sDEVICE=eps2write`
 * first — and Ghostscript rasterizes any page it cannot express in
 * PostScript, which for a tikz picture means any transparency at all (an
 * `opacity=` node, a shading): the whole drawing came back as one embedded
 * JPEG, which the encode's SVG sanitizer dropped, so the figure arrived
 * empty (measured on lax-65, whose two figures both carry faded nodes).
 * MuPDF reads the PDF directly, keeps the alpha, and is a quarter of the
 * size, so the chain is gone rather than kept as a fallback: one converter,
 * one failure mode.
 *
 * A file kpsewhich cannot resolve or a picture that does not convert is
 * left absent, with the converter's transcript on stderr — the deriver
 * checks the required pieces afterwards and skips loudly (a missing pfb is
 * not required: it degrades to metric boxes exactly as on a TeX-full
 * host), so nothing fails silently and the script itself stays simple.
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
    "# The files a pdftex.map line names, as its `<file` tokens give them.",
    "map_files() {",
    "  pfb=\"\"; enc=\"\"",
    "  [ -n \"$map\" ] && [ -f \"$map\" ] || return 0",
    "  for tok in $(awk -v n=\"$1\" '$1 == n { print; exit }' \"$map\"); do",
    "    case \"$tok\" in",
    "      '<<'*) f=\"${tok#<<}\" ;;",
    "      '<['*) f=\"${tok#<[}\" ;;",
    "      '<'*) f=\"${tok#<}\" ;;",
    "      *) continue ;;",
    "    esac",
    "    case \"$f\" in",
    "      *.enc) enc=\"$f\" ;;",
    "      *.pfb|*.pfa) pfb=\"$f\" ;;",
    "    esac",
    "  done",
    "}",
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
    "  map_files \"$name\"",
    "  # A face pdftex.map does not name may be a *virtual* font: TeX's own",
    "  # indirection, drawing most of its slots from one real font (the",
    "  # calligraphic BOONDOX-r-cal every lipics paper's \\mathcal reaches",
    "  # for is zxxrw7z) and borrowing the rest elsewhere. Follow it to that",
    "  # base font and export its outline under the *virtual* name, with the",
    "  # program (vpl) and the base's encoding beside it: the host keeps only",
    "  # the slots the two share, so a borrowed slot stays a metric box",
    "  # rather than becoming the base font's glyph for that slot.",
    "  if [ -z \"$pfb\" ]; then",
    "    vf=\"$(kpsewhich \"$name.vf\" || true)\"",
    "    tfm=\"$(kpsewhich \"$name.tfm\" || true)\"",
    `    vpl='${fontsDir}/'"$name.vpl"`,
    "    if [ -n \"$vf\" ] && [ -n \"$tfm\" ] && vftovp \"$vf\" \"$tfm\" \"$vpl\" >/dev/null 2>&1; then",
    "      base=\"$(awk '/^\\(MAPFONT D 0/ { getline; gsub(/[()]/, \"\"); sub(/^ *FONTNAME */, \"\"); print; exit }' \"$vpl\")\"",
    "      if [ -n \"$base\" ]; then map_files \"$base\"; fi",
    "      if [ -z \"$pfb\" ]; then rm -f \"$vpl\"; fi",
    "    else",
    "      rm -f \"$vpl\"",
    "    fi",
    "  fi",
    "  [ -n \"$pfb\" ] || pfb=\"$name.pfb\"",
    "  src=\"$(kpsewhich \"$pfb\" || true)\"",
    "  [ -n \"$src\" ] && [ -f \"$src\" ] || continue",
    "  if [ -n \"$enc\" ]; then",
    "    esrc=\"$(kpsewhich \"$enc\" || true)\"",
    "    [ -n \"$esrc\" ] && [ -f \"$esrc\" ] || continue",
    `    cp -- "$esrc" '${fontsDir}/'"$name.enc"`,
    "  fi",
    `  if [ -f '${fontsDir}/'"$name.vpl" ]; then`,
    "    # The base's slot names, for the host to filter: its own vector",
    "    # where the map line names one, else 8a.enc where the outline says",
    "    # StandardEncoding (the same table under TeX's name for it); an",
    "    # outline that carries its own vector is read from the pfb itself.",
    `    if [ -f '${fontsDir}/'"$name.enc" ]; then`,
    `      mv '${fontsDir}/'"$name.enc" '${fontsDir}/'"$name.base-enc"`,
    "    elif t1disasm \"$src\" 2>/dev/null | grep -q '^/Encoding StandardEncoding def'; then",
    "      std=\"$(kpsewhich 8a.enc || true)\"",
    `      [ -n "$std" ] && cp -- "$std" '${fontsDir}/'"$name.base-enc"`,
    "    fi",
    "  fi",
    `  cp -- "$src" '${fontsDir}/'"$name.pfb"`,
    `done < '${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_PFB_LIST}'`,
    "# The picture converter (PyMuPDF): every externalized tikz PDF and every",
    "# listed \\includegraphics file, straight to SVG. Per-file failures are",
    "# reported on stderr and leave that picture's SVG absent, which the host",
    "# then accounts for; nothing else in the image can read a PDF.",
    `python3 '${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_CONVERTER}' >&2 ||`,
    "  echo 'lax paper-web export: the picture converter did not run' >&2",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * The in-image picture converter: PyMuPDF (pins.ts, mounted read-only at
 * WEB_PYMUPDF_PATH) turning every picture the run holds into SVG, written by
 * the host into the job copy after the compile the way the export script is.
 *
 * The pinned TeX Live image carries no other way to read a PDF: dvisvgm
 * cannot take PDF input against its Ghostscript, and the Ghostscript detour
 * rasterizes every page with transparency. MuPDF reads the file directly,
 * keeps `fill-opacity`/`stroke-opacity`, draws text as paths, and emits only
 * elements the fork's sanitizer already allows — at roughly a quarter of the
 * flattened output's size (measured on lax-65: 59 KB and 43 KB against
 * 247 KB and 205 KB).
 *
 * Two kinds of input, both bounded. A PDF (an externalized tikz picture, a
 * vector figure) becomes its single page's vector SVG — more than one page is
 * refused rather than silently cropped. A raster (`\\includegraphics` of a
 * PNG or a JPEG) has no vector form, so it is re-encoded through a Pixmap —
 * which turns untrusted bytes into pixels this process produced — downsampled
 * to the long-edge cap, and wrapped in an `<svg>` holding one `<image>` with a
 * `data:` URI; the fork's sanitizer re-checks the media type against the
 * decoded magic number on the way in. Every conversion is capped by output
 * size and no single failure is fatal: an unconverted picture simply leaves no
 * SVG, and the caller degrades it to the kern fallback.
 *
 * The `\\includegraphics` files are named by the *slot* the host assigned
 * (`assignIncludedPictureSlots`), never by their own path, and each one is
 * resolved inside the job copy or the image's TeX tree or not at all.
 */
export function webConvertScript(limits: ValidationLimits): string {
  return `#!/usr/bin/env python3
# lax paper-web picture conversion (written by the trusted deriver after the
# compile, run inside the pinned TeX image against the mounted PyMuPDF).
import base64, glob, json, os, subprocess, sys

WORK = "${PAPER_CONTAINER_PATHS.work}"
MAX_SVG_BYTES = ${limits.paperWebPictureBytes}
RASTER_LONG_EDGE = ${limits.paperWebRasterLongEdge}
PICTURE_LIST = os.path.join(WORK, "${WEB_EXPORT_PICTURE_LIST}")
DOWNSAMPLED_SUFFIX = "${WEB_EXPORT_DOWNSAMPLED_SUFFIX}"

import pymupdf


def note(message):
    print("lax paper-web convert: " + message, file=sys.stderr)


def kpse(*args):
    try:
        done = subprocess.run(["kpsewhich", *args], capture_output=True,
                              text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


# Where a \\includegraphics file may come from: the job's own copy, or the
# image's TeX tree (a class logo). Anything else — /etc, /proc, a symlink out
# of the copy — is refused: the compile ran with -shell-escape and wrote both
# the file names and the files, so a resolved path is checked, never trusted.
def allowed_roots():
    roots = [os.path.realpath(WORK)]
    for var in ("SELFAUTOPARENT", "TEXMFDIST", "TEXMFLOCAL", "TEXMFHOME", "TEXMFVAR"):
        value = kpse("--var-value=" + var)
        if value and os.path.isdir(value):
            roots.append(os.path.realpath(value))
    return roots


ROOTS = allowed_roots()


def contained(path):
    return any(path == root or path.startswith(root + os.sep) for root in ROOTS)


def resolve(name):
    """The listed file as an absolute path inside an allowed root, or None."""
    inside = os.path.realpath(os.path.join(WORK, name))
    if os.path.isfile(inside) and contained(inside):
        return inside
    found = kpse(name).splitlines()
    if found:
        outside = os.path.realpath(found[0])
        if os.path.isfile(outside) and contained(outside):
            return outside
    return None


def write_svg(out, svg):
    data = svg.encode("utf-8")
    if len(data) > MAX_SVG_BYTES:
        note("over the %d byte cap, not converted: %s" % (MAX_SVG_BYTES, out))
        return False
    with open(out, "wb") as handle:
        handle.write(data)
    return True


def vector_svg(source):
    """One page of a PDF as pure vector SVG, text drawn as paths (no font
    lookup on the reader's side, and none of dvisvgm's id collisions)."""
    document = pymupdf.open(source)
    try:
        if document.page_count != 1:
            raise RuntimeError("%d pages, expected exactly 1" % document.page_count)
        return document[0].get_svg_image(text_as_path=True)
    finally:
        document.close()


def raster_svg(source, jpeg):
    """A raster re-encoded through a Pixmap — which normalizes untrusted bytes
    into pixels this process produced — downsampled to the long-edge cap and
    wrapped in an <svg> holding one <image>. Returns (svg, downsampled)."""
    pixmap = pymupdf.Pixmap(source)
    downsampled = False
    while max(pixmap.width, pixmap.height) > RASTER_LONG_EDGE and min(pixmap.width, pixmap.height) > 1:
        pixmap.shrink(1)  # halves both dimensions in place
        downsampled = True
    if jpeg and pixmap.alpha:
        pixmap = pymupdf.Pixmap(pixmap, 0)  # JPEG carries no alpha channel
    if pixmap.colorspace is not None and pixmap.colorspace.n > 3:
        pixmap = pymupdf.Pixmap(pymupdf.csRGB, pixmap)
    payload = base64.b64encode(pixmap.tobytes("jpeg" if jpeg else "png")).decode("ascii")
    mime = "image/jpeg" if jpeg else "image/png"
    width, height = pixmap.width, pixmap.height
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' "
        "xmlns:xlink='http://www.w3.org/1999/xlink' "
        "width='%d' height='%d' viewBox='0 0 %d %d'>"
        "<image width='%d' height='%d' xlink:href='data:%s;base64,%s'/></svg>"
        % (width, height, width, height, width, height, mime, payload)
    )
    return svg, downsampled


def convert(source, out):
    """Returns True when \`out\` now holds the picture. Never raises."""
    extension = os.path.splitext(source)[1].lower()
    try:
        if extension in (".png", ".jpg", ".jpeg"):
            svg, downsampled = raster_svg(source, extension != ".png")
            if not write_svg(out, svg):
                return False
            if downsampled:
                open(out[: -len(".svg")] + "." + DOWNSAMPLED_SUFFIX, "wb").close()
            return True
        return write_svg(out, vector_svg(source))
    except Exception as error:  # noqa: BLE001 — one bad picture is not fatal
        note("not converted: %s (%s: %s)" % (source, type(error).__name__, error))
        try:
            os.unlink(out)
        except OSError:
            pass
        return False


# ── the externalized tikz pictures, by their own name ─────────────────────
for pdf in sorted(glob.glob(os.path.join(WORK, "pics", "*.pdf"))):
    out = pdf[: -len(".pdf")] + ".svg"
    if not os.path.exists(out):
        convert(pdf, out)

# ── the \\includegraphics files, by the slot the host assigned each ────────
try:
    with open(PICTURE_LIST, "r", encoding="utf-8") as handle:
        listed = json.load(handle)
except (OSError, ValueError):
    listed = []
for entry in listed:
    slot, name = entry["slot"], entry["file"]
    source = resolve(name)
    if source is None:
        note("not resolved inside the job copy or the TeX tree: %s" % name)
        continue
    convert(source, os.path.join(WORK, slot + ".svg"))
`;
}

// ── virtual fonts ──────────────────────────────────────────────────────────
//
// A virtual font is a program: per slot, a little list of instructions over
// the real fonts it maps in. The export follows it to the font it draws most
// of its slots from (MAPFONT 0) and exports that outline under the virtual
// name; what is left is deciding which slots the two actually share.
//
// A slot is shared when its program draws exactly one character, from the
// base font, at its own code — moves are ignored, since the advance a
// reflowed line uses is the one TeX recorded in the node list, not the
// outline's. A slot drawn from another mapped font (BOONDOX-r-cal takes its
// digits from cmr10, having none of its own) or drawn at a different code is
// not shared, and keeps the metric box it has today: the encoding written
// here names the base's glyph for shared slots and `.notdef` for the rest,
// so no slot can quietly become the base font's glyph for a code the
// virtual font meant for someone else.

/** A character in a vpl (vftovp's text form of a virtual font). */
const VPL_CHARACTER = /\(CHARACTER\s+([CDOH])\s+(\S+?)\s*\n(.*?)\n {3}\)/gsu;
/** The instructions of that character's MAP, innermost list only. */
const VPL_MAP = /\(MAP\s*(.*?)\s*\)\s*$/su;
const VPL_SETCHAR = /^\(SETCHAR\s+([CDOH])\s+(\S+?)\s*\)$/u;
const VPL_SELECTFONT = /^\(SELECTFONT\s+([CDOH])\s+(\S+?)\s*\)$/u;
const VPL_MOVE = /^\((?:MOVERIGHT|MOVELEFT|MOVEUP|MOVEDOWN)\s/u;

/** A vpl number: `C x` a character, `D n` decimal, `O n` octal, `H n` hex. */
function vplNumber(kind: string, value: string): number | undefined {
  if (kind === "C") return value.length === 1 ? value.codePointAt(0) : undefined;
  const parsed = Number.parseInt(value, kind === "D" ? 10 : kind === "O" ? 8 : 16);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 256 ? parsed : undefined;
}

/** The slots a virtual font draws from its base font at their own code. */
export function sharedSlots(vpl: string): Set<number> {
  const shared = new Set<number>();
  for (const character of vpl.matchAll(VPL_CHARACTER)) {
    const slot = vplNumber(character[1]!, character[2]!);
    if (slot === undefined) continue;
    const map = VPL_MAP.exec(character[3]!);
    if (map === null) continue;
    let base = true;
    let drawn: number | undefined;
    for (const raw of map[1]!.split("\n")) {
      const instruction = raw.trim();
      if (instruction === "" || VPL_MOVE.test(instruction)) continue;
      const font = VPL_SELECTFONT.exec(instruction);
      if (font !== null) {
        base = vplNumber(font[1]!, font[2]!) === 0;
        continue;
      }
      const setchar = VPL_SETCHAR.exec(instruction);
      if (setchar === null || drawn !== undefined) {
        drawn = undefined; // anything else drawn, or a second glyph: not shared
        break;
      }
      drawn = base ? vplNumber(setchar[1]!, setchar[2]!) : undefined;
      if (drawn === undefined) break;
    }
    if (drawn === slot) shared.add(slot);
  }
  return shared;
}

/** The 256 slot names of a dvips/pdftex `.enc` vector — `/Name [ /g … ] def`,
 * `%` comments stripped — or undefined when the text is not one. */
export function parseEncoding(text: string): (string | undefined)[] | undefined {
  const body = /\[([^\]]*)\]/su.exec(text.replace(/%[^\n]*/gu, ""));
  if (body === null) return undefined;
  const names = [...body[1]!.matchAll(/\/([^\s/[\]{}()<>]+)/gu)].map((name) => name[1]!);
  if (names.length === 0 || names.length > 256) return undefined;
  return Array.from({ length: 256 }, (_, slot) => {
    const name = names[slot];
    return name === undefined || name === ".notdef" ? undefined : name;
  });
}

/** A Type1 outline's own encoding, from the `dup <slot> /<name> put` lines of
 * its cleartext header — undefined when it names a standard vector instead
 * (the export leaves that one beside it) or carries none. */
export function outlineEncoding(pfb: Buffer): (string | undefined)[] | undefined {
  const header = pfb.subarray(0, 16_384).toString("latin1");
  const eexec = header.indexOf("eexec");
  const cleartext = eexec === -1 ? header : header.slice(0, eexec);
  const names: (string | undefined)[] = Array.from({ length: 256 }, () => undefined);
  let found = false;
  for (const entry of cleartext.matchAll(/\bdup\s+(\d{1,3})\s*\/([^\s/[\]{}()<>]+)\s+put/gu)) {
    const slot = Number(entry[1]);
    if (slot < 0 || slot > 255 || entry[2] === ".notdef") continue;
    names[slot] = entry[2];
    found = true;
  }
  return found ? names : undefined;
}

/** The `.enc` text naming `names` at the slots in `shared`, `.notdef`
 * elsewhere — the vector the encode addresses the outline through. */
export function encodingFile(vector: string, names: (string | undefined)[], shared: ReadonlySet<number>): string {
  const slots = Array.from({ length: 256 }, (_, slot) => {
    const name = shared.has(slot) ? names[slot] : undefined;
    return `/${name ?? ".notdef"}`;
  });
  const lines: string[] = [];
  for (let slot = 0; slot < 256; slot += 8) lines.push(`  ${slots.slice(slot, slot + 8).join(" ")}`);
  return `% written by lax: the slots ${vector} shares with the outline it is drawn from.\n/${vector} [\n${lines.join("\n")}\n] def\n`;
}

/**
 * Every virtual face the export followed to a base outline, finished: its
 * encoding filtered to the slots the two share. A face whose program or
 * base encoding cannot be read loses its outline instead — metric boxes, as
 * before, never another font's glyphs — and is named in the return value.
 * The vpl and the unfiltered vector are removed either way; neither belongs
 * in the export set the caps count.
 */
export function resolveVirtualFonts(webSrc: string): { resolved: string[]; refused: string[] } {
  const fontsDir = path.join(webSrc, WEB_EXPORT_FONTS_DIR);
  if (!fs.existsSync(fontsDir)) return { resolved: [], refused: [] };
  const resolved: string[] = [];
  const refused: string[] = [];
  for (const entry of fs.readdirSync(fontsDir).sort()) {
    if (!entry.endsWith(".vpl")) continue;
    const name = entry.slice(0, -".vpl".length);
    const vpl = path.join(fontsDir, entry);
    const baseEnc = path.join(fontsDir, `${name}.base-enc`);
    const pfb = path.join(fontsDir, `${name}.pfb`);
    const shared = sharedSlots(fs.readFileSync(vpl, "utf8"));
    const names = fs.existsSync(baseEnc)
      ? parseEncoding(fs.readFileSync(baseEnc, "utf8"))
      : fs.existsSync(pfb)
        ? outlineEncoding(fs.readFileSync(pfb))
        : undefined;
    if (names === undefined || shared.size === 0) {
      fs.rmSync(pfb, { force: true });
      refused.push(name);
    } else {
      writeIntoWebCopy(path.join(fontsDir, `${name}.enc`), encodingFile(name, names, shared));
      resolved.push(name);
    }
    fs.rmSync(vpl, { force: true });
    fs.rmSync(baseEnc, { force: true });
  }
  return { resolved, refused };
}

/** The root `<svg viewBox='x y w h'>` of a converted picture — the fork's own
 * root pattern, which reads the width and height and ignores the origin,
 * with either quote character (MuPDF writes double, the fork single). */
const SVG_ROOT =
  /(?<head><svg\b[^>]*\bviewBox=(?<q>['"]))(?<x>[\d.eE+-]+) (?<y>[\d.eE+-]+) (?<w>[\d.eE+-]+) (?<h>[\d.eE+-]+)(?<tail>\k<q>[^>]*>)(?<body>[\s\S]*)<\/svg>/u;

/**
 * One converted picture with its box's origin moved to `0 0`, or undefined
 * when it is there already or the markup carries no `<svg viewBox>` root.
 *
 * Nothing downstream can see a picture's origin — the encode keeps only the
 * viewBox's width and height, and the viewer places a picture from its box's
 * top-left corner — so a drawing sitting anywhere else in its box would land
 * that far off, over the text around it. The retired dvisvgm route did that
 * on every picture (EPS is drawn in PostScript's upward y, so its root read
 * `viewBox='0 -h w h'`); MuPDF's conversions are all at `0 0`, so today this
 * is a guard that does not fire rather than a repair that must. It stays
 * because it is the one place a wrong origin could still be caught, on the
 * trusted side and before the encode reads the file.
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
  const picsDir = webPicturesDirectory(webSrc);
  let moved = 0;
  for (const name of fs.readdirSync(picsDir).sort()) {
    if (!name.endsWith(".svg")) continue;
    const file = path.join(picsDir, name);
    if (!fs.lstatSync(file).isFile()) continue;
    const rewritten = pictureAtOrigin(fs.readFileSync(file, "utf8"));
    if (rewritten === undefined) continue;
    writeIntoWebCopy(file, rewritten);
    moved += 1;
  }
  return moved;
}

// ── plain \includegraphics ─────────────────────────────────────────────────
//
// An externalized tikz picture is written by the compile into `pics/` under a
// name the compile chose, and the serializer records that stem. Every *other*
// picture — a class logo, an ORCID icon, a photograph, a figure exported as
// PDF — is a plain `\includegraphics`, and what `laxreflow.sty` records for it
// is the file name graphics.sty resolved: an author-controlled string out of a
// `-shell-escape` run's own output.json, pointing at a file that may sit
// anywhere the run could read.
//
// So the name never travels. Each distinct one is validated by shape, assigned
// a slot (`pics/lax-inc<N>`), and only the slot goes into the output.json the
// encode reads and into the bundle; the file itself is named exactly once, in
// the list the in-container converter resolves against the job copy and the
// TeX tree. A name that fails validation, and a slot the converter did not
// produce an SVG for, lose their `file` field — which is precisely the fork's
// kern fallback, reported as `web-pictures-dropped`.

/** The stem every included picture's slot is named with. */
export const WEB_INCLUDED_SLOT_PREFIX = "pics/lax-inc";

/** One path segment of an included graphics file name. It cannot begin with a
 * dot, so `..` is unspellable and no traversal can be expressed. */
const INCLUDED_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._+-]{0,99}";

/** An acceptable `\includegraphics` file: a relative name of at most eight
 * such segments, or the absolute form kpsewhich hands back for a file in the
 * TeX tree, with one of the four extensions the converter can read. Shape
 * only — the containment check that matters happens in the container, against
 * the resolved path. */
export const WEB_INCLUDED_FILE = new RegExp(
  `^/?(?:${INCLUDED_SEGMENT}/){0,8}${INCLUDED_SEGMENT}\\.(?:pdf|png|jpe?g)$`,
  "iu",
);

/** A picture the host gave a slot: the slot's stem inside the job copy, and
 * the file name the container is to resolve. */
export interface WebIncludedPicture {
  slot: string;
  file: string;
}

export interface WebIncludedPictures {
  included: WebIncludedPicture[];
  /** Distinct file values refused by shape or by the count cap; each one's
   * picture keeps its width as blank space. */
  refused: string[];
}

/** A tikz picture's own externalization stem, as the compile wrote it. */
function tikzStem(webSrc: string, file: string): boolean {
  return (
    /^pics\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(file) &&
    fs.lstatSync(path.join(webSrc, `${file}.pdf`), { throwIfNoEntry: false })?.isFile() === true
  );
}

/**
 * Give every plain `\includegraphics` in the serialized stream a slot,
 * rewriting `output.json` in place: a tikz stem is left alone, an acceptable
 * file name becomes its slot, anything else loses its `file` field. Runs after
 * the compile and before the export, and returns what the export must resolve.
 */
export function assignIncludedPictureSlots(webSrc: string, limits: ValidationLimits): WebIncludedPictures {
  const file = path.join(webSrc, "output.json");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size > limits.paperWebOutputJsonBytes) {
    return { included: [], refused: [] };
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const slots = new Map<string, string>();
  const refused = new Set<string>();
  let changed = false;
  walkPictureNodes(data, (node) => {
    const value = node.file;
    if (typeof value !== "string" || value === "") return;
    if (tikzStem(webSrc, value)) return;
    let slot = slots.get(value);
    if (slot === undefined) {
      if (!WEB_INCLUDED_FILE.test(value) || value.length > 512 || slots.size >= limits.paperWebIncludedPictures) {
        refused.add(value);
        delete node.file;
        changed = true;
        return;
      }
      slot = `${WEB_INCLUDED_SLOT_PREFIX}${slots.size}`;
      slots.set(value, slot);
    }
    node.file = slot;
    changed = true;
  });
  if (changed) writeIntoWebCopy(file, JSON.stringify(data));
  return {
    included: [...slots].map(([name, slot]) => ({ slot, file: name })),
    refused: [...refused].sort(),
  };
}

/**
 * The slots the export produced no SVG for, stripped from `output.json` so the
 * fork's kern fallback takes them instead of the encode dying on a picture it
 * cannot source. Returns their file names, for the report.
 */
export function dropUnconvertedPictures(
  webSrc: string,
  included: readonly WebIncludedPicture[],
  limits: ValidationLimits,
): string[] {
  const missing = new Map<string, string>();
  for (const picture of included) {
    if (fs.lstatSync(path.join(webSrc, `${picture.slot}.svg`), { throwIfNoEntry: false })?.isFile() !== true) {
      missing.set(picture.slot, picture.file);
    }
  }
  if (missing.size === 0) return [];
  const file = path.join(webSrc, "output.json");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size > limits.paperWebOutputJsonBytes) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  walkPictureNodes(data, (node) => {
    if (typeof node.file === "string" && missing.has(node.file)) delete node.file;
  });
  writeIntoWebCopy(file, JSON.stringify(data));
  return [...new Set(missing.values())].sort();
}

/** The raster pictures the export had to downsample, by the author's own file
 * name — the `.downsampled` markers the converter leaves. */
export function webDownsampledPictures(webSrc: string, included: readonly WebIncludedPicture[]): string[] {
  const names: string[] = [];
  for (const picture of included) {
    const marker = path.join(webSrc, `${picture.slot}.${WEB_EXPORT_DOWNSAMPLED_SUFFIX}`);
    if (fs.lstatSync(marker, { throwIfNoEntry: false })?.isFile() === true) names.push(picture.file);
  }
  return [...new Set(names)].sort();
}

/** Every `picture` node of a serialized stream, at any depth — the same walk
 * the fork's transforms do, over the parsed object as untrusted data. */
function walkPictureNodes(data: unknown, visit: (node: Record<string, unknown>) => void): void {
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const entry of nodes) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const node = entry as Record<string, unknown>;
      if (node.type === "picture") visit(node);
      for (const key of ["children", "replace", "pre", "post", "nobreak"]) walk(node[key]);
      if (node.leader !== undefined) walk([node.leader]);
    }
  };
  if (data === null || typeof data !== "object" || Array.isArray(data)) return;
  const document = data as Record<string, unknown>;
  for (const paragraph of Array.isArray(document.paragraphs) ? document.paragraphs : []) {
    if (paragraph !== null && typeof paragraph === "object") {
      walk((paragraph as Record<string, unknown>).nodes);
    }
  }
  for (const item of Array.isArray(document.content) ? document.content : []) {
    if (item === null || typeof item !== "object") continue;
    const box = (item as Record<string, unknown>).box;
    if (box !== null && typeof box === "object") walk((box as Record<string, unknown>).children);
  }
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
  const picsDir = webPicturesDirectory(webSrc);
  const unconverted: string[] = [];
  for (const name of fs.readdirSync(picsDir).sort()) {
    if (name.endsWith(".svg")) exported.push(path.join(picsDir, name));
    if (name.endsWith(".pdf") && !fs.existsSync(path.join(picsDir, `${name.slice(0, -4)}.svg`))) {
      unconverted.push(name);
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
    // written, so it cannot change what they say — but it chose what stood
    // at those names when the host arrived, which is why each write below
    // goes through `writeIntoWebCopy`; the fonts directory is re-made empty
    // for the same reason, so nothing the compile planted pre-seeds the
    // export. The pictures directory is settled here too, before the first
    // host step that names anything under it: it is the one path component
    // the host reaches through, and a link left there would carry all of
    // them out of the copy at once.
    fs.rmSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR), { recursive: true, force: true });
    webPicturesDirectory(webSrc);
    // Every plain \includegraphics gets a slot and the file names stay behind
    // (see "plain \includegraphics" above); the tikz pictures are untouched.
    const pictures = assignIncludedPictureSlots(webSrc, input.limits);
    // Slot names belong to the host, so nothing the compile left under one is
    // allowed to pre-seed the export — the same doctrine as the fonts
    // directory. (A planted SVG would still pass the fork's sanitizer, as any
    // picture must; this simply keeps the slot meaning what the host said.)
    for (const picture of pictures.included) {
      fs.rmSync(path.join(webSrc, `${picture.slot}.svg`), { force: true });
      fs.rmSync(path.join(webSrc, `${picture.slot}.${WEB_EXPORT_DOWNSAMPLED_SUFFIX}`), { force: true });
    }
    writeIntoWebCopy(path.join(webSrc, WEB_EXPORT_FONT_LIST), fontNames.map((name) => `${name}\n`).join(""), 0o600);
    writeIntoWebCopy(path.join(webSrc, WEB_EXPORT_PFB_LIST), legacyNames.map((name) => `${name}\n`).join(""), 0o600);
    writeIntoWebCopy(path.join(webSrc, WEB_EXPORT_PICTURE_LIST), `${JSON.stringify(pictures.included)}\n`, 0o600);
    writeIntoWebCopy(path.join(webSrc, WEB_EXPORT_CONVERTER), webConvertScript(input.limits), 0o600);
    writeIntoWebCopy(path.join(webSrc, WEB_EXPORT_SCRIPT), webExportScript(), 0o600);
    const exported = await runner.run({
      label: "paper-web-export",
      image,
      args: ["sh", `${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_SCRIPT}`],
      mounts: [
        { source: webSrc, target: PAPER_CONTAINER_PATHS.work, writable: true },
        // The picture converter's library, read-only and alone on PYTHONPATH:
        // the pinned image has no way of its own to read a PDF without
        // rasterizing it (pins.ts, PYMUPDF_*).
        { source: reflowtex.pymupdf, target: WEB_PYMUPDF_PATH },
      ],
      workdir: PAPER_CONTAINER_PATHS.work,
      env: { HOME: "/tmp", PYTHONPATH: WEB_PYMUPDF_PATH },
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
    resolveVirtualFonts(webSrc);
    normalizePictureBoxes(webSrc);
    // A slot the converter could not fill degrades to the kern fallback rather
    // than killing the encode; together with the names refused by shape, those
    // are what `web-pictures-dropped` will count below.
    const unconverted = dropUnconvertedPictures(webSrc, pictures.included, input.limits);
    const droppedNames = [...pictures.refused, ...unconverted];
    const downsampled = webDownsampledPictures(webSrc, pictures.included);
    if (downsampled.length > 0) {
      // Shown, and readable, but not at the file's own resolution: a raster has
      // no vector form, so the view carries pixels and there is a budget.
      warnings.push({
        rule: "web-pictures-raster",
        message:
          `the reflow view carries ${downsampled.length} included image(s) as downsampled pixels ` +
          `(${downsampled.slice(0, 5).join(", ")}${downsampled.length > 5 ? ", …" : ""}): ` +
          `a raster has no vector form, so it is re-encoded at up to ${input.limits.paperWebRasterLongEdge} px ` +
          "on its long edge and embedded in the picture",
      });
    }

    // ── everything after compile + export is the shared engine ───────────
    return encodeAndSealWebBundle(input, reflowtex, webSrc, webOut, warnings, skip, {
      droppedPictureNames: droppedNames,
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
