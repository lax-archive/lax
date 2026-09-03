import fs from "node:fs";
import path from "node:path";
import { setManifestId } from "./manifest.js";
import { validateScaffoldIdentity } from "./submission-id.js";

const TEXT_EXTENSIONS = new Set([".lean", ".toml", ".yaml", ".yml", ".md", ".json"]);
const MAX_REKEY_FILE_BYTES = 4 * 1024 * 1024;

/** Rewrite the generated identity before a submission has any remote binding. */
export function rekeySubmission(rootInput: string, oldId: string, newId: string): void {
  const root = path.resolve(rootInput);
  validateScaffoldIdentity(root, oldId);
  const oldPackage = `Lax${oldId.slice("lax-".length)}`;
  const newPackage = `Lax${newId.slice("lax-".length)}`;
  const renames = [
    [path.join(root, "concepts", oldPackage), path.join(root, "concepts", newPackage)],
    [path.join(root, "proofs", `${oldPackage}Proofs`), path.join(root, "proofs", `${newPackage}Proofs`)],
    [path.join(root, "concepts", `${oldPackage}.lean`), path.join(root, "concepts", `${newPackage}.lean`)],
    [path.join(root, "proofs", `${oldPackage}Proofs.lean`), path.join(root, "proofs", `${newPackage}Proofs.lean`)],
  ] as const;
  for (const [source, target] of renames) {
    if (fs.existsSync(source) && fs.existsSync(target)) {
      throw new Error(`cannot rekey ${oldId}: target path already exists at ${target}`);
    }
  }

  const rewrites: Array<{ filename: string; content: string }> = [];
  for (const filename of textFiles(root)) {
    if (filename === path.join(root, "manifest.yaml")) continue;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.size > MAX_REKEY_FILE_BYTES) continue;
    const content = fs.readFileSync(filename, "utf8");
    const changed = content.replaceAll(`${oldPackage}Proofs`, `${newPackage}Proofs`)
      .replaceAll(oldPackage, newPackage)
      .replaceAll(oldId, newId);
    if (changed !== content) rewrites.push({ filename, content: changed });
  }

  for (const rewrite of rewrites) atomicWrite(rewrite.filename, rewrite.content);
  for (const [source, target] of renames) {
    if (fs.existsSync(source)) fs.renameSync(source, target);
  }
  setManifestId(root, newId);
  fs.rmSync(path.join(root, "build-output.json"), { force: true });
  validateScaffoldIdentity(root, newId);
}

function textFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".lake") continue;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) files.push(filename);
    }
  };
  visit(root);
  return files;
}

function atomicWrite(filename: string, content: string): void {
  const temporary = `${filename}.${process.pid}.rekey.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
