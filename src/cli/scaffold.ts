import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import runtime from "../submission-validation/runtime/validation-runtime.lock.json" with { type: "json" };
import { validateNewSubmissionId } from "../shared/validation.js";

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
  fs.mkdirSync(root, { recursive: true });
  write(
    "manifest.yaml",
    `specVersion: "1"\nid: ${id}\nleanVersion: ${JSON.stringify(runtime.leanVersion)}\n` +
      `mathlibVersion: ${JSON.stringify(runtime.mathlibCommit)}\n` +
      `title: ${JSON.stringify(title)}\nauthors: []\nbibEntries: []\n`,
  );
  write("abstract.md", "TODO: describe this submission.\n");
  write("LICENSE", fs.readFileSync(asset("apache-2.0.txt"), "utf8"));
  write(".gitignore", "build-output.json\nlake-manifest.json\n.lake/\n");
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

function lakefile(packageName: string, conceptsName: string, proofs: boolean): string {
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
