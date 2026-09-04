import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedFilesGitignore } from "../submission-validation/generated-files.js";
// The environment table is the single home of the archive pins, so scaffolds
// always match what the host build and the trusted container validate against
// (and follow the fake-mathlib test seam).
import { epoch } from "../submission-validation/environments.js";
import {
  ensureLocalWarm,
  seedManifest,
  seedOverrides,
} from "../submission-validation/host/warmstore.js";
import { hostValidationRuntime } from "../submission-validation/pins.js";
import { PLACEHOLDER_SUBMISSION_ID } from "../shared/constants.js";
import { normalizeSubmissionId, validateNewSubmissionId } from "../shared/validation.js";
import * as ui from "./ui.js";

/** A new submission is scaffolded in the epoch. Read per call, never frozen at
 * import: the test seam substitutes the fake mathlib after this module loads,
 * and stage 4 gives `lax init` an `--env` of its own. */
function epochRuntime(): ReturnType<typeof hostValidationRuntime> {
  return hostValidationRuntime(epoch());
}

export function ensureEmptyFolder(folder: string): string {
  const root = path.resolve(folder);
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    throw new Error(`folder ${root} is not empty`);
  }
  return root;
}

/** Scaffold a local source layout before any GitHub issue exists. */
export function scaffoldSubmission(
  folder: string,
  id: string,
  title: string,
): void {
  validateNewSubmissionId(id);
  const root = ensureEmptyFolder(folder);
  const concepts = `Lax${id.slice("lax-".length)}`;
  const proofs = `${concepts}Proofs`;
  const write = (relative: string, content: string): void => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  };
  const runtime = epochRuntime();
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
  write(".gitignore", generatedFilesGitignore());
  write("concepts/lean-toolchain", `${runtime.leanToolchain}\n`);
  write(
    "concepts/lakefile.toml",
    lakefile(concepts, concepts, false),
  );
  write(`concepts/${concepts}.lean`, "");
  fs.mkdirSync(path.join(root, "concepts", concepts), { recursive: true });
  write("proofs/lean-toolchain", `${runtime.leanToolchain}\n`);
  write("proofs/lakefile.toml", lakefile(proofs, concepts, true));
  write(`proofs/${proofs}.lean`, "");
  fs.mkdirSync(path.join(root, "proofs", proofs), { recursive: true });
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
): Promise<ProvisionResult> {
  try {
    // stage 4: `lax init --env` selects the environment; today it is the epoch.
    const warm = await ensureLocalWarm(epoch(), { echo: ui.isVerbose() });
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

function lakefile(packageName: string, conceptsName: string, proofs: boolean): string {
  const runtime = epochRuntime();
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
