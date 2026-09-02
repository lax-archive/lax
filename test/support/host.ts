// Helpers for the real-lake host-pipeline tests: temp LAX_HOMEs linked to the
// machine-shared warm/tools caches, and submission fixtures written against
// the *active* archive pins (the fake mathlib in fast runs — see setup-env.ts
// and src/submission-validation/pins.ts).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchiveSnapshot } from "../../src/submission-validation/archive/snapshot.js";
import type {
  ValidationReport,
  ValidationRequest,
} from "../../src/submission-validation/contracts.js";
import { packageNameForSubmission } from "../../src/submission-validation/contracts.js";
import {
  validateSubmissionOnHost,
  type HostValidationOptions,
  type HostValidationReport,
} from "../../src/submission-validation/host/pipeline.js";
import { hostValidationRuntime } from "../../src/submission-validation/pins.js";
import type { Profiler } from "../../src/shared/profile.js";
import { SHARED_TOOLS, sharedWarmBase } from "../paths.js";

export function tmpDir(prefix = "lax-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Link a LAX_HOME to the machine-wide shared dirs: the inspector is built
 * once per machine, and the warm mathlib workspace is shared by every test
 * (pre-built by global-setup against the fake mathlib). Without the warm
 * link a home rebuilds the whole workspace. */
export function linkSharedDirs(home: string): string {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(SHARED_TOOLS, { recursive: true });
  fs.symlinkSync(SHARED_TOOLS, path.join(home, "tools"));
  const warmBase = sharedWarmBase();
  fs.mkdirSync(warmBase, { recursive: true });
  fs.symlinkSync(warmBase, path.join(home, "warm"));
  return home;
}

/** A fresh temp LAX_HOME, linked to the shared dirs and pointed at by the
 * environment (for tests driving the pipeline in-process). */
export function freshLaxHome(): string {
  const home = linkSharedDirs(tmpDir("lax-home-"));
  process.env.LAX_HOME = home;
  return home;
}

/** Scaffold a submission against the active pins and lay extra files over
 * it. `stableBase` swaps the temp root for `<stableBase>/<id>` — the mathlib
 * e2e's stable-dir trick (test/paths.ts E2E_WORKSPACE): the `.lake/` trees
 * survive across runs, so rebuilds stay incremental. */
export function makeHostSubmission(
  id: string,
  files: Record<string, string> = {},
  stableBase?: string,
  options: { manifestExtra?: string } = {},
): string {
  const runtime = hostValidationRuntime();
  const root = stableBase === undefined ? tmpDir("lax-sub-") : path.join(stableBase, id);
  if (stableBase !== undefined) fs.mkdirSync(root, { recursive: true });
  const concepts = packageNameForSubmission(id);
  const proofs = `${concepts}Proofs`;
  const write = (relative: string, content: string): void => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  };
  const lakefile = (name: string, conceptPathRequire: boolean): string =>
    `name = "${name}"\ndefaultTargets = ["${name}"]\n\n` +
    "[leanOptions]\nautoImplicit = false\n\n" +
    `[[require]]\nname = "mathlib"\ngit = "${runtime.mathlibRepository}"\n` +
    `rev = "${runtime.mathlibCommit}"\n\n` +
    (conceptPathRequire ? `[[require]]\nname = "${concepts}"\npath = "../concepts"\n\n` : "") +
    `[[lean_lib]]\nname = "${name}"\n`;
  write(
    "manifest.yaml",
    `specVersion: "1"\nid: ${id}\nleanVersion: ${runtime.leanVersion}\n` +
      `mathlibVersion: ${runtime.mathlibCommit}\ntitle: Host pipeline test\n` +
      "authors:\n  - name: Alice Example\n    github: alice\nbibEntries: []\n" +
      (options.manifestExtra ?? ""),
  );
  write("abstract.md", "A host-pipeline test submission.\n");
  write(
    "LICENSE",
    fs.readFileSync(new URL("../../assets/apache-2.0.txt", import.meta.url), "utf8"),
  );
  write(".gitignore", "build-output.json\npaper.pdf\nlake-manifest.json\n.lake/\n");
  write("concepts/lean-toolchain", `${runtime.leanToolchain}\n`);
  write("concepts/lakefile.toml", lakefile(concepts, false));
  write(`concepts/${concepts}.lean`, "");
  write("proofs/lean-toolchain", `${runtime.leanToolchain}\n`);
  write("proofs/lakefile.toml", lakefile(proofs, true));
  write(`proofs/${proofs}.lean`, "");
  for (const [relative, content] of Object.entries(files)) write(relative, content);
  return root;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

export function gitInitCommit(root: string): string {
  git(root, "init", "-q");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return git(root, "rev-parse", "HEAD");
}

/** An empty Archive snapshot (no records) over a fresh temp directory. */
export function emptyArchive(): ArchiveSnapshot {
  return new ArchiveSnapshot(tmpDir("lax-archive-"), "a".repeat(40));
}

/** Run the host pipeline on an in-repo fixture, echo off. */
export async function buildOnHost(
  root: string,
  options: {
    id?: string;
    archive?: ArchiveSnapshot;
    replay?: HostValidationOptions["replay"];
    scope?: HostValidationOptions["scope"];
    profiler?: Profiler;
    /** The claimed source repository URL (defaults to a local placeholder). */
    repository?: string;
    /** Use this job dir so the test can inspect what the build materialized. */
    jobDir?: string;
  } = {},
): Promise<HostValidationReport> {
  const commit = fs.existsSync(path.join(root, ".git")) ? git(root, "rev-parse", "HEAD") : gitInitCommit(root);
  const request: ValidationRequest = {
    requestVersion: 1,
    id: options.id ?? "lax-1",
    source: {
      repository: options.repository ?? "https://github.com/local/local",
      commit,
      folder: ".",
    },
    archiveSha: "a".repeat(40),
  };
  const jobDir = options.jobDir ?? path.join(tmpDir("lax-job-"), "work");
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  return validateSubmissionOnHost(request, jobDir, {
    local: {
      fetched: { repositoryRoot: fs.realpathSync(root), submissionRoot: fs.realpathSync(root) },
      archive: options.archive ?? emptyArchive(),
    },
    echo: false,
    replay: options.replay,
    scope: options.scope,
    profiler: options.profiler,
  });
}

/** The distinct rule names a report's violations carry — the old suite's
 * `rules(result)`, which most judgment assertions were written against. */
export function rules(report: ValidationReport): Set<string> {
  return new Set(report.violations.map((violation) => violation.rule));
}

/** Every violation message of a report, joined for a single `toContain`. */
export function messages(report: ValidationReport): string {
  return report.violations.map((violation) => `[${violation.rule}] ${violation.message}`).join("\n");
}

/**
 * A concept+proof submission with a paper: two concepts, two proofs, and a
 * `paper/` folder whose `main.tex` marks a block (vertical mode), an inline
 * phrase (horizontal mode), a nested pair, a proof, and — through `\input` —
 * a marker in a second file. The markers in `extraTex` are appended to the
 * document body so a test can add a trap without rewriting the fixture.
 */
export function makePaperSubmission(
  id: string,
  options: { extraTex?: string; manifestExtra?: string } = {},
): string {
  const concepts = packageNameForSubmission(id);
  const proofs = `${concepts}Proofs`;
  return makeHostSubmission(
    id,
    {
      [`concepts/${concepts}.lean`]: `import ${concepts}.Zero\nimport ${concepts}.One\n`,
      [`concepts/${concepts}/Zero.lean`]: `/-!
---
title: Zero equals zero
type: theorem
---
The trivial claim.
-/

namespace ${concepts}.Zero

/-- zero equals zero -/
axiom zeroEq : 0 = 0

end ${concepts}.Zero
`,
      [`concepts/${concepts}/One.lean`]: `/-!
---
title: One equals one
type: theorem
---
The other trivial claim.
-/

namespace ${concepts}.One

/-- one equals one -/
axiom oneEq : 1 = 1

end ${concepts}.One
`,
      [`proofs/${proofs}.lean`]: `import ${proofs}.Basic\n`,
      [`proofs/${proofs}/Basic.lean`]: `import ${concepts}.Zero
import ${concepts}.One

namespace ${proofs}

/--
---
conclusion: ${concepts}.Zero.zeroEq
---
by rfl
-/
theorem zero_eq : 0 = 0 := rfl

/--
---
conclusion: ${concepts}.One.oneEq
assumptions:
  - ${concepts}.Zero.zeroEq
---
uses the other statement
-/
theorem one_eq : 1 = 1 := by
  have h := ${concepts}.Zero.zeroEq
  rfl

end ${proofs}
`,
      "paper/main.tex": `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amsthm}
\\usepackage{hyperref}
\\newtheorem{theorem}{Theorem}
\\title{A paper-layer fixture}
\\author{A. Author}
\\date{}
\\begin{document}
\\maketitle

We use the standard notion of
% lax begin ${concepts}.One
one being equal to one
% lax end
as everyone does; 100\\% of the markers in this file are real.

% lax begin ${concepts}.Zero
\\begin{theorem}
  \\label{thm:zero}
  $0 = 0$.
\\end{theorem}

% lax begin ${proofs}.zero_eq
\\begin{proof}
  By reflexivity.
\\end{proof}
% lax end ${proofs}.zero_eq
% lax end

\\input{section}
${options.extraTex ?? ""}
\\end{document}
`,
      "paper/section.tex": `\\section{A second file}

% lax begin ${proofs}.one_eq
The second proof also holds by reflexivity, after touching the assumption.
% lax end
`,
    },
    undefined,
    { manifestExtra: `paper:\n  folder: paper\n  main: main.tex\n${options.manifestExtra ?? ""}` },
  );
}
