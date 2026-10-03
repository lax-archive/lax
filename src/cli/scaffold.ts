import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedFilesGitignore } from "../submission-validation/generated-files.js";
// The environment table is the single home of the archive pins, so scaffolds
// always match what the host build and the trusted container validate against
// (and follow the fake-mathlib test seam).
import { librariesOf, type ArchiveEnvironment, type PinnedLibrary } from "../submission-validation/environments.js";
import {
  ensureLocalWarm,
  seedManifest,
  seedOverrides,
} from "../submission-validation/host/warmstore.js";
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
  const libraries = librariesOf(environment);
  fs.mkdirSync(root, { recursive: true });
  write(
    "manifest.yaml",
    `specVersion: "${environment.specVersion}"\nid: ${id}\nleanVersion: ${JSON.stringify(runtime.leanVersion)}\n` +
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
  write("concepts/lakefile.toml", lakefile(libraries, concepts, concepts, false));
  write("proofs/lean-toolchain", `${runtime.leanToolchain}\n`);
  write("proofs/lakefile.toml", lakefile(libraries, proofs, concepts, true));
  if (environment.specVersion === 2) {
    // The content rules in the smallest example an author's first build
    // exercises (axiomfree-plan.md, stage 4): two tagged statements, one proven
    // outright and one from the other, so the scaffold has an edge.
    write(`concepts/${concepts}.lean`, `import ${concepts}.Basic\n`);
    write(`concepts/${concepts}/Basic.lean`, spec2Concepts(concepts));
    write(`proofs/${proofs}.lean`, `import ${proofs}.Basic\n`);
    write(`proofs/${proofs}/Basic.lean`, spec2Proofs(concepts, proofs));
    return;
  }
  write(`concepts/${concepts}.lean`, "");
  fs.mkdirSync(path.join(root, "concepts", concepts), { recursive: true });
  write(`proofs/${proofs}.lean`, "");
  fs.mkdirSync(path.join(root, "proofs", proofs), { recursive: true });
}

/** The spec-2 concept module: `import LaxCore`, the annotation, two
 * `@[lax_statement] def … : Prop` statements under the package namespace. */
function spec2Concepts(concepts: string): string {
  return `import LaxCore

/-!
---
title: Example statements
type: theorem
---
Two statements in the shape this environment reads: a \`def\` of type \`Prop\`
carrying \`@[lax_statement]\`, with no binders — parameters go inside with \`∀\`.
A \`Prop\` definition without the attribute is an auxiliary, never a statement.
Replace both with yours.
-/

namespace ${concepts}.Basic

/-- Adding zero changes nothing. -/
@[lax_statement] def AddZero : Prop := ∀ n : Nat, n + 0 = n

/-- A special case of \`AddZero\`. -/
@[lax_statement] def ZeroAddZero : Prop := 0 + 0 = 0

end ${concepts}.Basic
`;
}

/** The spec-2 proof module: one proof outright, one with the other statement
 * as a hypothesis — the edge — and the \`variable\`/\`include\` recipe for
 * proofs that share hypotheses. */
function spec2Proofs(concepts: string, proofs: string): string {
  return `import ${concepts}.Basic

/-
A proof is a theorem whose type is a chain of statements: the hypotheses,
then the conclusion. Without hypotheses it proves its statement outright;
with them it is the edge {hypotheses} → conclusion of the proof network.
Any other theorem is a helper. Nothing here declares an axiom.
-/

namespace ${proofs}

/-- \`AddZero\`, outright. -/
theorem addZero : ${concepts}.Basic.AddZero := fun n => Nat.add_zero n

/-- \`ZeroAddZero\`, assuming \`AddZero\`. -/
theorem zeroAddZero (h : ${concepts}.Basic.AddZero) : ${concepts}.Basic.ZeroAddZero := h 0

/-
Several proofs sharing hypotheses: declare them once with \`variable\` and
\`include\` them where they are used, so each theorem's type stays a chain of
statements in the order the variables were declared.

  variable (hAddZero : ${concepts}.Basic.AddZero)

  include hAddZero in
  theorem zeroAddZero' : ${concepts}.Basic.ZeroAddZero := hAddZero 0
-/

end ${proofs}
`;
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

/**
 * A package's lakefile: the environment's required libraries at their pins
 * (mathlib alone in a spec-1 row — byte for byte the file always written —
 * mathlib and LaxCore in a spec-2 row), an allowed library as a commented
 * require the author uncomments when needed, and the proof package's path
 * require on its concepts.
 */
function lakefile(
  libraries: readonly PinnedLibrary[],
  packageName: string,
  conceptsName: string,
  proofs: boolean,
): string {
  const require = (library: PinnedLibrary, prefix = ""): string =>
    `${prefix}[[require]]\n${prefix}name = ${JSON.stringify(library.name)}\n${prefix}git = ${JSON.stringify(library.url())}\n` +
    `${prefix}rev = ${JSON.stringify(library.commit)}\n\n`;
  return (
    `name = ${JSON.stringify(packageName)}\ndefaultTargets = [${JSON.stringify(packageName)}]\n\n` +
    "[leanOptions]\nautoImplicit = false\n\n" +
    libraries.filter((library) => library.required).map((library) => require(library)).join("") +
    libraries
      .filter((library) => !library.required)
      .map((library) => `# ${library.name} is allowed in this environment; uncomment to require it:\n${require(library, "# ")}`)
      .join("") +
    (proofs
      ? `[[require]]\nname = ${JSON.stringify(conceptsName)}\npath = "../concepts"\n\n`
      : "") +
    `[[lean_lib]]\nname = ${JSON.stringify(packageName)}\n`
  );
}

function asset(name: string): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", name);
}
