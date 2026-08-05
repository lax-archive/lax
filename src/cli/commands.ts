import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTROL_REPOSITORY,
  githubOauthBase,
  HANDLE_PATTERN,
  SUBMISSION_ID_PATTERN,
} from "../shared/constants.js";
import { GitHubClient, GitHubError, repositoryPath } from "../shared/github.js";
import {
  normalizeSubmissionId,
  normalizeTitle,
  validateCommit,
  validateFolder,
  validateRepositoryUrl,
} from "../shared/validation.js";
import type { GitHubIdentity } from "../shared/types.js";
import { checkDeleteLocally } from "./archive-preflight.js";
import { githubAppUserToken } from "./auth.js";
import { buildSubmission, hasCurrentLocalBuild } from "./build.js";
import { confirmTyped } from "./confirm.js";
import { databaseDirectory, tryRefreshDatabase } from "./database.js";
import { installHint, toolVersion } from "./doctor.js";
import { followCommand, followInitialization, WorkflowOutcomeError } from "./follow.js";
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
  console.log(`Opening the submission issue on ${CONTROL_REPOSITORY}.`);
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
  console.log(`Resolving ${handles.length} GitHub handle${handles.length === 1 ? "" : "s"}.`);
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
  const issue = resolveIssueReference(reference);
  console.log(
    `Submitting lax-${issue} from (${source.repository}, ${source.commit}, ${source.folder}).`,
  );
  await withResumeHint(reference, () =>
    postCommand(issue, `/lax update ${JSON.stringify(source)}`));
}

export async function submitFolder(folder: string, allowDirty = false): Promise<void> {
  const root = path.resolve(folder);
  const issue = issueNumberFromFolder(root);
  console.log(`lax submit: preparing lax-${issue} in ${root}.`);
  const source = deriveSubmittedSource(root, allowDirty);
  await ensureBuiltForSubmit(root, source, allowDirty);
  console.log(
    `Submitting lax-${issue} from (${source.repository}, ${source.commit}, ${source.folder}).`,
  );
  await withResumeHint(folder, () => postCommand(issue, `/lax update ${JSON.stringify(source)}`));
}

/**
 * `lax submit --resume` — reattach to a submit whose CLI process lost its
 * connection (network, Ctrl-C). The durable job record is the Actions run, and
 * the run is correlated to the originating `/lax update` command comment by the
 * hidden markers follow.ts already matches. Correlation is therefore re-derived
 * from the issue's own comments rather than from anything this machine stored:
 * the CLI can die *before* it learns whether its POST created a comment, so a
 * remembered comment id would be exactly the thing that is missing.
 */
export async function resumeSubmit(target: string): Promise<void> {
  const issue = resolveIssueReference(target);
  console.log(`lax submit: resuming lax-${issue}; re-deriving the run from the issue.`);
  // The whole reattach is under the hint: losing the connection again while
  // re-deriving is as recoverable as losing it while following.
  await withResumeHint(target, async () => {
    const github = await client();
    const user = await github.request<{ id: number }>("GET", "/user");
    const comments = await github.paginate<{
      id: number;
      body: string | null;
      user: { id: number } | null;
    }>(`${base}/issues/${issue}/comments`);
    const command = [...comments]
      .reverse()
      .find((comment) =>
        comment.user?.id === user.id && comment.body?.startsWith("/lax update ") === true);
    if (command === undefined) {
      throw new NothingToResumeError(
        `no submit command of yours is on lax-${issue}; nothing is running — run \`lax submit\` instead`,
      );
    }
    console.log(
      "Reattaching to " +
        `${githubOauthBase()}/${CONTROL_REPOSITORY}/issues/${issue}#issuecomment-${command.id}`,
    );
    await followCommand(github, issue, command.id);
  });
}

/** Resume found no submit to reattach to — rerunning it would say the same. */
class NothingToResumeError extends Error {}

/** The exact command that reattaches to the run this submit started. */
function resumeCommand(target: string): string {
  return path.resolve(target) === path.resolve(".")
    ? "lax submit --resume"
    : `lax submit --resume ${target}`;
}

/**
 * A GitHub HTTP status is an authoritative answer and a finished-workflow error
 * is final; anything else (transport failure, timeout) leaves the Actions run
 * going, so hand the author the exact recovery command — as old lax did with
 * its job ids.
 */
async function withResumeHint<T>(target: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      !(error instanceof GitHubError) &&
      !(error instanceof WorkflowOutcomeError) &&
      !(error instanceof NothingToResumeError)
    ) {
      console.error("lax submit: lost contact with GitHub; the workflow run may still be going");
      console.error(`lax submit: reattach with: ${resumeCommand(target)}`);
    }
    throw error;
  }
}

export async function requestDelete(reference: string, yes = false): Promise<number> {
  const issue = resolveIssueReference(reference);
  const id = `lax-${issue}`;
  console.log(`lax delete: checking ${id} against a refreshed local lax-database.`);
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
  console.log("lax submit: refreshing the local lax-database checkout.");
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
  // the local build runs on the host toolchain — no docker involved
  const missingTools = ["elan", "lake", "git"].filter((tool) => toolVersion(tool) === undefined);
  if (missingTools.length > 0) {
    throw new Error(
      "the required local build needs " +
        missingTools.map((tool) => `${tool} (${installHint(tool)})`).join(", "),
    );
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
  console.log(`lax register: sending the registration command for ${id}.`);
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
  if (SUBMISSION_ID_PATTERN.test(value) || /^Lax[1-9][0-9]*$/u.test(value))
    return Number(normalizeSubmissionId(value).slice("lax-".length));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("issue must be a number, lax-N/LaxN id, or authoritative GitHub issue URL");
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
