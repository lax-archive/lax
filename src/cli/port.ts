// `lax port lax-N [folder]`: the scaffolding half of moving a submission into
// another archive environment.
//
// A record has exactly one environment for life — an olean built by one Lean
// version cannot be loaded by another — so moving work forward is a *new
// submission* that supersedes the old one, never an edit. Everything about
// that new submission which can be derived mechanically is derived here: the
// old source at its published commit, a fresh id (package names derive from
// the id, and both versions have to coexist in one dependency graph), the
// target environment's pins in all five places that carry them, the
// `supersedes` claim, and each cross-submission require repointed at the
// dependency's own port.
//
// What is deliberately *not* done is the Lean. A port that compiles is the
// author's work; this command exists so that work starts from a folder that is
// already in the right environment and already says what it replaces. Ports
// flow bottom-up exactly as the chain workflow does, so a dependency with no
// port yet is left pinned where it is, named, and reported.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isObject, normalizeSubmissionId } from "../shared/validation.js";
import { submissionIdForPackage } from "../submission-validation/contracts.js";
import type { ArchiveEnvironment } from "../submission-validation/environments.js";
import { databaseDirectory, tryRefreshDatabase } from "./database.js";
import { diskCostLines, requestedEnvironment } from "./environments.js";
import { setManifestEnvironment, setManifestSupersedes } from "./manifest.js";
import { recordSubmission } from "./registry.js";
import { rekeySubmission } from "./rekey.js";
import { ensureEmptyFolder } from "./scaffold.js";
import { generateSubmissionId } from "./submission-id.js";
import * as ui from "./ui.js";

export interface PortOptions {
  /** Target environment id; the epoch when absent. */
  env?: string;
}

/** What one record of the local archive copy contributes to a port. */
interface PortRecord {
  id: string;
  state: string;
  source?: { repository: string; commit: string; folder: string };
  /** The record's environment: its `manifest.leanVersion` and nothing else. */
  environment?: string;
  /** The registered submission this one replaces, from its build output. */
  supersedes?: string;
}

export async function portSubmission(
  submissionInput: string,
  folderInput: string | undefined,
  options: PortOptions = {},
): Promise<number> {
  const id = normalizeSubmissionId(submissionInput);
  const target = requestedEnvironment(options.env);
  const database = databaseDirectory();
  if (!fs.existsSync(path.join(database, ".git"))) {
    throw new Error(
      `there is no local copy of the archive at ${ui.tilde(database)} — run ${ui.cmd("lax sync")} first`,
    );
  }
  if (tryRefreshDatabase() === "failed") {
    ui.verbose("the archive could not be refreshed; porting from the existing copy");
  }
  const archive = readArchive(database);
  const record = archive.get(id);
  if (record === undefined || record.source === undefined) {
    throw new Error(`${id} has no draft or registered record in the local archive copy`);
  }
  if (record.environment === target.id) {
    throw new Error(
      `${id} is already in environment ${target.id}; a port moves a submission to a different environment`,
    );
  }
  const root = ensureEmptyFolder(folderInput ?? `port-${id}`);
  const newId = generateSubmissionId();

  ui.title(`Porting ${id} to ${target.id}`);
  for (const cost of diskCostLines(target)) ui.faint(cost);
  const notes = new ui.Notes();
  const steps = new ui.Steps();
  steps.add("source", "Fetching the source");
  steps.add("rewrite", "Rewriting it for the environment");
  let repointed: RepointResult;
  try {
    fetchSource(record.source, root);
    steps.settle("source", {
      label: "Fetched the source",
      detail: `${record.source.commit.slice(0, 12)} · ${record.environment ?? "unknown environment"}`,
    });
    steps.begin("rewrite");
    // The new id first: rekeying rewrites every spelling of the old identity —
    // package names, imports, namespaces, paper markers — and the `supersedes`
    // claim added afterwards names the old id, which a rekey would otherwise
    // rewrite along with the rest.
    rekeySubmission(root, id, newId);
    repointPins(root, target);
    repointed = repointRequires(root, archive, target);
    setManifestEnvironment(root, target);
    setManifestSupersedes(root, id);
    recordSubmission(root);
    steps.settle("rewrite", { label: "Rewrote it for the environment", detail: target.id });
  } catch (error) {
    // A half-written folder would be refused by the next attempt (a port wants
    // an empty one) and is not a submission in any case. The folder itself
    // stays — it may be one the author made, and may even be the cwd.
    emptyFolder(root);
    throw error;
  } finally {
    steps.finish();
  }

  ui.blank();
  ui.line(ui.bold(`${newId} · ${target.id}`) + ui.dim(` · supersedes ${id}`));
  ui.faint(ui.tilde(root));
  for (const done of repointed.repointed) {
    notes.add(`${done.was} is ${done.now} in ${target.id} — the require now points there.`);
  }
  for (const blocked of repointed.blocked) {
    notes.add(
      `${blocked.package} has no ${target.id} version yet, so its require is unchanged.`,
      `Port ${blocked.id} first — then rerun this port into a fresh folder, or repoint it by hand.`,
    );
  }
  for (const problem of repointed.unreadable) notes.add(problem);
  notes.add(
    "The Lean is not ported: only the pins, the id, and the requires are.",
    `Fix the sources, then ${ui.cmd("lax build")} and ${ui.cmd("lax submit")} as usual.`,
  );
  notes.print();
  ui.done();
  return 0;
}

/** Check out the record's exact published commit and keep the submission
 * folder alone: neither the repository's other content, nor its history, nor
 * any build tree it happened to carry. */
function fetchSource(
  source: { repository: string; commit: string; folder: string },
  root: string,
): void {
  // Both values come from the archive's own record, but an argument that could
  // be read as an option would be a way to make git do something else, and `--`
  // does not cover the checkout's revision argument.
  if (source.repository.startsWith("-") || !/^[0-9a-f]{40}$/u.test(source.commit)) {
    throw new Error(`the archive record's source triple is malformed (${source.repository})`);
  }
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "lax-port-"));
  try {
    git(["clone", "--quiet", "--no-tags", "--", source.repository, clone]);
    git(["-C", clone, "checkout", "--quiet", "--detach", source.commit]);
    const from = source.folder === "." ? clone : path.join(clone, source.folder);
    if (!fs.existsSync(path.join(from, "manifest.yaml"))) {
      throw new Error(`${source.repository} at ${source.commit} has no manifest.yaml in ${source.folder}`);
    }
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(from, root, {
      recursive: true,
      dereference: false,
      // The root itself is always copied; below it, neither the repository's
      // history nor a build tree the author happened to commit comes along.
      filter: (candidate) =>
        candidate === from ||
        !path.relative(from, candidate).split(path.sep).some((part) => part === ".git" || part === ".lake"),
    });
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
  }
}

/** The environment's pins where a submission carries them outside the
 * manifest: both `lean-toolchain` files and both lakefiles' mathlib `rev`. */
function repointPins(root: string, target: ArchiveEnvironment): void {
  for (const kind of ["concepts", "proofs"] as const) {
    fs.writeFileSync(path.join(root, kind, "lean-toolchain"), `${target.leanToolchain}\n`);
    const lakefile = path.join(root, kind, "lakefile.toml");
    const content = fs.readFileSync(lakefile, "utf8");
    const rewritten = editRequire(content, "mathlib", { rev: target.mathlibCommit });
    if (rewritten === undefined) {
      throw new Error(`${kind}/lakefile.toml has no mathlib require this command can rewrite`);
    }
    fs.writeFileSync(lakefile, rewritten);
  }
}

interface RepointResult {
  repointed: Array<{ was: string; now: string }>;
  blocked: Array<{ package: string; id: string }>;
  unreadable: string[];
}

/**
 * Point every cross-submission require at the dependency's own port.
 *
 * The successor chain is the archive's record of what replaced what, so the
 * port of `lax-M` is whatever the chain from `lax-M` reaches that lives in the
 * target environment. A dependency with no such member is left exactly as it
 * is: its require still names a real, immutable record, so the folder stays
 * coherent, and the note says which submission has to be ported first.
 */
function repointRequires(
  root: string,
  archive: Map<string, PortRecord>,
  target: ArchiveEnvironment,
): RepointResult {
  const result: RepointResult = { repointed: [], blocked: [], unreadable: [] };
  const successors = successorChain(archive);
  for (const kind of ["concepts", "proofs"] as const) {
    const lakefile = path.join(root, kind, "lakefile.toml");
    let content = fs.readFileSync(lakefile, "utf8");
    for (const requirement of gitRequires(content)) {
      if (requirement.name === "mathlib") continue;
      const dependencyId = submissionIdForPackage(requirement.name);
      if (dependencyId === undefined) continue;
      const ported = portOf(archive, successors, dependencyId, target.id);
      if (ported === undefined || ported.source === undefined) {
        result.blocked.push({ package: requirement.name, id: dependencyId });
        continue;
      }
      // Which package of the dependency is required is the suffix's business,
      // not this lakefile's: a proofs lakefile may require either.
      const dependencyKind = requirement.name.endsWith("Proofs") ? "proofs" : "concepts";
      const suffix = dependencyKind === "proofs" ? "Proofs" : "";
      const name = `Lax${ported.id.slice("lax-".length)}${suffix}`;
      const subDir =
        ported.source.folder === "."
          ? dependencyKind
          : path.posix.join(ported.source.folder, dependencyKind);
      const rewritten = editRequire(content, requirement.name, {
        name,
        git: ported.source.repository,
        rev: ported.source.commit,
        subDir,
      });
      if (rewritten === undefined) {
        result.unreadable.push(
          `${kind}/lakefile.toml: the ${requirement.name} require is not in the one-key-per-line form this command rewrites — repoint it by hand.`,
        );
        continue;
      }
      content = rewritten;
      result.repointed.push({ was: requirement.name, now: name });
    }
    fs.writeFileSync(lakefile, content);
  }
  // Both lakefiles name the same dependency once each; the author reads one
  // line per dependency, not one per package.
  result.repointed = unique(result.repointed, (entry) => `${entry.was}→${entry.now}`);
  result.blocked = unique(result.blocked, (entry) => entry.package);
  return result;
}

/** The member of `id`'s successor chain that lives in `environment`, or
 * undefined when the chain never reaches it. A chain is a list — at most one
 * successor binds per submission — so this terminates. */
function portOf(
  archive: Map<string, PortRecord>,
  successors: Map<string, string>,
  id: string,
  environment: string,
): PortRecord | undefined {
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const record = archive.get(current);
    if (record === undefined) return undefined;
    if (record.environment === environment && record.source !== undefined) return record;
    current = successors.get(current);
  }
  return undefined;
}

/** Who replaced whom, by the only pointer the archive has: a successor's own
 * `supersedes`. Only a registered successor binds the slot, so only those are
 * links of a chain. */
function successorChain(archive: Map<string, PortRecord>): Map<string, string> {
  const successors = new Map<string, string>();
  for (const record of archive.values()) {
    if (record.state === "registered" && record.supersedes !== undefined) {
      successors.set(record.supersedes, record.id);
    }
  }
  return successors;
}

/** Every git-type require of a lakefile, by the parser static validation uses.
 * Reading is TOML; writing below is text, because the author's file is theirs
 * and a port must not reformat it. */
function gitRequires(content: string): Array<{ name: string }> {
  let value: unknown;
  try {
    value = parseToml(content);
  } catch {
    return [];
  }
  const requirements = isObject(value) ? value.require : undefined;
  if (!Array.isArray(requirements)) return [];
  return requirements.flatMap((raw) =>
    isObject(raw) && typeof raw.name === "string" && typeof raw.git === "string"
      ? [{ name: raw.name }]
      : [],
  );
}

/**
 * Replace values inside the `[[require]]` block that declares `name`, leaving
 * every other byte of the file alone — comments, blank lines, key order and
 * the author's own quoting style included.
 *
 * `undefined` when the block is not in the one-key-per-line form lax scaffolds
 * and every submission so far uses; the caller then says so rather than
 * writing a file it cannot promise is correct.
 */
export function editRequire(
  content: string,
  name: string,
  updates: Partial<Record<"name" | "git" | "rev" | "subDir", string>>,
): string | undefined {
  const lines = content.split("\n");
  const header = /^\s*\[/u;
  const requireHeader = /^\s*\[\[\s*require\s*\]\]\s*(?:#.*)?$/u;
  let start: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (!requireHeader.test(lines[index]!)) continue;
    let end = index + 1;
    while (end < lines.length && !header.test(lines[end]!)) end += 1;
    const keys = new Map<string, number>();
    for (let inner = index + 1; inner < end; inner += 1) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(lines[inner]!);
      if (match !== null) keys.set(match[1]!, inner);
    }
    const nameLine = keys.get("name");
    if (nameLine === undefined) continue;
    const declared = /^\s*name\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/u.exec(lines[nameLine]!);
    if (declared === null || declared[2] !== name) continue;
    start = index;
    for (const [key, replacement] of Object.entries(updates)) {
      const line = keys.get(key);
      if (line === undefined) return undefined;
      const current = new RegExp(`^(\\s*${key}\\s*=\\s*)(["'])(.*?)\\2(\\s*(?:#.*)?)$`, "u").exec(lines[line]!);
      if (current === null) return undefined;
      lines[line] = `${current[1]}${JSON.stringify(replacement)}${current[4]}`;
    }
    break;
  }
  return start === undefined ? undefined : lines.join("\n");
}

/** The local archive copy, in the three fields a port reads. Unreadable and
 * half-written records drop out: a port is a scaffold, not a validator. */
function readArchive(database: string): Map<string, PortRecord> {
  const archive = new Map<string, PortRecord>();
  for (const entry of fs.readdirSync(database, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^lax-[1-9][0-9]*$/u.test(entry.name)) continue;
    const record = readJson(path.join(database, entry.name, "record.json"));
    if (!isObject(record) || typeof record.state !== "string") continue;
    const output = readJson(path.join(database, entry.name, "build-output.json"));
    const manifest = isObject(output) && isObject(output.inputs) ? output.inputs.manifest : undefined;
    const source = isObject(record.source) ? record.source : undefined;
    archive.set(entry.name, {
      id: entry.name,
      state: record.state,
      ...(source !== undefined &&
      typeof source.repository === "string" &&
      typeof source.commit === "string" &&
      typeof source.folder === "string"
        ? { source: { repository: source.repository, commit: source.commit, folder: source.folder } }
        : {}),
      ...(isObject(manifest) && typeof manifest.leanVersion === "string"
        ? { environment: manifest.leanVersion }
        : {}),
      ...(isObject(manifest) && typeof manifest.supersedes === "string"
        ? { supersedes: manifest.supersedes }
        : {}),
    });
  }
  return archive;
}

/** Take back everything this command wrote into `root`, leaving `root` itself. */
function emptyFolder(root: string): void {
  try {
    for (const entry of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  } catch {
    // nothing to take back
  }
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function readJson(filename: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function git(args: string[]): void {
  execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"], timeout: 300_000 });
}
