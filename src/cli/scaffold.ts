import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedFilesGitignore } from "../submission-validation/generated-files.js";
// The environment table is the single home of the archive pins, so scaffolds
// always match what the host build and the trusted container validate against
// (and follow the fake-mathlib test seam).
import type { ArchiveEnvironment } from "../submission-validation/environments.js";
import {
  ensureLocalWarm,
  seedManifest,
  seedOverrides,
} from "../submission-validation/host/warmstore.js";
import type { ValidationRuntimeIdentity } from "../submission-validation/contracts.js";
import { hostValidationRuntime } from "../submission-validation/pins.js";
import { PLACEHOLDER_SUBMISSION_ID } from "../shared/constants.js";
import { normalizeSubmissionId, validateNewSubmissionId } from "../shared/validation.js";
import * as ui from "./ui.js";

export function ensureEmptyFolder(folder: string): string {
  const root = path.resolve(folder);
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    throw new Error(`folder ${root} is not empty`);
  }
  return root;
}

/** The root entries a scaffold creates. `.gitignore` is not among them: an
 * existing one is extended rather than replaced. */
const SCAFFOLD_ENTRIES = ["manifest.yaml", "abstract.md", "LICENSE", "concepts", "proofs"];

/**
 * The folder `lax init` may scaffold into: a new or empty one, or one that
 * already holds other work — typically the paper being formalized. What it
 * refuses is a folder where the scaffold would overwrite something, so an
 * existing submission (or anything else by those names) is never clobbered.
 */
export function ensureScaffoldTarget(folder: string): string {
  const root = path.resolve(folder);
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw new Error(`${root} is not a folder`);
  }
  const taken = SCAFFOLD_ENTRIES.filter((entry) => fs.existsSync(path.join(root, entry)));
  if (taken.length > 0) {
    throw new Error(
      `folder ${root} already contains ${taken.join(", ")}; lax init never overwrites existing files`,
    );
  }
  return root;
}

/** Scaffold a local source layout before any GitHub issue exists, in the
 * environment `lax init` selected — the epoch unless `--env` said otherwise.
 * The entry is passed rather than read here so the manifest, both
 * `lean-toolchain` files and both lakefiles cannot disagree about which
 * environment this folder is in. */
export function scaffoldSubmission(
  folder: string,
  id: string,
  title: string,
  environment: ArchiveEnvironment,
): void {
  validateNewSubmissionId(id);
  const root = ensureScaffoldTarget(folder);
  const concepts = `Lax${id.slice("lax-".length)}`;
  const proofs = `${concepts}Proofs`;
  const write = (relative: string, content: string): void => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  };
  const runtime = hostValidationRuntime(environment);
  fs.mkdirSync(root, { recursive: true });
  write(
    "manifest.yaml",
    `specVersion: "1"\nid: ${id}\nleanVersion: ${JSON.stringify(runtime.leanVersion)}\n` +
      `mathlibVersion: ${JSON.stringify(runtime.mathlibCommit)}\n` +
      `title: ${JSON.stringify(title)}\nauthors: []\nbibEntries: []\n`,
  );
  write("abstract.md", "TODO: describe this submission.\n");
  write("LICENSE", fs.readFileSync(asset("apache-2.0.txt"), "utf8"));
  // Every name lax writes into this folder, from the module that also tells
  // static validation and `lax doctor` which names those are: a build must
  // never be able to leave a scaffolded worktree dirty.
  extendGitignore(path.join(root, ".gitignore"));
  write("concepts/lean-toolchain", `${runtime.leanToolchain}\n`);
  write(
    "concepts/lakefile.toml",
    lakefile(runtime, concepts, concepts, false),
  );
  write(`concepts/${concepts}.lean`, "");
  fs.mkdirSync(path.join(root, "concepts", concepts), { recursive: true });
  write("proofs/lean-toolchain", `${runtime.leanToolchain}\n`);
  write("proofs/lakefile.toml", lakefile(runtime, proofs, concepts, true));
  write(`proofs/${proofs}.lean`, "");
  fs.mkdirSync(path.join(root, "proofs", proofs), { recursive: true });
}

/** Add the generated-file lines a `.gitignore` is missing, keeping the rest
 * of it — a folder that already held a paper may ignore its LaTeX output. */
function extendGitignore(filename: string): void {
  if (!fs.existsSync(filename)) {
    fs.writeFileSync(filename, generatedFilesGitignore());
    return;
  }
  const existing = fs.readFileSync(filename, "utf8");
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = generatedFilesGitignore()
    .split("\n")
    .filter((line) => line !== "" && !present.has(line));
  if (missing.length === 0) return;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(filename, separator + missing.map((line) => `${line}\n`).join(""));
}

/** Whether the shared mathlib environment is ready, and why not if it is not. */
export type ProvisionResult = { ok: true } | { ok: false; reason?: string };

/**
 * Seed the freshly scaffolded packages with the generated Lake files a build
 * would write — package overrides pointing the mathlib closure at the shared
 * warm store plus a complete locked manifest — so an immediate bare
 * `lake build` replays the store in place instead of cloning gigabytes of
 * mathlib. Builds the warm store first when this machine has none yet.
 *
 * A failure is reported rather than printed: the caller owns the screen, and
 * this is one row of its report. The scaffold stays valid either way and
 * `lax build` retries.
 */
export async function provisionScaffold(
  root: string,
  idInput: string,
  environment: ArchiveEnvironment,
): Promise<ProvisionResult> {
  try {
    const warm = await ensureLocalWarm(environment, { echo: ui.isVerbose() });
    if (warm === undefined) return { ok: false };
    const id = normalizeSubmissionId(idInput, { placeholder: true });
    if (id !== PLACEHOLDER_SUBMISSION_ID) validateNewSubmissionId(id);
    const concepts = `Lax${id.slice("lax-".length)}`;
    for (const kind of ["concepts", "proofs"] as const) {
      const pkgDir = path.join(root, kind);
      seedOverrides(warm, pkgDir);
      seedManifest(
        warm,
        pkgDir,
        kind === "proofs" ? [{ name: concepts, dir: "../concepts" }] : [],
      );
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function lakefile(
  runtime: ValidationRuntimeIdentity,
  packageName: string,
  conceptsName: string,
  proofs: boolean,
): string {
  return (
    `name = ${JSON.stringify(packageName)}\ndefaultTargets = [${JSON.stringify(packageName)}]\n\n` +
    "[leanOptions]\nautoImplicit = false\n\n" +
    `[[require]]\nname = "mathlib"\ngit = ${JSON.stringify(runtime.mathlibRepository)}\n` +
    `rev = ${JSON.stringify(runtime.mathlibCommit)}\n\n` +
    (proofs
      ? `[[require]]\nname = ${JSON.stringify(conceptsName)}\npath = "../concepts"\n\n`
      : "") +
    `[[lean_lib]]\nname = ${JSON.stringify(packageName)}\n`
  );
}

function asset(name: string): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", name);
}
