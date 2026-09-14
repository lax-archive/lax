import fs from "node:fs";
import path from "node:path";
import { setManifestId } from "./manifest.js";
import { validateScaffoldIdentity } from "./submission-id.js";

const MAX_REKEY_FILE_BYTES = 4 * 1024 * 1024;

/** Rewrite an unbound generated identity before any issue claims it. */
export function rekeySubmission(rootInput: string, oldId: string, newId: string): void {
  const root = path.resolve(rootInput);
  // The old id only has to match the layout it is leaving: a port starts from
  // a record that may predate six-digit ids (lax-5).
  validateScaffoldIdentity(root, oldId, { legacy: true });
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

  renameSpellings(root, oldId, newId, { skipManifest: true });
  for (const [source, target] of renames) {
    if (fs.existsSync(source)) fs.renameSync(source, target);
  }
  setManifestId(root, newId);
  fs.rmSync(path.join(root, "build-output.json"), { force: true });
  validateScaffoldIdentity(root, newId);
}

/**
 * Rewrite every spelling of the submission `oldId` in the tree as `newId`:
 * the proofs package, the concepts package, and the id itself — the three
 * spellings a build resolves by name (Lean imports and namespaces, lakefile
 * and lake-manifest names, paper marker ids) and that prose names a
 * submission by. A rekey applies it to the folder's own identity; a port
 * applies it to each dependency it repointed at that dependency's port, so
 * the sources import the package the requires now name.
 *
 * Every file of the tree is a candidate, and its own bytes decide whether it
 * holds text: which file types a submission spells its identity in is
 * open-ended, so a list of extensions only ever names the ones that existed
 * when it was written. The paper layer is what such a list missed — its
 * `% lax begin Lax261.Treewidth` markers name the concept and proof
 * packages, and a marker left on the old package survives into the next
 * build as a mark against a package the submission no longer has, reported
 * as an unrequired package rather than as a stale id. `skipManifest` is the
 * rekey's one exception: setManifestId rewrites its id key through the YAML
 * document, so the whole-file substitution must not touch it first.
 */
export function renameSpellings(
  root: string,
  oldId: string,
  newId: string,
  options: { skipManifest?: boolean } = {},
): void {
  const oldPackage = `Lax${oldId.slice("lax-".length)}`;
  const newPackage = `Lax${newId.slice("lax-".length)}`;
  const rewrites: Array<{ filename: string; content: string }> = [];
  for (const filename of submissionFiles(root)) {
    if (options.skipManifest === true && filename === path.join(root, "manifest.yaml")) continue;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.size > MAX_REKEY_FILE_BYTES) continue;
    const bytes = fs.readFileSync(filename);
    if (!holdsText(bytes)) continue;
    // Byte-transparent, the way the paper's static gate reads `.tex`: latin1
    // decodes and re-encodes every byte unchanged, so a source that is not
    // UTF-8 (an old paper under inputenc) survives the round trip, while
    // reading it as UTF-8 would replace each undecodable byte and write the
    // replacement character back. The substitutions are pure ASCII, which no
    // multi-byte sequence can contain, so they cannot match inside one.
    const content = bytes.toString("latin1");
    // The substitution is anchored on the three spellings of the identity
    // itself and on nothing else: the proofs package first, since it begins
    // with the concepts package and would otherwise be cut in half, then the
    // concepts package, then the submission id.
    const changed = content
      .replaceAll(`${oldPackage}Proofs`, `${newPackage}Proofs`)
      // A six-digit id can be the prefix of an older seven-digit id. Do not
      // rewrite a dependency such as Lax1234567 while rekeying Lax123456.
      .replace(new RegExp(`${escapeRegExp(oldPackage)}(?![0-9])`, "gu"), newPackage)
      .replace(new RegExp(`${escapeRegExp(oldId)}(?![0-9])`, "gu"), newId);
    if (changed !== content) rewrites.push({ filename, content: changed });
  }
  for (const rewrite of rewrites) atomicWrite(rewrite.filename, rewrite.content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Whether these bytes are text the substitution may run over. A figure, a
 * font, or a compiled PDF beside a paper is opaque payload: it can spell the
 * old package name in a caption and still be destroyed by a substitution that
 * moves every byte after it. Text carries no C0 control byte other than tab,
 * newline, form feed and carriage return, while every container format a
 * submission can hold carries them — in headers, offset tables, and the
 * compressed streams that make up most of a PDF or a PNG.
 */
function holdsText(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d) continue;
    return false;
  }
  return true;
}

/** Every regular file of the submission, minus the version-control and Lake
 * trees, which no rekey may reach into. Symlinks are never followed. */
function submissionFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".lake") continue;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  };
  visit(root);
  return files;
}

function atomicWrite(filename: string, content: string): void {
  const temporary = `${filename}.${process.pid}.rekey.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "latin1", flag: "wx" });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
