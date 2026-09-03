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
  webExportProblem,
  webExportScript,
  WEB_EXPORT_FONT_LIST,
  WEB_EXPORT_FONTS_DIR,
  WEB_EXPORT_SCRIPT,
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
mkdir -p "$out/blocks" "$out/fonts"
printf '%s\\n' "$@" > "$out/argv.txt"
printf '%s' "\${REFLOWTEX_DVISVGM-unset}" > "$out/dvisvgm-seam.txt"
printf '%s' "\${REFLOWTEX_PFB_DIR-unset}" > "$out/pfb-seam.txt"
if [ -n "$fonts" ] && [ -d "$fonts" ]; then cp "$fonts"/* "$out/fonts/" 2>/dev/null || true; fi
printf 'PB' > "$out/blocks/000.pb"
printf '%s' '{"markers":[],"text":"Hello web world","unreferenced":'"$unref"'}' > "$out/stream.json"
printf '%s' '{"pbBytes":2,"fonts":{"${FONT}":"${FONT}"}}' > "$out/encode.json"
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
  return { runner, styDir, input, run: () => deriver(input) };
}

describe("container web deriver", () => {
  it("verifies the pinned TeX image, compiles with -shell-escape on the fresh copy, exports, and seals the bundle", async () => {
    const { runner, styDir, input, run } = derive();
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
    expect(exported.mounts).toEqual([{ source: webSrc, target: PAPER_CONTAINER_PATHS.work, writable: true }]);
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
    // PDF → EPS through the image's Ghostscript, then dvisvgm's --eps input:
    // the pinned image's dvisvgm refuses its Ghostscript for --pdf and has
    // no mutool (2026-09-03 smoke), so a direct --pdf never converts there.
    expect(script).toContain("-sDEVICE=eps2write");
    expect(script).toContain("dvisvgm --eps --no-fonts --optimize=all");
    expect(script).not.toContain("dvisvgm --pdf");
    expect(script).toContain("picture not converted");
    expect(script).toContain("--tmpdir=");
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
