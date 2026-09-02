// The host executor of the paper phase: latexmk from PATH, the shipped
// `assets/tex/laxmark.sty` on TEXINPUTS, the same arguments and environment
// the trusted container uses (paper/compile.ts). Local is a preview; the
// archive's compile in the pinned TeX Live image is the authority, and a
// paper can pass here and fail there when the host's TeX differs.

import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { paperCompileEnvironment } from "../paper/compile.js";
import type { PaperCompiler } from "../paper/phase.js";
import { run } from "./proc.js";

const execFileAsync = promisify(execFile);

/** latexmk's `-usepretex` — the injection mechanism — exists since 4.77
 * (TeX Live 2023). */
export const MIN_LATEXMK_VERSION = "4.77";

/** The directory holding the archive's marker packages (`laxmark.sty`, and
 * `laxreflow.sty` for the derived web view) and nothing else, so it can sit
 * on TEXINPUTS without exposing anything beside them. Resolved from this
 * module, which lives at the same depth under `src/` and `dist/`. */
export function laxmarkDirectory(): string {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "tex");
  if (!fs.existsSync(path.join(dir, "laxmark.sty"))) {
    throw new Error("the paper marker package laxmark.sty is missing from this installation");
  }
  return dir;
}

export interface LatexmkProbe {
  /** The version number as latexmk prints it (`4.83`). */
  version: string;
  /** Whether it is recent enough to inject the marker package. */
  supported: boolean;
}

/** Parse `latexmk --version` output: `Latexmk, John Collins, 31 Jan. 2024. Version 4.83`. */
export function parseLatexmkVersion(output: string): LatexmkProbe | undefined {
  const match = /Version\s+(\d+(?:\.\d+)?[a-z]?)/u.exec(output);
  if (match === null) return undefined;
  const version = match[1]!;
  return { version, supported: compareVersions(version, MIN_LATEXMK_VERSION) >= 0 };
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => value.replace(/[a-z]$/u, "").split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether `latexmk` (and optionally an engine) is on PATH, and which version. Sync — the build's preflight. */
export function probeLatexmk(): LatexmkProbe | undefined {
  try {
    const output = execFileSync("latexmk", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return parseLatexmkVersion(output);
  } catch {
    return undefined;
  }
}

export async function probeLatexmkAsync(): Promise<LatexmkProbe | undefined> {
  try {
    const { stdout } = await execFileAsync("latexmk", ["--version"], { encoding: "utf8" });
    return parseLatexmkVersion(stdout);
  } catch {
    return undefined;
  }
}

/** Whether an engine binary answers on PATH. */
export async function engineAvailable(engine: string): Promise<boolean> {
  try {
    await execFileAsync(engine, ["--version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The host compiler. `echo` streams the transcript like the lake builds do.
 * No timeout locally, as for every interactive host command: Ctrl+C stays
 * in charge, and `-halt-on-error` with nonstop interaction means TeX never
 * waits for a keyboard.
 */
export function hostPaperCompiler(options: { echo: boolean; maxOutputBytes: number }): PaperCompiler {
  const styDir = laxmarkDirectory();
  return async (cwd, args, sourceDateEpoch) => {
    if (options.echo) console.log("\n== latexmk (paper) ==");
    const result = await run("latexmk", args, cwd, {
      echo: options.echo,
      env: { ...paperCompileEnvironment(styDir, sourceDateEpoch), PATH: process.env.PATH ?? "/usr/bin:/bin" },
      maxOutputBytes: options.maxOutputBytes,
    });
    return { code: result.code, output: result.output };
  };
}

/** The committer time of a commit — the source date a compile is pinned to,
 * so the same commit yields the same PDF on every machine. */
export function commitTimestamp(repositoryRoot: string, commit: string): number {
  const output = execFileSync("git", ["-C", repositoryRoot, "show", "-s", "--format=%ct", commit], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const seconds = Number(output.split("\n").pop());
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(`could not read the commit time of ${commit}`);
  return seconds;
}
