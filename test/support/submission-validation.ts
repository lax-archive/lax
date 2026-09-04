import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  StaticResult,
  ValidationRequest,
  ValidationRuntimeIdentity,
} from "../../src/submission-validation/contracts.js";
import { packageNameForSubmission } from "../../src/submission-validation/contracts.js";

export const REPOSITORY = "https://github.com/alice/monorepo";
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export const RUNTIME: ValidationRuntimeIdentity = {
  environment: "v4.30.0",
  image: `node:22-bookworm-slim@sha256:${"1".repeat(64)}`,
  imageDigest: "1".repeat(64),
  layoutVersion: 1,
  leanToolchain: "leanprover/lean4:v4.30.0",
  leanVersion: "v4.30.0",
  mathlibRepository: "https://github.com/leanprover-community/mathlib4",
  mathlibCommit: "c5ea00351c28e24afc9f0f84379aa41082b1188f",
};

const temporaryDirectories: string[] = [];

export function temporary(prefix = "lax-validation-test-"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export function cleanupTemporary(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function writeFile(root: string, relative: string, content: string): void {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content, "utf8");
}

export function manifest(id: string): string {
  return (
    `specVersion: "1"\nid: ${id}\nleanVersion: ${RUNTIME.leanVersion}\n` +
    `mathlibVersion: ${RUNTIME.mathlibCommit}\ntitle: Test submission\n` +
    "authors:\n  - name: Alice Example\n    github: alice\nbibEntries: []\n"
  );
}

export function lakefile(
  name: string,
  options: { ownConcept?: string; requirements?: string[] } = {},
): string {
  return (
    `name = "${name}"\ndefaultTargets = ["${name}"]\n\n` +
    "[leanOptions]\nautoImplicit = false\n\n" +
    `[[require]]\nname = "mathlib"\ngit = "${RUNTIME.mathlibRepository}"\n` +
    `rev = "${RUNTIME.mathlibCommit}"\n\n` +
    (options.ownConcept === undefined
      ? ""
      : `[[require]]\nname = "${options.ownConcept}"\npath = "../concepts"\n\n`) +
    (options.requirements ?? []).map((requirement) => `[[require]]\n${requirement}\n\n`).join("") +
    `[[lean_lib]]\nname = "${name}"\n`
  );
}

export function makeSubmission(
  id: string,
  root = temporary("lax-submission-"),
  files: Record<string, string> = {},
): string {
  const concepts = packageNameForSubmission(id);
  const proofs = `${concepts}Proofs`;
  fs.mkdirSync(root, { recursive: true });
  writeFile(root, "manifest.yaml", manifest(id));
  writeFile(root, "abstract.md", "A test submission.\n");
  writeFile(
    root,
    "LICENSE",
    fs.readFileSync(new URL("../../assets/apache-2.0.txt", import.meta.url), "utf8"),
  );
  writeFile(root, ".gitignore", "build-output.json\nlake-manifest.json\n.lake/\n");
  writeFile(root, "concepts/lean-toolchain", `${RUNTIME.leanToolchain}\n`);
  writeFile(root, "concepts/lakefile.toml", lakefile(concepts));
  writeFile(root, `concepts/${concepts}.lean`, "");
  writeFile(root, "proofs/lean-toolchain", `${RUNTIME.leanToolchain}\n`);
  writeFile(root, "proofs/lakefile.toml", lakefile(proofs, { ownConcept: concepts }));
  writeFile(root, `proofs/${proofs}.lean`, "");
  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content);
  return root;
}

export function appendRequirement(
  top: string,
  folder: string,
  kind: "concepts" | "proofs",
  requirement: string,
): void {
  fs.appendFileSync(
    path.join(top, folder, kind, "lakefile.toml"),
    `\n[[require]]\n${requirement}\n`,
  );
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function initializeGit(root: string): string {
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=Lax Test",
    "-c",
    "user.email=lax@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}

export function request(id: string, folder = "."): ValidationRequest {
  return {
    requestVersion: 1,
    id,
    source: { repository: REPOSITORY, commit: COMMIT, folder },
    archiveSha: "a".repeat(40),
  };
}

export function staticResult(id: string): StaticResult {
  const concepts = packageNameForSubmission(id);
  const proofs = `${concepts}Proofs`;
  const inventory = (kind: "concepts" | "proofs", packageName: string) => ({
    packageName,
    packageDir: kind,
    rootModule: packageName,
    modules: [],
    paths: new Map([[packageName, `${kind}/${packageName}.lean`]]),
  });
  return {
    concepts: {
      lakefile: {
        packageName: concepts,
        gitRequires: [],
        hasConceptPathRequire: false,
      },
      inventory: inventory("concepts", concepts),
    },
    proofs: {
      lakefile: {
        packageName: proofs,
        gitRequires: [],
        hasConceptPathRequire: true,
      },
      inventory: inventory("proofs", proofs),
    },
  };
}
