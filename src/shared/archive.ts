import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import {
  ARCHIVE_FILENAMES,
  fileDigests,
  parseArchiveFiles,
  type ArchiveChanges,
  type ArchiveFilename,
} from "./archive-schema.js";
import { DATABASE_REPOSITORY } from "./constants.js";
import { GitHubClient, GitHubError, repositoryPath } from "./github.js";
import { packageNameForSubmission } from "../submission-validation/contracts.js";
import type { ArchiveFiles, FilePreconditions } from "./types.js";
import { ValidationError } from "./validation.js";
import { decodeUtf8 } from "./validation.js";

interface RepositoryInfo {
  default_branch: string;
}

interface GitRef {
  object: { sha: string };
}

interface GitCommit {
  sha: string;
  tree: { sha: string };
}

interface GitTree {
  truncated: boolean;
  tree: GitTreeEntry[];
}

interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface GitBlob {
  encoding: "base64";
  content: string;
}

export interface ArchiveSnapshot {
  branch: string;
  sha: string;
}

export interface LoadedSubmission {
  snapshot: ArchiveSnapshot;
  texts: Record<string, string>;
  files: ArchiveFiles;
  preconditions: FilePreconditions;
}

interface PublicationGuardOptions {
  attempts?: number;
  intervalMs?: number;
  conflictAttempts?: number;
  conflictIntervalMs?: number;
}

export class ArchiveRepository {
  private readonly base: string;

  constructor(
    private readonly github: GitHubClient,
    repository = DATABASE_REPOSITORY,
    private readonly publicationGuard: PublicationGuardOptions = {},
  ) {
    this.base = repositoryPath(repository);
  }

  async snapshot(): Promise<ArchiveSnapshot> {
    const repo = await this.github.request<RepositoryInfo>("GET", this.base);
    const ref = await this.github.request<GitRef>(
      "GET",
      `${this.base}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
    );
    return { branch: repo.default_branch, sha: ref.object.sha };
  }

  async load(id: string, snapshot = undefined as ArchiveSnapshot | undefined): Promise<LoadedSubmission | undefined> {
    const selected = snapshot ?? (await this.snapshot());
    const entry = await this.rootEntry(id, selected.sha);
    if (entry === undefined) return undefined;
    if (entry.type !== "tree" || entry.mode !== "040000") {
      throw new ValidationError(`${id} must be a regular Archive directory`);
    }
    const directory = await this.github.request<GitTree>("GET", `${this.base}/git/trees/${entry.sha}`);
    if (directory.truncated) throw new ValidationError(`${id} Archive directory listing is truncated`);
    const actualNames = directory.tree.map((child) => child.path).sort();
    const expectedNames = [...ARCHIVE_FILENAMES].sort();
    if (
      actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index]) ||
      directory.tree.some((child) => child.type !== "blob" || child.mode !== "100644")
    ) {
      throw new ValidationError(
        `${id} must contain exactly the three non-executable regular Archive files`,
      );
    }
    const texts: Record<string, string> = {};
    for (const name of ARCHIVE_FILENAMES) {
      const child = directory.tree.find((candidate) => candidate.path === name)!;
      const blob = await this.github.request<GitBlob>("GET", `${this.base}/git/blobs/${child.sha}`);
      if (blob.encoding !== "base64") {
        throw new ValidationError(`${id}/${name} is not a regular base64-encoded file`);
      }
      texts[name] = decodeBase64(blob.content);
    }
    return {
      snapshot: selected,
      texts,
      files: parseArchiveFiles(id, texts),
      preconditions: fileDigests(texts),
    };
  }

  async exists(id: string, snapshot: ArchiveSnapshot): Promise<boolean> {
    return (await this.rootEntry(id, snapshot.sha)) !== undefined;
  }

  async listDependents(id: string, snapshot: ArchiveSnapshot): Promise<string[]> {
    const packageName = packageNameForSubmission(id);
    const commit = await this.github.request<GitCommit>("GET", `${this.base}/git/commits/${snapshot.sha}`);
    const tree = await this.github.request<GitTree>(
      "GET",
      `${this.base}/git/trees/${commit.tree.sha}?recursive=1`,
    );
    if (tree.truncated) throw new Error("lax-database tree is too large for a complete dependency scan");
    const candidates = tree.tree.filter(
      (entry) => entry.type === "blob" && /^lax-[1-9][0-9]*\/build-output\.json$/u.test(entry.path),
    );
    const dependents: string[] = [];
    for (const entry of candidates) {
      const candidateId = entry.path.split("/")[0]!;
      if (candidateId === id) continue;
      const blob = await this.github.request<GitBlob>("GET", `${this.base}/git/blobs/${entry.sha}`);
      const output = JSON.parse(decodeBase64(blob.content)) as Record<string, unknown>;
      const concepts = Array.isArray(output.requiredByConcepts) ? output.requiredByConcepts : [];
      const proofs = Array.isArray(output.requiredByProofs) ? output.requiredByProofs : [];
      if (concepts.includes(packageName) || proofs.includes(`${packageName}Proofs`)) dependents.push(candidateId);
    }
    return dependents.sort();
  }

  async writeFiles(args: {
    id: string;
    changes: ArchiveChanges;
    message: string;
    validateCurrent: (loaded: LoadedSubmission | undefined) => void | Promise<void>;
  }): Promise<string> {
    const changedNames = Object.keys(args.changes) as ArchiveFilename[];
    if (
      changedNames.length === 0 ||
      changedNames.some((name) => !ARCHIVE_FILENAMES.includes(name)) ||
      changedNames.some((name) => typeof args.changes[name] !== "string")
    ) {
      throw new ValidationError("publication must change one or more known Archive files");
    }
    // Different submissions publish concurrently. Rebuild from the latest
    // branch head and repeat every caller-supplied validation after each CAS race.
    const conflictAttempts = this.publicationGuard.conflictAttempts ?? 100;
    const conflictIntervalMs = this.publicationGuard.conflictIntervalMs ?? 250;
    for (let attempt = 1; attempt <= conflictAttempts; attempt += 1) {
      const currentSnapshot = await this.snapshot();
      const current = await this.load(args.id, currentSnapshot);
      await args.validateCurrent(current);
      const finalTexts = { ...(current?.texts ?? {}), ...args.changes };
      parseArchiveFiles(args.id, finalTexts);
      const parent = await this.github.request<GitCommit>(
        "GET",
        `${this.base}/git/commits/${currentSnapshot.sha}`,
      );
      const entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
      for (const name of changedNames) {
        const blob = await this.github.request<{ sha: string }>("POST", `${this.base}/git/blobs`, {
          content: Buffer.from(args.changes[name]!, "utf8").toString("base64"),
          encoding: "base64",
        });
        entries.push({ path: `${args.id}/${name}`, mode: "100644", type: "blob", sha: blob.sha });
      }
      const tree = await this.github.request<{ sha: string }>("POST", `${this.base}/git/trees`, {
        base_tree: parent.tree.sha,
        tree: entries,
      });
      const commit = await this.github.request<{ sha: string }>("POST", `${this.base}/git/commits`, {
        message: args.message,
        tree: tree.sha,
        parents: [currentSnapshot.sha],
      });
      const publicationBranch = `lax-publish/${commit.sha}`;
      await this.github.request("POST", `${this.base}/git/refs`, {
        ref: `refs/heads/${publicationBranch}`,
        sha: commit.sha,
      });
      try {
        const advanced = await this.advanceProtectedBranch(currentSnapshot, commit.sha);
        if (advanced) return commit.sha;
        if (attempt === conflictAttempts) {
          throw new Error(`lax-database changed during ${conflictAttempts} publication attempts`);
        }
      } finally {
        try {
          await this.github.request(
            "DELETE",
            `${this.base}/git/refs/heads/${encodeURIComponent(publicationBranch)}`,
          );
        } catch {
          // A stale staging ref cannot change the protected default branch, and
          // cleanup failure must not obscure a successfully published commit.
        }
      }
      await delay(conflictIntervalMs * Math.min(attempt, 8));
    }
    throw new Error("unreachable publication retry state");
  }

  private async advanceProtectedBranch(snapshot: ArchiveSnapshot, commitSha: string): Promise<boolean> {
    const attempts = this.publicationGuard.attempts ?? 60;
    const intervalMs = this.publicationGuard.intervalMs ?? 5_000;
    let guardError: GitHubError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.github.request(
          "PATCH",
          `${this.base}/git/refs/heads/${encodeURIComponent(snapshot.branch)}`,
          { sha: commitSha, force: false },
        );
        return true;
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 422) throw error;
        guardError = error;
      }
      const current = await this.github.request<GitRef>(
        "GET",
        `${this.base}/git/ref/heads/${encodeURIComponent(snapshot.branch)}`,
      );
      if (current.object.sha !== snapshot.sha) return false;
      if (attempt < attempts) await delay(intervalMs);
    }
    throw new GitHubError(
      "lax-database publication guard did not permit the candidate commit",
      422,
      guardError?.responseBody,
    );
  }

  private async rootEntry(id: string, commitSha: string): Promise<GitTreeEntry | undefined> {
    const commit = await this.github.request<GitCommit>("GET", `${this.base}/git/commits/${commitSha}`);
    const root = await this.github.request<GitTree>("GET", `${this.base}/git/trees/${commit.tree.sha}`);
    if (root.truncated) throw new ValidationError("lax-database root tree listing is truncated");
    return root.tree.find((entry) => entry.path === id);
  }
}

function decodeBase64(value: string): string {
  return decodeUtf8(Buffer.from(value.replace(/\s/gu, ""), "base64"));
}

export function samePreconditions(
  current: FilePreconditions,
  expected: FilePreconditions,
  relevant: Array<keyof FilePreconditions>,
): boolean {
  return relevant.every((key) => current[key] === expected[key]);
}
