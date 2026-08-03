import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTROL_REPOSITORY,
  HANDLE_PATTERN,
  SUBMISSION_ID_PATTERN,
} from "../shared/constants.js";
import { GitHubClient, repositoryPath } from "../shared/github.js";
import { normalizeTitle, validateCommit, validateFolder, validateRepositoryUrl } from "../shared/validation.js";
import type { GitHubIdentity } from "../shared/types.js";
import { checkDeleteLocally } from "./archive-preflight.js";
import { githubAppUserToken } from "./auth.js";
import { buildSubmission, hasCurrentLocalBuild } from "./build.js";
import { confirmTyped } from "./confirm.js";
import { databaseDirectory, tryRefreshDatabase } from "./database.js";
import { installHint, toolVersion } from "./doctor.js";
import { followCommand, followInitialization } from "./follow.js";
import { deriveSubmittedSource, repositoryRoot } from "./git.js";
import { issueNumberFromFolder } from "./manifest.js";
import { ensureEmptyFolder, scaffoldSubmission } from "./scaffold.js";

const base = repositoryPath(CONTROL_REPOSITORY);

async function client(): Promise<GitHubClient> {
  return GitHubClient.forGitHubAppUser(await githubAppUserToken());
}

export async function createSubmission(titleInput: string): Promise<void> {
  await allocateSubmission(titleInput);
}

export async function initializeSubmission(folder: string, titleInput?: string): Promise<void> {
  const root = ensureEmptyFolder(folder);
  const title = titleInput ?? (path.basename(root) || "Untitled submission");
  const allocation = await allocateSubmission(title);
  scaffoldSubmission(root, allocation.issue, allocation.title, allocation.owner.handle);
  try {
    repositoryRoot(root);
  } catch {
    console.warn("warning: folder is not inside a git repository; `lax submit` will need one");
  }
  console.log(`Initialized ${allocation.id} in ${root}.`);
}

async function allocateSubmission(titleInput: string): Promise<{
  issue: number;
  id: string;
  title: string;
  owner: GitHubIdentity;
}> {
  const title = normalizeTitle(titleInput);
  const github = await client();
  const user = await github.request<{ id: number; login: string; type: string }>("GET", "/user");
  if (user.type !== "User") throw new Error("the authenticated GitHub identity is not a human user");
  const issue = await github.request<{ number: number; html_url: string }>("POST", `${base}/issues`, {
    title,
    body:
      "This issue is the control plane for one Lax submission. Keep it open and use `/lax` command comments through the CLI.",
  });
  console.log(`Allocated provisional id lax-${issue.number}: ${issue.html_url}`);
  console.log("Waiting for initialization to commit the three stub files.");
  await followInitialization(github, issue.number);
  return {
    issue: issue.number,
    id: `lax-${issue.number}`,
    title,
    owner: { githubId: user.id, handle: user.login },
  };
}

export async function replaceOwners(reference: string, handles: string[]): Promise<void> {
  if (handles.length === 0) throw new Error("--new-list requires at least one GitHub handle");
  const owners: GitHubIdentity[] = [];
  const seen = new Set<number>();
  const github = await client();
  for (const handle of handles) {
    if (!HANDLE_PATTERN.test(handle)) throw new Error(`invalid GitHub handle: ${handle}`);
    const user = await github.request<{ id: number; login: string; type: string }>(
      "GET",
      `/users/${encodeURIComponent(handle)}`,
    );
    if (user.type !== "User") throw new Error(`${handle} is not a human GitHub user`);
    if (seen.has(user.id)) throw new Error(`${handle} names a duplicate GitHub account`);
    seen.add(user.id);
    owners.push({ githubId: user.id, handle: user.login });
  }
  owners.sort((left, right) => left.githubId - right.githubId);
  await postCommand(resolveIssueReference(reference), `/lax owners ${JSON.stringify(owners)}`);
}

export async function requestUpdate(
  reference: string,
  repositoryInput: string,
  commitInput: string,
  folderInput: string,
): Promise<void> {
  const source = {
    repository: validateRepositoryUrl(repositoryInput),
    commit: validateCommit(commitInput),
    folder: validateFolder(folderInput),
  };
  await postCommand(resolveIssueReference(reference), `/lax update ${JSON.stringify(source)}`);
}

export async function submitFolder(folder: string, allowDirty = false): Promise<void> {
  const root = path.resolve(folder);
  const issue = issueNumberFromFolder(root);
  const source = deriveSubmittedSource(root, allowDirty);
  await ensureBuiltForSubmit(root, source, allowDirty);
  console.log(
    `Submitting lax-${issue} from (${source.repository}, ${source.commit}, ${source.folder}).`,
  );
  await postCommand(issue, `/lax update ${JSON.stringify(source)}`);
}

export async function requestDelete(reference: string, yes = false): Promise<number> {
  const issue = resolveIssueReference(reference);
  const id = `lax-${issue}`;
  const preflight = checkDeleteLocally(id, tryRefreshDatabase());
  if (preflight.warnings.length > 0) {
    console.warn(
      `lax delete: local preflight warnings:\n${preflight.warnings.map((warning) => `  - ${warning}`).join("\n")}`,
    );
  }
  if (preflight.refusal !== undefined) {
    throw new Error(`${preflight.refusal}; the issue command was not created`);
  }
  if (
    !yes &&
    !(await confirmTyped({
      expected: id,
      warning:
        `deleting ${id} is permanent: its content leaves the Archive and website, ` +
        "and the id is retired rather than reused",
      command: "lax delete",
    }))
  ) return 1;
  await postCommand(issue, "/lax delete");
  return 0;
}

async function ensureBuiltForSubmit(
  root: string,
  source: { repository: string; commit: string; folder: string },
  allowDirty: boolean,
): Promise<void> {
  const refresh = tryRefreshDatabase();
  if (refresh === "missing") {
    throw new Error(
      "a local lax-database checkout is required for pre-submit validation; run `lax update-db`",
    );
  }
  if (refresh === "failed") {
    console.warn(
      "lax submit: local lax-database could not be refreshed; validating against the existing checkout",
    );
  }
  const archiveSha = git(databaseDirectory(), ["rev-parse", "HEAD"]);
  if (!allowDirty && hasCurrentLocalBuild(root, source, archiveSha)) {
    console.log(`lax submit: reusing the current local build for ${source.commit.slice(0, 12)}`);
    return;
  }
  console.log(
    allowDirty
      ? "lax submit: validating committed HEAD in an isolated checkout"
      : "lax submit: no current local build found; running lax build first",
  );
  if (toolVersion("docker") === undefined) {
    throw new Error(`the required local build needs docker: ${installHint("docker")}`);
  }
  const result = allowDirty
    ? await buildCommittedTree(root, source.commit, source.folder)
    : await buildSubmission(root);
  if (result !== 0) throw new Error("local validation failed; the issue command was not created");
}

async function buildCommittedTree(root: string, commit: string, folder: string): Promise<number> {
  const repository = repositoryRoot(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lax-submit-build-"));
  const checkout = path.join(temporary, "checkout");
  try {
    execFileSync("git", ["-C", repository, "worktree", "add", "--quiet", "--detach", checkout, commit], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const submission = folder === "." ? checkout : path.join(checkout, ...folder.split("/"));
    return await buildSubmission(submission);
  } finally {
    try {
      execFileSync("git", ["-C", repository, "worktree", "remove", "--force", checkout], {
        stdio: "ignore",
      });
    } catch {
      // The temporary parent is still removed below.
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function requestRegistration(reference: string, yes = false): Promise<number> {
  const issue = resolveIssueReference(reference);
  const id = `lax-${issue}`;
  if (
    !yes &&
    !(await confirmTyped({
      expected: id,
      warning: `registering ${id} is permanent and makes the Archive record immutable`,
      command: "lax register",
    }))
  ) return 1;
  await postCommand(issue, "/lax register");
  return 0;
}

async function postCommand(reference: string | number, body: string): Promise<void> {
  const issue = typeof reference === "number" ? reference : parseIssueReference(reference);
  const github = await client();
  const comment = await github.request<{ id: number; html_url: string }>(
    "POST",
    `${base}/issues/${issue}/comments`,
    { body },
  );
  console.log(`Command submitted: ${comment.html_url}`);
  await followCommand(github, issue, comment.id, body.startsWith("/lax owners "));
}

/** Issue commands also accept a submission folder containing manifest.yaml. */
export function resolveIssueReference(value: string): number {
  const candidate = path.resolve(value);
  try {
    if (fs.statSync(candidate).isDirectory()) return issueNumberFromFolder(candidate);
  } catch {
    // It is an issue reference, not a local folder.
  }
  return parseIssueReference(value);
}

export function parseIssueReference(value: string): number {
  if (/^[1-9][0-9]*$/u.test(value)) return Number(value);
  if (SUBMISSION_ID_PATTERN.test(value)) return Number(value.slice("lax-".length));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("issue must be a number, lax-N id, or authoritative GitHub issue URL");
  }
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/u.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    match === null ||
    `${match[1]}/${match[2]}` !== CONTROL_REPOSITORY
  ) {
    throw new Error(`issue URL must belong to ${CONTROL_REPOSITORY}`);
  }
  return Number(match[3]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
