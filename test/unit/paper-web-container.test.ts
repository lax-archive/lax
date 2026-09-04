// The trusted web deriver's container mechanics without any TeX or docker
// (paper-web-plan.md stage 3), through the standard fake-runner seam: the
// pinned TeX image verified before anything runs in it, the compile's exact
// invocation shape (-shell-escape here and never on the PDF compile, the two
// mounts and nothing of Lean, the runner-owned PATH), the bounded export
// step (fonts by name, pictures pre-converted in-image), the encode child
// driven with `--fonts` and its dvisvgm seam pinned shut, and the shared
// stage-2 tail sealing a real bundle. The real container path is the docker
// smoke (test/smoke/submission-validation.ts, `paper-web` fixture).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type ValidationLimits } from "../../src/submission-validation/config.js";
import type { StaticPaper } from "../../src/submission-validation/contracts.js";
import { latexmkArguments } from "../../src/submission-validation/paper/compile.js";
import { PAPER_CONTAINER_PATHS } from "../../src/submission-validation/paper/container.js";
import {
  containerWebDeriver,
  encodingFile,
  normalizePictureBoxes,
  outlineEncoding,
  parseEncoding,
  pictureAtOrigin,
  resolveVirtualFonts,
  sharedSlots,
  assignIncludedPictureSlots,
  dropUnconvertedPictures,
  webConvertScript,
  webDownsampledPictures,
  webExportProblem,
  webExportScript,
  WEB_EXPORT_CONVERTER,
  WEB_EXPORT_DOWNSAMPLED_SUFFIX,
  WEB_EXPORT_FONT_LIST,
  WEB_EXPORT_FONTS_DIR,
  WEB_EXPORT_PFB_LIST,
  WEB_EXPORT_PICTURE_LIST,
  WEB_EXPORT_SCRIPT,
  WEB_INCLUDED_SLOT_PREFIX,
  WEB_PYMUPDF_PATH,
} from "../../src/submission-validation/paper/web-container.js";
import {
  webFontFilenames,
  webLatexmkArguments,
  webLegacyFontNames,
  type WebDeriveInput,
} from "../../src/submission-validation/paper/web.js";
import { PAPER_IMAGE, PAPER_IMAGE_DIGEST, REFLOWTEX_REV } from "../../src/submission-validation/pins.js";
import type {
  ContainerInvocation,
  ContainerResult,
  ValidationRunner,
} from "../../src/submission-validation/sandbox/container.js";
import { tmpDir } from "../support/host.js";

const FONT = "lmroman10-regular.otf";
const FONT_BYTES = Buffer.from("OTTO not really a font, but bytes served verbatim");
const SCHEMA = Buffer.from('syntax = "proto2";\npackage latex;\n');

// ── a real minimal PDF so the shared oracle genuinely runs ─────────────────

function minimalPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// ── a fake fetched fork: probe-satisfying files plus an executable encode
//    child that honors the encode_web.py contract ─────────────────────────

function fakeReflowtex(): string {
  const root = path.join(tmpDir("lax-web-container-fork-"), "reflowtex");
  const write = (relative: string, content: Buffer | string, mode = 0o644): void => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode });
  };
  write("checkout/src/extract/serializer.lua", "-- fake serializer\n");
  // The picture converter's library, which the probe requires as a directory
  // and the export step mounts read-only (pins.ts, PYMUPDF_*).
  write("pymupdf/lib/pymupdf/__init__.py", "# fake pymupdf\n");
  write("checkout/src/schema/latex.proto", SCHEMA);
  write("checkout/build/latex_pb2.py", "# generated\n");
  write("encode_web.py", "# consumed by the fake venv python below\n");
  // The fake encode child: parses --out/--fonts, records its argv and the
  // dvisvgm seam, copies the exported fonts through, and emits a stream
  // whose text matches the minimal PDF so the shared oracle passes.
  write(
    "venv/bin/python",
    `#!/bin/sh
out=""; fonts=""; job=""; prev=""
for a in "$@"; do
  case "$prev" in
    --out) out="$a";;
    --fonts) fonts="$a";;
    --job) job="$a";;
  esac
  prev="$a"
done
unref='[]'
if [ -n "$job" ] && [ -f "$job/fake-unreferenced.json" ]; then unref="$(cat "$job/fake-unreferenced.json")"; fi
dropped=0
if [ -n "$job" ] && [ -f "$job/fake-dropped.txt" ]; then dropped="$(cat "$job/fake-dropped.txt")"; fi
mkdir -p "$out/blocks" "$out/fonts"
printf '%s\\n' "$@" > "$out/argv.txt"
printf '%s' "\${REFLOWTEX_DVISVGM-unset}" > "$out/dvisvgm-seam.txt"
printf '%s' "\${REFLOWTEX_PFB_DIR-unset}" > "$out/pfb-seam.txt"
if [ -n "$fonts" ] && [ -d "$fonts" ]; then cp "$fonts"/* "$out/fonts/" 2>/dev/null || true; fi
printf 'PB' > "$out/blocks/000.pb"
printf '%s' '{"markers":[],"text":"Hello web world","unreferenced":'"$unref"'}' > "$out/stream.json"
printf '%s' '{"pbBytes":2,"droppedPictures":'"$dropped"',"fonts":{"${FONT}":"${FONT}"}}' > "$out/encode.json"
exit 0
`,
    0o755,
  );
  return root;
}

// ── the paper fixture and the deriver input ────────────────────────────────

function webInput(limits: ValidationLimits = DEFAULT_LIMITS): WebDeriveInput {
  const submissionRoot = tmpDir("lax-web-container-sub-");
  fs.mkdirSync(path.join(submissionRoot, "paper"), { recursive: true });
  const paper: StaticPaper = {
    manifest: { folder: "paper", main: "main.tex", engine: "pdflatex" },
    files: ["main.tex"],
    texFiles: ["main.tex"],
    rewritten: new Map([["main.tex", "\\documentclass{article}\\begin{document}x\\end{document}\n"]]),
    marks: [],
  };
  const jobDir = tmpDir("lax-web-container-job-");
  const pdfPath = path.join(jobDir, "main.pdf");
  fs.writeFileSync(pdfPath, minimalPdf("Hello web world"));
  return { paper, submissionRoot, jobDir, sourceDateEpoch: 1_700_000_000, limits, pdfPath };
}

interface FakeRunnerOptions {
  /** Written into the web copy by the compile container. */
  outputJson?: string;
  log?: string;
  compileResult?: Partial<ContainerResult>;
  exportResult?: Partial<ContainerResult>;
  /** Which requested fonts the export step resolves (default: all). */
  resolveFonts?: (name: string) => boolean;
  /** Unreferenced paragraph texts the fake encode child reports beside
   * its "Hello web world" stream. */
  unreferenced?: string[];
  /** Picture stems the fake export leaves converted, each with an
   * EPS-style (origin-off) SVG beside its PDF. */
  pictures?: string[];
  /** Slots (`pics/lax-inc<N>`) the fake export refuses to convert. */
  unconvertible?: string[];
  /** Slots the fake export had to downsample to the long-edge cap. */
  downsampled?: string[];
  /** What the fake encode child reports as unsourced picture nodes. */
  droppedPictures?: number;
  /** Symlinks the compile leaves in the web copy, by their name in it and
   * the absolute path each points at — the reach a `-shell-escape` run has
   * over every name the host writes to, reads, or reaches through after it.
   * Whatever stands at the name is removed first, exactly as the shell of
   * such a compile would (`rm -rf pics && ln -s elsewhere pics`). */
  plantedSymlinks?: Record<string, string>;
}

function fakeRunner(options: FakeRunnerOptions = {}): ValidationRunner & { calls: Array<string | ContainerInvocation> } {
  const calls: Array<string | ContainerInvocation> = [];
  return {
    calls,
    async verifyRuntime(): Promise<void> {
      calls.push("verify-runtime");
    },
    async verifyImage(image): Promise<void> {
      calls.push(`verify-image ${image.image} ${image.imageDigest}`);
    },
    async run(invocation: ContainerInvocation): Promise<ContainerResult> {
      calls.push(invocation);
      const webSrc = invocation.mounts?.[0]?.source;
      if (webSrc === undefined) throw new Error("web container invocation has no work mount");
      if (invocation.label === "paper-web-compile") {
        fs.writeFileSync(
          path.join(webSrc, "output.json"),
          options.outputJson ??
            JSON.stringify({
              fonts: {
                "1": { name: "lmroman10", size_sp: 655360, filename: FONT },
                "2": { name: "cmmi10", size_sp: 655360, filename: "unknown" },
              },
              paragraphs: [],
              content: [],
            }),
        );
        fs.writeFileSync(path.join(webSrc, "main.log"), options.log ?? "This is LuaHBTeX\nOutput written on main.pdf\n");
        if (options.unreferenced !== undefined) {
          fs.writeFileSync(
            path.join(webSrc, "fake-unreferenced.json"),
            JSON.stringify(options.unreferenced.map((text) => ({ text, markers: [] }))),
          );
        }
        if (options.droppedPictures !== undefined) {
          fs.writeFileSync(path.join(webSrc, "fake-dropped.txt"), String(options.droppedPictures));
        }
        for (const [name, target] of Object.entries(options.plantedSymlinks ?? {})) {
          fs.rmSync(path.join(webSrc, name), { recursive: true, force: true });
          fs.symlinkSync(target, path.join(webSrc, name));
        }
        return { code: 0, output: "latexmk web transcript", timedOut: false, ...options.compileResult };
      }
      if (invocation.label === "paper-web-export") {
        const requested = fs
          .readFileSync(path.join(webSrc, WEB_EXPORT_FONT_LIST), "utf8")
          .split("\n")
          .filter((name) => name !== "");
        fs.mkdirSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR), { recursive: true });
        for (const name of requested) {
          if (options.resolveFonts?.(name) === false) continue;
          fs.writeFileSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR, name), FONT_BYTES);
        }
        fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
        for (const name of options.pictures ?? []) {
          fs.writeFileSync(path.join(webSrc, "pics", `${name}.pdf`), "%PDF");
          fs.writeFileSync(
            path.join(webSrc, "pics", `${name}.svg`),
            "<svg version='1.1' viewBox='0 -18 74 18'><g id='page1'/></svg>",
          );
        }
        // The listed \includegraphics files, by the slot the host assigned.
        const listed = JSON.parse(
          fs.readFileSync(path.join(webSrc, WEB_EXPORT_PICTURE_LIST), "utf8"),
        ) as Array<{ slot: string; file: string }>;
        for (const picture of listed) {
          if (options.unconvertible?.includes(picture.slot) === true) continue;
          fs.writeFileSync(
            path.join(webSrc, `${picture.slot}.svg`),
            "<svg version='1.1' viewBox=\"0 0 74 18\"><g id='page1'/></svg>",
          );
          if (options.downsampled?.includes(picture.slot) === true) {
            fs.writeFileSync(path.join(webSrc, `${picture.slot}.${WEB_EXPORT_DOWNSAMPLED_SUFFIX}`), "");
          }
        }
        return { code: 0, output: "", timedOut: false, ...options.exportResult };
      }
      throw new Error(`unexpected container invocation ${invocation.label}`);
    },
  };
}

function derive(runnerOptions: FakeRunnerOptions = {}, limits?: ValidationLimits) {
  const runner = fakeRunner(runnerOptions);
  const styDir = tmpDir("lax-web-container-sty-");
  const reflowtexRoot = fakeReflowtex();
  const input = webInput(limits);
  const deriver = containerWebDeriver(runner, { reflowtexRoot, styDir });
  return { runner, styDir, reflowtexRoot, input, run: () => deriver(input) };
}

describe("container web deriver", () => {
  it("verifies the pinned TeX image, compiles with -shell-escape on the fresh copy, exports, and seals the bundle", async () => {
    const { runner, styDir, reflowtexRoot, input, run } = derive();
    const derived = await run();

    expect(derived.warnings).toEqual([]);
    const webSrc = path.join(input.jobDir, "paper", "web", "src");

    // The image is verified by its own pin before anything runs in it.
    expect(runner.calls[0]).toBe(`verify-image ${PAPER_IMAGE} ${PAPER_IMAGE_DIGEST}`);

    // The compile: the injected lualatex command in the TeX image, on the
    // web copy and the marker-package directory — nothing else mounted, no
    // Lean anywhere, and no PATH of its own (the runner owns PATH; a
    // foreign image keeps its baked one).
    const compile = runner.calls[1] as ContainerInvocation;
    expect(compile.label).toBe("paper-web-compile");
    expect(compile.image).toEqual({ image: PAPER_IMAGE, imageDigest: PAPER_IMAGE_DIGEST });
    expect(compile.args).toEqual(["latexmk", ...webLatexmkArguments("main.tex")]);
    expect(compile.args).toContain("-shell-escape");
    expect(compile.mounts).toEqual([
      { source: webSrc, target: PAPER_CONTAINER_PATHS.work, writable: true },
      { source: styDir, target: PAPER_CONTAINER_PATHS.tex },
    ]);
    expect(compile.workdir).toBe(PAPER_CONTAINER_PATHS.work);
    expect(compile.env).toEqual({
      TEXINPUTS: `${PAPER_CONTAINER_PATHS.work}:${PAPER_CONTAINER_PATHS.tex}:`,
      SOURCE_DATE_EPOCH: "1700000000",
      FORCE_SOURCE_DATE: "1",
      HOME: "/tmp",
    });
    expect(compile.env).not.toHaveProperty("PATH");
    expect(compile.network).toBeUndefined();
    expect(compile.timeoutMs).toBe(DEFAULT_LIMITS.paperCompileTimeoutMs);
    // The deviation is one-sided: the PDF compile never gets -shell-escape.
    expect(latexmkArguments("pdflatex", "main.tex")).not.toContain("-shell-escape");
    expect(latexmkArguments("lualatex", "main.tex")).not.toContain("-shell-escape");

    // The export step: same image, only the web copy mounted, the script
    // written by the host after the compile exited.
    const exported = runner.calls[2] as ContainerInvocation;
    expect(exported.label).toBe("paper-web-export");
    expect(exported.image).toEqual({ image: PAPER_IMAGE, imageDigest: PAPER_IMAGE_DIGEST });
    expect(exported.args).toEqual(["sh", `${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_SCRIPT}`]);
    // The converter's library rides in read-only and alone on PYTHONPATH;
    // the work copy is the only writable thing in the container.
    expect(exported.mounts).toEqual([
      { source: webSrc, target: PAPER_CONTAINER_PATHS.work, writable: true },
      { source: path.join(reflowtexRoot, "pymupdf", "lib"), target: WEB_PYMUPDF_PATH },
    ]);
    expect(exported.env).toEqual({ HOME: "/tmp", PYTHONPATH: WEB_PYMUPDF_PATH });
    expect(exported.timeoutMs).toBe(DEFAULT_LIMITS.paperWebExportTimeoutMs);
    expect(fs.readFileSync(path.join(webSrc, WEB_EXPORT_FONT_LIST), "utf8")).toBe(`${FONT}\n`);
    // The legacy face's Type1 outline is requested by TeX name.
    expect(fs.readFileSync(path.join(webSrc, "lax-web-pfbs.txt"), "utf8")).toBe("cmmi10\n");
    expect(runner.calls).toHaveLength(3);

    // The fresh copy carries the serializer and the pre-created pics/.
    expect(fs.existsSync(path.join(webSrc, "serializer.lua"))).toBe(true);
    expect(fs.statSync(path.join(webSrc, "pics")).isDirectory()).toBe(true);

    // The encode child ran host-side with the exported fonts injected and
    // the dvisvgm seam pinned shut (never a host binary on this path).
    const webOut = path.join(input.jobDir, "paper", "web", "out");
    expect(fs.readFileSync(path.join(webOut, "argv.txt"), "utf8")).toContain("--fonts");
    expect(fs.readFileSync(path.join(webOut, "argv.txt"), "utf8")).toContain(
      path.join(webSrc, WEB_EXPORT_FONTS_DIR),
    );
    expect(fs.readFileSync(path.join(webOut, "dvisvgm-seam.txt"), "utf8")).toBe("false");
    expect(fs.readFileSync(path.join(webOut, "pfb-seam.txt"), "utf8")).toBe(
      path.join(webSrc, WEB_EXPORT_FONTS_DIR),
    );

    // Stage 2's shared tail sealed a real bundle: recorded address matches
    // the bytes, the format pin is the fork rev + the schema text's digest.
    const web = derived.web!;
    expect(web.format).toEqual({
      tool: "reflowtex",
      rev: REFLOWTEX_REV,
      schema: createHash("sha256").update(SCHEMA).digest("hex"),
    });
    const tar = fs.readFileSync(web.bundlePath);
    expect(tar.length).toBe(web.bytes);
    expect(createHash("sha256").update(tar).digest("hex")).toBe(web.digest);
    expect(tar.includes(FONT_BYTES)).toBe(true); // the exported font was served
  });

  it("skips with web-toolchain when the fork is not fetched, before any container runs", async () => {
    const runner = fakeRunner();
    const deriver = containerWebDeriver(runner, {
      reflowtexRoot: path.join(tmpDir("lax-web-container-missing-"), "reflowtex"),
      styDir: tmpDir("lax-web-container-sty-"),
    });
    const derived = await deriver(webInput());
    expect(derived.web).toBeUndefined();
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]!.rule).toBe("web-toolchain");
    expect(derived.warnings[0]!.message).toContain("npm run reflowtex:fetch");
    expect(runner.calls).toEqual([]);
  });

  it("turns a repaired compile (a `! ` log line) into a web-compile skip without exporting", async () => {
    const { runner, run } = derive({ log: "! Undefined control sequence.\nl.3 \\laxmork\n" });
    const derived = await run();
    expect(derived.web).toBeUndefined();
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]!.rule).toBe("web-compile");
    expect(derived.warnings[0]!.message).toContain("silently wrong");
    expect(derived.warnings[0]!.message).not.toMatch(/[\r\n]/u); // the report schema's one-line rule
    expect(runner.calls.filter((call) => typeof call !== "string")).toHaveLength(1); // compile only
  });

  it("names a font the TeX image could not resolve and skips before the encode child", async () => {
    const { input, run } = derive({ resolveFonts: () => false });
    const derived = await run();
    expect(derived.web).toBeUndefined();
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]!.rule).toBe("web-font-export");
    expect(derived.warnings[0]!.message).toContain(FONT);
    expect(fs.existsSync(path.join(input.jobDir, "paper", "web", "out", "argv.txt"))).toBe(false);
  });

  it("reports an unreferenced capture only when the stream does not carry its words", async () => {
    // \caption measures every caption in a box first and classes measure
    // a paragraph's first word the same way: those captures are trial
    // typesettings the surface shows anyway — no warning, and nothing
    // subtracted from the PDF side. A \marginpar's text is a real
    // omission: named, and removed from the PDF tokens (the minimal PDF
    // here does not carry it, so the removal is a no-op).
    const trial = await derive({ unreferenced: ["web", "Hello web", "Wo"] }).run();
    expect(trial.web).toBeDefined();
    expect(trial.warnings.map((warning) => warning.rule)).not.toContain("web-unreferenced-paragraph");

    const omission = await derive({ unreferenced: ["a margin note", "web"] }).run();
    expect(omission.web).toBeDefined();
    const rules = omission.warnings.filter((warning) => warning.rule === "web-unreferenced-paragraph");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.message).toContain('"a margin note"');
  });

  it("squares every converted picture's box before the encode reads it", async () => {
    const { input, run } = derive({ pictures: ["fig0", "fig1"] });
    const derived = await run();

    expect(derived.web).toBeDefined();
    expect(derived.warnings).toEqual([]);
    const pics = path.join(input.jobDir, "paper", "web", "src", "pics");
    for (const name of ["fig0", "fig1"]) {
      expect(fs.readFileSync(path.join(pics, `${name}.svg`), "utf8")).toContain("viewBox='0 0 74 18'");
    }
  });

  // ── plain \includegraphics: slots, validation, accounting ────────────────

  /** A serialized stream carrying one picture node per `file` value, plus a
   * nested one so the walk is exercised at depth. */
  function streamWithPictures(files: Array<string | undefined>): string {
    const picture = (file: string | undefined) => ({
      type: "picture",
      width: 100,
      height: 100,
      depth: 0,
      ...(file === undefined ? {} : { file }),
    });
    return JSON.stringify({
      // The same font table the default stream carries, so the fake encode's
      // font map still names something the export served.
      fonts: { "1": { name: "lmroman10", size_sp: 655360, filename: FONT } },
      paragraphs: [{ nodes: files.slice(0, 1).map(picture) }],
      content: [
        {
          box: {
            children: [
              { type: "hlist", children: files.slice(1).map(picture) },
            ],
          },
        },
      ],
    });
  }

  function pictureFiles(webSrc: string): Array<string | undefined> {
    const data = JSON.parse(fs.readFileSync(path.join(webSrc, "output.json"), "utf8")) as {
      paragraphs: Array<{ nodes: Array<{ file?: string }> }>;
      content: Array<{ box: { children: Array<{ children: Array<{ file?: string }> }> } }>;
    };
    return [
      ...data.paragraphs.flatMap((paragraph) => paragraph.nodes.map((node) => node.file)),
      ...data.content.flatMap((item) => item.box.children.flatMap((child) => child.children.map((node) => node.file))),
    ];
  }

  it("gives every acceptable included graphic a slot, refuses the rest, and never repeats a file", () => {
    const webSrc = tmpDir("lax-web-slots-");
    fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
    // A tikz externalization stem: written by the compile, PDF beside it.
    fs.writeFileSync(path.join(webSrc, "pics", "main-figure0.pdf"), "%PDF");
    fs.writeFileSync(
      path.join(webSrc, "output.json"),
      streamWithPictures([
        "pics/main-figure0", // tikz: left alone
        "orcid.pdf", // slot 0
        "figures/plot.PNG", // slot 1 (extension case is TeX's, not ours)
        "/usr/local/texlive/2025/texmf-dist/doc/logo.pdf", // slot 2: kpsewhich's absolute form
        "orcid.pdf", // the same file again: the same slot, listed once
        undefined, // never stamped at all: already a kern candidate
      ]),
    );

    const assigned = assignIncludedPictureSlots(webSrc, DEFAULT_LIMITS);
    expect(assigned.refused).toEqual([]);
    expect(assigned.included).toEqual([
      { slot: `${WEB_INCLUDED_SLOT_PREFIX}0`, file: "orcid.pdf" },
      { slot: `${WEB_INCLUDED_SLOT_PREFIX}1`, file: "figures/plot.PNG" },
      { slot: `${WEB_INCLUDED_SLOT_PREFIX}2`, file: "/usr/local/texlive/2025/texmf-dist/doc/logo.pdf" },
    ]);
    // The author's own paths never reach the encode: only slots do.
    expect(pictureFiles(webSrc)).toEqual([
      "pics/main-figure0",
      `${WEB_INCLUDED_SLOT_PREFIX}0`,
      `${WEB_INCLUDED_SLOT_PREFIX}1`,
      `${WEB_INCLUDED_SLOT_PREFIX}2`,
      `${WEB_INCLUDED_SLOT_PREFIX}0`,
      undefined,
    ]);
  });

  it("refuses an included graphic by name shape, extension, or count, leaving it a kern", () => {
    const refusable = [
      "../../etc/passwd.pdf", // traversal
      "a/../b.pdf", // traversal, mid-path
      "figure.svg", // not in the extension allowlist
      "figure.pdf.exe", // nor is the last extension
      "logo", // no extension at all
      "with space.png", // not a plain name
      "$(id).png", // shell metacharacters
      "fig\nure.pdf", // a newline in the name
      "-rf.png", // a leading dash could be an option somewhere
      `${"deep/".repeat(9)}x.pdf`, // deeper than the segment cap
      `${"x".repeat(200)}.pdf`, // longer than one segment allows
    ];
    const webSrc = tmpDir("lax-web-slots-refused-");
    fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
    fs.writeFileSync(path.join(webSrc, "output.json"), streamWithPictures(refusable));

    const assigned = assignIncludedPictureSlots(webSrc, DEFAULT_LIMITS);
    expect(assigned.included).toEqual([]);
    expect(assigned.refused).toEqual([...refusable].sort());
    // Every one of them lost its file: the fork's kern fallback takes over.
    expect(pictureFiles(webSrc).filter((file) => file !== undefined)).toEqual([]);

    // The count cap refuses the surplus rather than the whole derivation.
    const capped = tmpDir("lax-web-slots-cap-");
    fs.writeFileSync(path.join(capped, "output.json"), streamWithPictures(["a.pdf", "b.pdf", "c.pdf"]));
    const bounded = assignIncludedPictureSlots(capped, { ...DEFAULT_LIMITS, paperWebIncludedPictures: 2 });
    expect(bounded.included.map((picture) => picture.file)).toEqual(["a.pdf", "b.pdf"]);
    expect(bounded.refused).toEqual(["c.pdf"]);
  });

  it("drops a slot the export could not convert and names the raster ones it downsampled", () => {
    const webSrc = tmpDir("lax-web-slots-convert-");
    fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
    fs.writeFileSync(path.join(webSrc, "output.json"), streamWithPictures(["orcid.pdf", "photo.jpg"]));
    const assigned = assignIncludedPictureSlots(webSrc, DEFAULT_LIMITS);
    expect(assigned.included).toHaveLength(2);

    // Only the second slot came back converted, and it had to be downsampled.
    fs.writeFileSync(path.join(webSrc, `${WEB_INCLUDED_SLOT_PREFIX}1.svg`), "<svg/>");
    fs.writeFileSync(path.join(webSrc, `${WEB_INCLUDED_SLOT_PREFIX}1.${WEB_EXPORT_DOWNSAMPLED_SUFFIX}`), "");

    expect(dropUnconvertedPictures(webSrc, assigned.included, DEFAULT_LIMITS)).toEqual(["orcid.pdf"]);
    expect(pictureFiles(webSrc)).toEqual([undefined, `${WEB_INCLUDED_SLOT_PREFIX}1`]);
    expect(webDownsampledPictures(webSrc, assigned.included)).toEqual(["photo.jpg"]);
  });

  it("shows an included graphic, and names the ones it could not, through the whole deriver", async () => {
    const stream = streamWithPictures(["orcid.pdf", "photo.png", "cover.svg"]);
    const shown = await derive({ outputJson: stream, downsampled: [`${WEB_INCLUDED_SLOT_PREFIX}1`] }).run();
    expect(shown.web).toBeDefined();
    // The raster is carried, at a bounded resolution, and said so.
    const raster = shown.warnings.filter((warning) => warning.rule === "web-pictures-raster");
    expect(raster).toHaveLength(1);
    expect(raster[0]!.message).toContain("photo.png");
    expect(raster[0]!.message).not.toMatch(/[\r\n]/u); // the report schema's one-line rule
    // `cover.svg` is not a format the converter reads, so it stays a kern —
    // and the fake encode reports no unsourced picture, so nothing else fires.
    expect(shown.warnings.map((warning) => warning.rule)).toEqual(["web-pictures-raster"]);

    // A slot the export cannot fill degrades the same way, by name.
    const missing = await derive({
      outputJson: stream,
      unconvertible: [`${WEB_INCLUDED_SLOT_PREFIX}0`],
      droppedPictures: 2,
    }).run();
    expect(missing.web).toBeDefined();
    const dropped = missing.warnings.filter((warning) => warning.rule === "web-pictures-dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.message).toContain("cover.svg");
    expect(dropped[0]!.message).toContain("orcid.pdf");
    expect(dropped[0]!.message).toContain("2 included graphic(s)");
  });

  it("writes the converter with the caps baked in and never names an author's file to it", () => {
    const script = webConvertScript(DEFAULT_LIMITS);
    expect(script).toContain("import pymupdf");
    expect(script).toContain("get_svg_image(text_as_path=True)");
    expect(script).toContain(`MAX_SVG_BYTES = ${DEFAULT_LIMITS.paperWebPictureBytes}`);
    expect(script).toContain(`RASTER_LONG_EDGE = ${DEFAULT_LIMITS.paperWebRasterLongEdge}`);
    // One page only, and every resolved path checked against the roots.
    expect(script).toContain("expected exactly 1");
    expect(script).toContain("def contained(path):");
    expect(script).toContain("kpsewhich");
    // The file names live in the list the host writes, never in the script.
    expect(script).toContain(WEB_EXPORT_PICTURE_LIST);
  });

  it("skips over the export caps: too many font files before the run, too many bytes after it", async () => {
    const tightFiles = { ...DEFAULT_LIMITS, paperWebExportFiles: 0 };
    const first = derive({}, tightFiles);
    const overCount = await first.run();
    expect(overCount.web).toBeUndefined();
    expect(overCount.warnings[0]!.rule).toBe("web-export-cap");
    expect(first.runner.calls.filter((call) => typeof call !== "string")).toHaveLength(1); // no export run

    const tightBytes = { ...DEFAULT_LIMITS, paperWebExportBytes: 8 };
    const second = derive({}, tightBytes);
    const overBytes = await second.run();
    expect(overBytes.web).toBeUndefined();
    expect(overBytes.warnings[0]!.rule).toBe("web-export-cap");
    expect(overBytes.warnings[0]!.message).toContain("MiB cap");
  });

  it("reports a failed export container as its own skip", async () => {
    const { run } = derive({ exportResult: { code: 3 } });
    const derived = await run();
    expect(derived.web).toBeUndefined();
    expect(derived.warnings[0]!.rule).toBe("web-export");
    expect(derived.warnings[0]!.message).toContain("exit 3");
  });

  it("writes the export step's files past symlinks the compile planted at their names", async () => {
    // The compile runs untrusted with -shell-escape and owns the copy the
    // host writes the export step into afterwards, so it can leave a symlink
    // at each of those names pointing anywhere the job can reach. Following
    // one would put host-written bytes — a shell script among them — outside
    // the copy, on the runner.
    const outside = tmpDir("lax-web-container-outside-");
    const names = [
      WEB_EXPORT_SCRIPT,
      WEB_EXPORT_CONVERTER,
      WEB_EXPORT_FONT_LIST,
      WEB_EXPORT_PFB_LIST,
      WEB_EXPORT_PICTURE_LIST,
    ];
    for (const name of names) fs.writeFileSync(path.join(outside, name), "the runner's own file\n");
    const { input, run } = derive({
      plantedSymlinks: Object.fromEntries(names.map((name) => [name, path.join(outside, name)])),
    });
    const derived = await run();

    // The derivation is untouched by the attempt: the export step reads the
    // files it was given, in the copy, and the bundle seals as ever.
    expect(derived.web).toBeDefined();
    expect(derived.warnings).toEqual([]);
    const webSrc = path.join(input.jobDir, "paper", "web", "src");
    for (const name of names) {
      expect(fs.readFileSync(path.join(outside, name), "utf8")).toBe("the runner's own file\n");
      expect(fs.lstatSync(path.join(webSrc, name)).isSymbolicLink()).toBe(false);
    }
    expect(fs.readFileSync(path.join(webSrc, WEB_EXPORT_SCRIPT), "utf8")).toBe(webExportScript());
    expect(fs.lstatSync(path.join(webSrc, WEB_EXPORT_SCRIPT)).mode & 0o777).toBe(0o600);
  });

  it("settles the pictures directory before reaching through it, link or no link", async () => {
    // `pics` is reached *through* rather than written to: the slot pre-clear,
    // the export accounting, the box normalization and the encode all spell
    // out `pics/<something>`. A compile that swaps the directory for a link
    // (`rm -rf pics && ln -s elsewhere pics`) redirects every one of those at
    // once — which taking the link off the leaf of each path cannot undo.
    const outside = tmpDir("lax-web-container-pics-outside-");
    // Two of the runner's own files, at names the host reaches for under
    // `pics/`: a picture whose off-origin box the normalization rewrites in
    // place, and the marker a slot's pre-clear deletes before the export.
    const drawing = path.join(outside, "figure.svg");
    const marker = path.join(outside, `lax-inc0.${WEB_EXPORT_DOWNSAMPLED_SUFFIX}`);
    fs.writeFileSync(drawing, "<svg version='1.1' viewBox='0 -18 74 18'><g id='page1'/></svg>");
    fs.writeFileSync(marker, "");
    const { input, run } = derive({
      outputJson: streamWithPictures(["orcid.pdf"]),
      pictures: ["fig0"],
      plantedSymlinks: { pics: outside },
    });
    const derived = await run();

    // Neither was rewritten or deleted, nothing else landed beside them, and
    // the copy holds a real directory at the name again.
    expect(fs.readFileSync(drawing, "utf8")).toContain("viewBox='0 -18 74 18'");
    expect(fs.readdirSync(outside).sort()).toEqual([
      "figure.svg",
      `lax-inc0.${WEB_EXPORT_DOWNSAMPLED_SUFFIX}`,
    ]);
    const webSrc = path.join(input.jobDir, "paper", "web", "src");
    expect(fs.lstatSync(path.join(webSrc, "pics")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(webSrc, "pics")).isDirectory()).toBe(true);

    // And the derivation carries on in it: the export fills the settled
    // directory, the boxes are squared there, and the bundle seals. What the
    // compile externalized into the directory it unlinked went with it, which
    // is the kern fallback and nothing worse.
    expect(derived.web).toBeDefined();
    expect(derived.warnings).toEqual([]);
    expect(fs.readFileSync(path.join(webSrc, "pics", "fig0.svg"), "utf8")).toContain("viewBox='0 0 74 18'");
    expect(pictureFiles(webSrc)).toEqual([`${WEB_INCLUDED_SLOT_PREFIX}0`]);
  });
});

describe("export helpers", () => {
  it("extracts only plain otf/ttf basenames from the untrusted font table", () => {
    const webSrc = tmpDir("lax-web-fontnames-");
    fs.writeFileSync(
      path.join(webSrc, "output.json"),
      JSON.stringify({
        fonts: {
          "1": { filename: "lmroman10-regular.otf" },
          "2": { filename: "unknown" }, // legacy 8-bit face: no file to resolve
          "3": { filename: "../../etc/passwd.otf" }, // traversal shapes never leave the host
          "4": { filename: "evil name.otf" },
          "5": { filename: "LatinModern-Math.otf" },
          "6": { filename: "lmroman10-regular.otf" }, // deduplicated
          "7": {},
        },
        paragraphs: [],
        content: [],
      }),
    );
    expect(webFontFilenames(webSrc, DEFAULT_LIMITS)).toEqual([
      "LatinModern-Math.otf",
      "lmroman10-regular.otf",
    ]);
  });

  it("extracts legacy Type1 face names only from unknown-filename entries, validated", () => {
    const webSrc = tmpDir("lax-web-legacynames-");
    fs.writeFileSync(
      path.join(webSrc, "output.json"),
      JSON.stringify({
        fonts: {
          "1": { name: "lmroman10", filename: "lmroman10-regular.otf" }, // a real file: not legacy
          "2": { name: "cmmi10", filename: "unknown" },
          "3": { name: "cmsy10", filename: "unknown" },
          "4": { name: "unknown", filename: "unknown" }, // nothing to resolve
          "5": { name: "evil name; rm -rf /", filename: "unknown" }, // never leaves the host
          "6": { name: "../cmr10", filename: "unknown" },
          "7": { name: "cmmi10", filename: "unknown" }, // deduplicated
        },
        paragraphs: [],
        content: [],
      }),
    );
    expect(webLegacyFontNames(webSrc, DEFAULT_LIMITS)).toEqual(["cmmi10", "cmsy10"]);
  });

  it("keeps the export script on the fork's dvisvgm contract, with the map-resolved pfb leg", () => {
    const script = webExportScript();
    expect(script).toContain("kpsewhich");
    // A legacy face resolves through its pdftex.map line — outline plus,
    // for a re-encoded face, the encoding vector, both exported under the
    // TeX name (the fork's REFLOWTEX_PFB_DIR contract) — and a name with
    // no map line falls back to `<name>.pfb` as stock.
    expect(script).toContain("kpsewhich pdftex.map");
    expect(script).toContain("'$1 == n { print; exit }'");
    expect(script).toContain('*.enc) enc="$f"');
    expect(script).toContain('[ -n "$pfb" ] || pfb="$name.pfb"');
    expect(script).toContain(`'${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_FONTS_DIR}/'"$name.enc"`);
    expect(script).toContain(`'${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_FONTS_DIR}/'"$name.pfb"`);
    // The vector is copied before the outline: a re-encoded face whose
    // vector does not resolve exports neither file.
    expect(script.indexOf('cp -- "$esrc"')).toBeLessThan(script.lastIndexOf('cp -- "$src"'));
    // Picture conversion is the mounted PyMuPDF and nothing else: the
    // Ghostscript → EPS → dvisvgm chain that preceded it flattened every
    // transparent drawing (lax-65's two figures both arrived blank), and it
    // is gone rather than kept as a fallback.
    expect(script).toContain(`python3 '${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_CONVERTER}'`);
    for (const retired of ["dvisvgm", "eps2write", "NOTRANSPARENCY", "mktemp"]) {
      expect(script).not.toContain(retired);
    }
    // A face pdftex.map does not name may be virtual: it is followed to the
    // base font it draws from, whose outline is exported under the virtual
    // name with the program and the base's vector beside it for the host.
    expect(script).toContain("vftovp");
    expect(script).toContain('kpsewhich "$name.vf"');
    expect(script).toContain("(MAPFONT D 0");
    expect(script).toContain("8a.enc");
    expect(script).toContain("t1disasm");
    expect(script).toContain(`${PAPER_CONTAINER_PATHS.work}/${WEB_EXPORT_FONTS_DIR}`);
  });

  it("bounds the export set over fonts and converted pictures together", () => {
    const webSrc = tmpDir("lax-web-export-bounds-");
    fs.mkdirSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR), { recursive: true });
    fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
    fs.writeFileSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR, FONT), FONT_BYTES);
    fs.writeFileSync(path.join(webSrc, "pics", "fig0.svg"), "<svg/>");
    fs.writeFileSync(path.join(webSrc, "pics", "fig0.pdf"), "%PDF"); // not part of the bounded set

    expect(webExportProblem(webSrc, [FONT], DEFAULT_LIMITS)).toBeUndefined();
    expect(webExportProblem(webSrc, [FONT], { ...DEFAULT_LIMITS, paperWebExportFiles: 1 })?.rule).toBe(
      "web-export-cap",
    );
    expect(webExportProblem(webSrc, [FONT], { ...DEFAULT_LIMITS, paperWebExportBytes: 4 })?.rule).toBe(
      "web-export-cap",
    );
    expect(webExportProblem(webSrc, [FONT, "missing.otf"], DEFAULT_LIMITS)?.rule).toBe("web-font-export");
  });

  it("keeps only the slots a virtual font shares with the outline it is drawn from", () => {
    // vftovp's text form, in the shape BOONDOX-r-cal has: letters drawn from
    // the base font at their own code (a move for the side bearing), digits
    // borrowed from a second mapped font, and a slot remapped to another
    // code — which no base-font glyph may answer.
    const vpl = `(VTITLE test)
(MAPFONT D 0
   (FONTNAME zxxrw7z)
   )
(MAPFONT D 1
   (FONTNAME cmr10)
   )
(CHARACTER C P
   (CHARWD R 0.88)
   (MAP
      (SETCHAR C P)
      (MOVERIGHT R -0.03)
      )
   )
(CHARACTER C Q
   (CHARWD R 0.88)
   (MAP
      (SETCHAR C Q)
      )
   )
(CHARACTER C 0
   (CHARWD R 0.5)
   (MAP
      (SELECTFONT D 1)
      (SETCHAR C 0)
      )
   )
(CHARACTER O 100
   (CHARWD R 0.5)
   (MAP
      (SETCHAR C Z)
      )
   )
`;
    const shared = sharedSlots(vpl);
    expect([...shared].sort((a, b) => a - b)).toEqual(["P".codePointAt(0), "Q".codePointAt(0)]);
    expect(shared.has("0".codePointAt(0)!)).toBe(false); // borrowed from cmr10
    expect(shared.has(0o100)).toBe(false); // drawn at another code

    const names = parseEncoding("% a vector\n/BaseEncoding [\n/.notdef /A\n] def\n")!;
    expect(names[0]).toBeUndefined();
    expect(names[1]).toBe("A");
    expect(parseEncoding("/NoArray def")).toBeUndefined();

    const enc = encodingFile("BOONDOX-r-cal", parseEncoding(`/Base [${Array.from({ length: 256 }, (_, slot) => `/g${slot}`).join(" ")}] def`)!, shared);
    expect(enc).toContain("/BOONDOX-r-cal [");
    expect(enc).toContain(`/g${"P".codePointAt(0)}`);
    expect(enc).not.toContain(`/g${"0".codePointAt(0)}`); // the borrowed slot stays a box
    expect(enc.match(/\/g\d+/gu)).toHaveLength(2);

    // A Type1 outline's own vector, when the export left no base one.
    const pfb = Buffer.from("%!PS\ndup 80 /P put\ndup 81 /.notdef put\neexec\ndup 82 /R put\n", "latin1");
    const own = outlineEncoding(pfb)!;
    expect(own[80]).toBe("P");
    expect(own[81]).toBeUndefined();
    expect(own[82]).toBeUndefined(); // past eexec: encrypted, not the vector
    expect(outlineEncoding(Buffer.from("%!PS\n/Encoding StandardEncoding def\n", "latin1"))).toBeUndefined();
  });

  it("finishes a virtual face the export followed, and refuses one it cannot read", () => {
    const webSrc = tmpDir("lax-web-vf-");
    const fonts = path.join(webSrc, WEB_EXPORT_FONTS_DIR);
    fs.mkdirSync(fonts, { recursive: true });
    const vpl = (body: string) => `(MAPFONT D 0\n   (FONTNAME base)\n   )\n${body}`;
    const character = `(CHARACTER C P\n   (CHARWD R 0.5)\n   (MAP\n      (SETCHAR C P)\n      )\n   )\n`;

    // Followed, with the base's own vector beside it: filtered and kept.
    fs.writeFileSync(path.join(fonts, "Good.vpl"), vpl(character));
    fs.writeFileSync(path.join(fonts, "Good.base-enc"), `/Base [${Array.from({ length: 256 }, (_, slot) => `/g${slot}`).join(" ")}] def`);
    fs.writeFileSync(path.join(fonts, "Good.pfb"), "%!PS");
    // No vector at all, and none in the outline: the outline goes rather
    // than address slots by guesswork.
    fs.writeFileSync(path.join(fonts, "Blind.vpl"), vpl(character));
    fs.writeFileSync(path.join(fonts, "Blind.pfb"), "%!PS\n/Encoding StandardEncoding def\n");
    // A program sharing nothing with its base is no better than no outline.
    fs.writeFileSync(path.join(fonts, "Alien.vpl"), vpl(`(CHARACTER C P\n   (CHARWD R 0.5)\n   (MAP\n      (SETCHAR C Z)\n      )\n   )\n`));
    fs.writeFileSync(path.join(fonts, "Alien.base-enc"), "/Base [/A] def");
    fs.writeFileSync(path.join(fonts, "Alien.pfb"), "%!PS");

    expect(resolveVirtualFonts(webSrc)).toEqual({ resolved: ["Good"], refused: ["Alien", "Blind"] });
    expect(fs.readFileSync(path.join(fonts, "Good.enc"), "utf8")).toContain(`/g${"P".codePointAt(0)}`);
    expect(fs.existsSync(path.join(fonts, "Good.pfb"))).toBe(true);
    expect(fs.existsSync(path.join(fonts, "Blind.pfb"))).toBe(false);
    expect(fs.existsSync(path.join(fonts, "Alien.pfb"))).toBe(false);
    // Neither the program nor the unfiltered vector belongs in the export set.
    expect(fs.readdirSync(fonts).filter((name) => /\.(?:vpl|base-enc)$/u.test(name))).toEqual([]);
    expect(resolveVirtualFonts(tmpDir("lax-web-vf-none-"))).toEqual({ resolved: [], refused: [] });
  });

  it("finishes a virtual face past a symlink standing at its encoding's name", () => {
    // Nothing plants one here today — the fonts directory is re-made empty
    // before the export step fills it inside the container — but the rule is
    // the write's, not the caller's knowledge of who made the entry: a host
    // write into the compile's copy never follows what it finds.
    const outside = path.join(tmpDir("lax-web-vf-outside-"), "elsewhere.enc");
    fs.writeFileSync(outside, "not the encoding\n");
    const webSrc = tmpDir("lax-web-vf-link-");
    const fonts = path.join(webSrc, WEB_EXPORT_FONTS_DIR);
    fs.mkdirSync(fonts, { recursive: true });
    fs.writeFileSync(
      path.join(fonts, "Good.vpl"),
      `(MAPFONT D 0\n   (FONTNAME base)\n   )\n(CHARACTER C P\n   (CHARWD R 0.5)\n   (MAP\n      (SETCHAR C P)\n      )\n   )\n`,
    );
    fs.writeFileSync(path.join(fonts, "Good.base-enc"), "/Base [/A] def");
    fs.writeFileSync(path.join(fonts, "Good.pfb"), "%!PS");
    fs.symlinkSync(outside, path.join(fonts, "Good.enc"));

    expect(resolveVirtualFonts(webSrc)).toEqual({ resolved: ["Good"], refused: [] });
    expect(fs.readFileSync(outside, "utf8")).toBe("not the encoding\n");
    expect(fs.lstatSync(path.join(fonts, "Good.enc")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(fonts, "Good.enc"), "utf8")).toContain("/Good [");
  });

  it("moves a picture's box to the origin, which EPS input never puts there", () => {
    // dvisvgm's EPS input draws the page above the origin in PostScript's
    // upward y. The encode keeps only the viewBox's width and height and the
    // viewer draws from the box's top-left, so the drawing has to come back
    // down into its box.
    const eps = `<?xml version='1.0' encoding='UTF-8'?>
<!-- generated by dvisvgm -->
<svg version='1.1' xmlns='http://www.w3.org/2000/svg' width='74pt' height='18pt' viewBox='0 -18 74 18'>
<g id='page1'><path d='M0 0'/></g>
</svg>`;
    const moved = pictureAtOrigin(eps)!;
    expect(moved).toContain("viewBox='0 0 74 18'");
    expect(moved).toContain("<g transform='translate(0,18)'>");
    expect(moved).toContain("<path d='M0 0'/>");
    expect(moved.endsWith("</g></svg>")).toBe(true);
    // A box already at the origin (every conversion from PDF input) and
    // markup that is not a dvisvgm root are both left exactly as they are.
    expect(pictureAtOrigin(eps.replace("viewBox='0 -18 74 18'", "viewBox='0 0 74 18'"))).toBeUndefined();
    expect(pictureAtOrigin(moved)).toBeUndefined();
    expect(pictureAtOrigin("<svg><path d='M0 0'/></svg>")).toBeUndefined();

    const webSrc = tmpDir("lax-web-origin-");
    fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
    fs.writeFileSync(path.join(webSrc, "pics", "fig0.svg"), eps);
    fs.writeFileSync(path.join(webSrc, "pics", "fig1.svg"), eps.replace("0 -18 74 18", "0 0 74 18"));
    fs.writeFileSync(path.join(webSrc, "pics", "fig0.pdf"), "%PDF");
    expect(normalizePictureBoxes(webSrc)).toBe(1);
    expect(fs.readFileSync(path.join(webSrc, "pics", "fig0.svg"), "utf8")).toContain("viewBox='0 0 74 18'");
    expect(fs.readFileSync(path.join(webSrc, "pics", "fig1.svg"), "utf8")).toBe(eps.replace("0 -18 74 18", "0 0 74 18"));
    expect(normalizePictureBoxes(webSrc)).toBe(0);
    expect(normalizePictureBoxes(tmpDir("lax-web-origin-empty-"))).toBe(0);
  });

  it("does not let a picture's own side files make the export look unconverted", () => {
    // Only a `.pdf` without its `.svg` is an unconverted picture; the
    // converter's `.downsampled` markers and a slot's SVG are not pictures.
    const webSrc = tmpDir("lax-web-sidefiles-");
    fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
    fs.mkdirSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR), { recursive: true });
    fs.writeFileSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR, FONT), FONT_BYTES);
    fs.writeFileSync(path.join(webSrc, "pics", "fig0.pdf"), "%PDF");
    fs.writeFileSync(path.join(webSrc, "pics", "fig0.svg"), "<svg/>");
    fs.writeFileSync(path.join(webSrc, "pics", "lax-inc0.svg"), "<svg/>");
    fs.writeFileSync(path.join(webSrc, "pics", `lax-inc0.${WEB_EXPORT_DOWNSAMPLED_SUFFIX}`), "");
    expect(webExportProblem(webSrc, [FONT], DEFAULT_LIMITS)).toBeUndefined();
  });

  it("names a picture the image left unconverted instead of letting the encode trip on it", () => {
    const webSrc = tmpDir("lax-web-export-picture-");
    fs.mkdirSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR), { recursive: true });
    fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
    fs.writeFileSync(path.join(webSrc, WEB_EXPORT_FONTS_DIR, FONT), FONT_BYTES);
    fs.writeFileSync(path.join(webSrc, "pics", "fig0.pdf"), "%PDF");
    fs.writeFileSync(path.join(webSrc, "pics", "fig0.svg"), "<svg/>");
    fs.writeFileSync(path.join(webSrc, "pics", "fig1.pdf"), "%PDF"); // no fig1.svg

    const problem = webExportProblem(webSrc, [FONT], DEFAULT_LIMITS);
    expect(problem?.rule).toBe("web-picture-export");
    expect(problem?.message).toContain("fig1.pdf");
    expect(problem?.message).not.toContain("fig0.pdf");
  });
});
