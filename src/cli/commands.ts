import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTROL_REPOSITORY,
  CONTROL_REPOSITORY_ID,
  HANDLE_PATTERN,
  LEGACY_SUBMISSION_IDS,
  MAX_OWNERS,
  NEW_SUBMISSION_ID_PATTERN,
  SUBMISSION_ID_PATTERN,
} from "../shared/constants.js";
import { ArchiveRepository } from "../shared/archive.js";
import { GitHubClient, GitHubError, repositoryPath } from "../shared/github.js";
import { issueReservationBody } from "../shared/issue-reservation.js";
import {
  isObject,
  normalizeSubmissionId,
  normalizeTitle,
  validateCommit,
  validateFolder,
  validateNewSubmissionId,
  validateRepositoryUrl,
} from "../shared/validation.js";
import type { GitHubIdentity, IssueBinding } from "../shared/types.js";
import { checkDeleteLocally } from "./archive-preflight.js";
import { githubAppUserToken } from "./auth.js";
import { buildSubmission, hasCurrentLocalBuild } from "./build.js";
import { confirmTyped } from "./confirm.js";
import { databaseDirectory, tryRefreshDatabase } from "./database.js";
import { installHint, toolVersion } from "./doctor.js";
import { followCommand, followInitialization } from "./follow.js";
import { deriveSubmittedSource, repositoryRoot } from "./git.js";
import {
  clearInitialOwners,
  readLocalSubmissionManifest,
  setInitialOwners,
  setManifestIssue,
} from "./manifest.js";
import { rekeySubmission } from "./rekey.js";
import { ensureEmptyFolder, scaffoldSubmission } from "./scaffold.js";
import { generateSubmissionId, validateScaffoldIdentity } from "./submission-id.js";

const base = repositoryPath(CONTROL_REPOSITORY);

async function client(): Promise<GitHubClient> {
  return GitHubClient.forGitHubAppUser(await githubAppUserToken());
}

export async function initializeSubmission(folder: string, titleInput?: string): Promise<void> {
  const root = ensureEmptyFolder(folder);
  const title = normalizeTitle(titleInput ?? (path.basename(root) || "Untitled submission"));
  const id = generateSubmissionId();
  scaffoldSubmission(root, id, title);
  try {
    repositoryRoot(root);
  } catch {
    console.warn("warning: folder is not inside a git repository; `lax submit` will need one");
  }
  console.log(`Initialized ${id} in ${root}; no GitHub login or issue was needed.`);
}

export async function replaceOwners(reference: string, handles: string[]): Promise<void> {
  if (handles.length === 0) throw new Error("--new-list requires at least one GitHub handle");
  if (handles.length > MAX_OWNERS) throw new Error(`--new-list accepts at most ${MAX_OWNERS} handles`);
  const local = localFolder(reference);
  if (local !== undefined) {
    const manifest = readLocalSubmissionManifest(local);
    if (manifest.issue === undefined && legacyIssueBinding(manifest.id) === undefined) {
      const checked = await checkLocalOwnerHandles(handles);
      setInitialOwners(local, checked);
      console.log(
        `Stored ${checked.length} provisional owner${checked.length === 1 ? "" : "s"} in ${manifest.filename}. ` +
          "They will be authenticated and synchronized on the first `lax update`.",
      );
      return;
    }
  }
  const github = await client();
  const target = resolveSubmissionReference(reference);
  await verifyArchiveBinding(github, target);
  const owners = await resolveOwnerHandles(github, handles);
  await postCommand(github, target, `/lax owners ${target.id} ${JSON.stringify(owners)}`);
  await verifyOwnerList(github, target, owners);
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
  const github = await client();
  const local = localFolder(reference);
  if (local !== undefined && await prepareLocalSubmission(local, github)) return;
  const target = resolveSubmissionReference(reference);
  await verifyArchiveBinding(github, target);
  await postCommand(github, target, `/lax update ${target.id} ${JSON.stringify(source)}`);
}

export async function submitFolder(folder: string, allowDirty = false): Promise<void> {
  const root = path.resolve(folder);
  const source = deriveSubmittedSource(root, allowDirty);
  await ensureBuiltForSubmit(root, source, allowDirty);
  const github = await client();
  if (await prepareLocalSubmission(root, github)) return;
  const target = resolveSubmissionReference(root);
  console.log(
    `Submitting ${target.id} from (${source.repository}, ${source.commit}, ${source.folder}).`,
  );
  await verifyArchiveBinding(github, target);
  await postCommand(github, target, `/lax update ${target.id} ${JSON.stringify(source)}`);
}

export async function requestDelete(reference: string, yes = false): Promise<number> {
  const target = resolveSubmissionReference(reference);
  const { id } = target;
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
  const github = await client();
  await verifyArchiveBinding(github, target);
  await postCommand(github, target, `/lax delete ${id}`);
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
  const target = resolveSubmissionReference(reference);
  const { id } = target;
  if (
    !yes &&
    !(await confirmTyped({
      expected: id,
      warning: `registering ${id} is permanent and makes the Archive record immutable`,
      command: "lax register",
    }))
  ) return 1;
  const github = await client();
  await verifyArchiveBinding(github, target);
  await postCommand(github, target, `/lax register ${id}`);
  return 0;
}

async function postCommand(
  github: GitHubClient,
  reference: SubmissionReference,
  body: string,
): Promise<void> {
  const issue = reference.issue.number;
  const comment = await github.request<{ id: number; html_url: string; created_at: string }>(
    "POST",
    `${base}/issues/${issue}/comments`,
    { body },
  );
  const createdAt = githubTimestamp(comment.created_at, "command comment");
  console.log(`Command submitted: ${comment.html_url}`);
  await followCommand(github, issue, comment.id, body.startsWith("/lax owners "), createdAt);
}

/** Issue-only compatibility helper; new random ids resolve through the local database. */
export function resolveIssueReference(value: string): number {
  return resolveSubmissionReference(value).issue.number;
}

export function parseIssueReference(value: string): number {
  if (/^[1-9][0-9]*$/u.test(value)) return Number(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("issue must be a number or authoritative GitHub issue URL");
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

interface SubmissionReference {
  id: string;
  issue: IssueBinding;
}

function resolveSubmissionReference(value: string): SubmissionReference {
  const local = localFolder(value);
  if (local !== undefined) {
    const manifest = readLocalSubmissionManifest(local);
    if (manifest.issue === undefined) {
      const issue = legacyIssueBinding(manifest.id);
      if (issue !== undefined) return { id: manifest.id, issue };
      throw new Error(`${manifest.filename} has no issue binding; run \`lax update\` for this folder first`);
    }
    return { id: manifest.id, issue: manifest.issue };
  }
  if (SUBMISSION_ID_PATTERN.test(value) || /^Lax[1-9][0-9]*$/u.test(value)) {
    const id = normalizeSubmissionId(value);
    const fromDatabase = bindingFromLocalDatabase(id);
    if (fromDatabase !== undefined) return { id, issue: fromDatabase };
    if (!NEW_SUBMISSION_ID_PATTERN.test(id)) {
      return {
        id,
        issue: { repositoryId: CONTROL_REPOSITORY_ID, number: Number(id.slice("lax-".length)) },
      };
    }
    throw new Error(
      `${id} is not in the local lax-database; use its submission folder or run \`lax update-db\``,
    );
  }
  const issue = parseIssueReference(value);
  return {
    id: `lax-${issue}`,
    issue: { repositoryId: CONTROL_REPOSITORY_ID, number: issue },
  };
}

function localFolder(value: string): string | undefined {
  const candidate = path.resolve(value);
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function bindingFromLocalDatabase(id: string): IssueBinding | undefined {
  const filename = path.join(databaseDirectory(), id, "build-output.json");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.id !== id ||
    !isObject(value.issue) ||
    value.issue.repositoryId !== CONTROL_REPOSITORY_ID ||
    !Number.isSafeInteger(value.issue.number) ||
    (value.issue.number as number) <= 0
  ) throw new Error(`${filename} has an invalid issue binding`);
  return { repositoryId: CONTROL_REPOSITORY_ID, number: value.issue.number as number };
}

export async function prepareLocalSubmission(rootInput: string, github: GitHubClient): Promise<boolean> {
  const root = path.resolve(rootInput);
  let manifest = readLocalSubmissionManifest(root);
  if (manifest.issue !== undefined) {
    if (NEW_SUBMISSION_ID_PATTERN.test(manifest.id)) validateScaffoldIdentity(root, manifest.id);
    await verifyArchiveBinding(github, { id: manifest.id, issue: manifest.issue });
    if (manifest.initialOwners.length === 0) return false;
    await synchronizeInitialOwners(root, github);
    console.log("Provisional owners were synchronized. Commit manifest.yaml, then run the update again.");
    return true;
  }

  const legacyIssue = legacyIssueBinding(manifest.id);
  if (legacyIssue !== undefined) {
    await verifyArchiveBinding(github, { id: manifest.id, issue: legacyIssue });
    setManifestIssue(root, legacyIssue);
    if (manifest.initialOwners.length > 0) await synchronizeInitialOwners(root, github);
    console.log(
      `Recorded the legacy issue binding for ${manifest.id}. Commit manifest.yaml, then run the update again.`,
    );
    return true;
  }

  validateNewSubmissionId(manifest.id);
  validateScaffoldIdentity(root, manifest.id);
  const actor = await currentUser(github);
  // Resolve provisional users before allocating an issue, so a typo cannot
  // leave behind a needless control-plane issue.
  const pendingOwners = await resolveOwnerHandles(github, [actor.handle, ...manifest.initialOwners]);
  const archive = new ArchiveRepository(github);
  const snapshot = await archive.snapshot();
  if (await archive.exists(manifest.id, snapshot)) {
    const replacement = await unusedSubmissionId(archive);
    rekeySubmission(root, manifest.id, replacement);
    console.warn(
      `warning: ${manifest.id} already exists in lax-database; rekeyed the local submission to ${replacement}.`,
    );
    console.log("Review and commit the rekeyed files, then run the update again.");
    return true;
  }

  const issue = await github.request<{ number: number; html_url: string; created_at: string }>("POST", `${base}/issues`, {
    title: normalizeTitle(manifest.title),
    body: issueReservationBody(manifest.id),
  });
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0 || typeof issue.html_url !== "string") {
    throw new Error("GitHub returned an invalid issue allocation response");
  }
  const createdAt = githubTimestamp(issue.created_at, "control-plane issue");
  const binding = { repositoryId: CONTROL_REPOSITORY_ID, number: issue.number };
  // Persist immediately: if polling is interrupted, the next invocation can
  // inspect the authoritative Archive binding instead of creating another issue.
  try {
    setManifestIssue(root, binding);
  } catch (error) {
    throw new Error(
      `created ${issue.html_url}, but could not record its binding in manifest.yaml: ` +
        `${(error as Error).message}. Add issue.repositoryId=${binding.repositoryId} and ` +
        `issue.number=${binding.number} before retrying`,
    );
  }
  console.log(`Created the control-plane issue for ${manifest.id}: ${issue.html_url}`);
  console.log("Waiting for initialization to reserve the id in lax-database.");
  await followInitialization(github, issue.number, createdAt);

  const loaded = await archive.load(manifest.id);
  if (
    loaded === undefined ||
    loaded.files.buildOutput.issue.repositoryId !== binding.repositoryId ||
    loaded.files.buildOutput.issue.number !== binding.number
  ) {
    const replacement = await unusedSubmissionId(archive);
    rekeySubmission(root, manifest.id, replacement);
    console.warn(
      `warning: issue #${issue.number} did not reserve ${manifest.id}; rekeyed locally to ${replacement}.`,
    );
    console.log("Review and commit the rekeyed files, then run the update again.");
    return true;
  }

  manifest = readLocalSubmissionManifest(root);
  if (manifest.initialOwners.length > 0) {
    await postCommand(
      github,
      { id: manifest.id, issue: binding },
      `/lax owners ${manifest.id} ${JSON.stringify(pendingOwners)}`,
    );
    await verifyOwnerList(github, { id: manifest.id, issue: binding }, pendingOwners);
    clearInitialOwners(root);
  }
  console.log(
    `Reserved ${manifest.id}. Commit the issue binding in manifest.yaml, push it, then run the update again.`,
  );
  return true;
}

async function synchronizeInitialOwners(root: string, github: GitHubClient): Promise<void> {
  const manifest = readLocalSubmissionManifest(root);
  if (manifest.issue === undefined || manifest.initialOwners.length === 0) return;
  const actor = await currentUser(github);
  const owners = await resolveOwnerHandles(github, [actor.handle, ...manifest.initialOwners]);
  await postCommand(
    github,
    { id: manifest.id, issue: manifest.issue },
    `/lax owners ${manifest.id} ${JSON.stringify(owners)}`,
  );
  await verifyOwnerList(github, { id: manifest.id, issue: manifest.issue }, owners);
  clearInitialOwners(root);
}

function githubTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)) {
    throw new Error(`GitHub returned an invalid ${label} timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString().replace(".000Z", "Z") !== value) {
    throw new Error(`GitHub returned an invalid ${label} timestamp`);
  }
  return value;
}

async function currentUser(github: GitHubClient): Promise<GitHubIdentity> {
  const user = await github.request<{ id: number; login: string; type: string }>("GET", "/user");
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || !HANDLE_PATTERN.test(user.login) || user.type !== "User") {
    throw new Error("the authenticated GitHub identity is not a human user");
  }
  return { githubId: user.id, handle: user.login };
}

async function resolveOwnerHandles(github: GitHubClient, handles: string[]): Promise<GitHubIdentity[]> {
  const owners: GitHubIdentity[] = [];
  const seen = new Set<number>();
  for (const handle of uniqueHandles(handles)) {
    const user = await github.request<{ id: number; login: string; type: string }>(
      "GET",
      `/users/${encodeURIComponent(handle)}`,
    );
    if (user.type !== "User") throw new Error(`${handle} is not a human GitHub user`);
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || !HANDLE_PATTERN.test(user.login)) {
      throw new Error(`GitHub returned an invalid identity for ${handle}`);
    }
    if (seen.has(user.id)) throw new Error(`${handle} names a duplicate GitHub account`);
    seen.add(user.id);
    owners.push({ githubId: user.id, handle: user.login });
  }
  owners.sort((left, right) => left.githubId - right.githubId);
  return owners;
}

async function checkLocalOwnerHandles(handles: string[]): Promise<string[]> {
  const github = new GitHubClient();
  const checked: string[] = [];
  const seenIds = new Set<number>();
  for (const handle of uniqueHandles(handles)) {
    try {
      const user = await github.request<{ id: number; login: string; type: string }>(
        "GET",
        `/users/${encodeURIComponent(handle)}`,
      );
      if (user.type !== "User") throw new Error(`${handle} is not a human GitHub user`);
      if (!Number.isSafeInteger(user.id) || user.id <= 0 || !HANDLE_PATTERN.test(user.login)) {
        throw new Error(`GitHub returned an invalid identity for ${handle}`);
      }
      if (seenIds.has(user.id)) throw new Error(`${handle} names a duplicate GitHub account`);
      seenIds.add(user.id);
      checked.push(user.login);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        throw new Error(`${handle} is not a GitHub user`);
      }
      if (!(error instanceof GitHubError) && !String((error as Error).message).startsWith("GitHub request failed:")) {
        throw error;
      }
      console.warn(
        `warning: could not verify GitHub user ${handle} without login; keeping it for authenticated verification on the first update`,
      );
      checked.push(handle);
    }
  }
  return checked;
}

function uniqueHandles(handles: string[]): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const handle of handles) {
    if (!HANDLE_PATTERN.test(handle)) throw new Error(`invalid GitHub handle: ${handle}`);
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(handle);
  }
  if (values.length > MAX_OWNERS) throw new Error(`owner list may contain at most ${MAX_OWNERS} users`);
  return values;
}

async function verifyArchiveBinding(github: GitHubClient, reference: SubmissionReference): Promise<void> {
  const loaded = await new ArchiveRepository(github).load(reference.id);
  if (loaded === undefined) throw new Error(`${reference.id} does not exist in lax-database`);
  if (
    loaded.files.buildOutput.issue.repositoryId !== reference.issue.repositoryId ||
    loaded.files.buildOutput.issue.number !== reference.issue.number
  ) throw new Error(`${reference.id} is not bound to issue #${reference.issue.number}`);
}

function legacyIssueBinding(id: string): IssueBinding | undefined {
  if (!LEGACY_SUBMISSION_IDS.has(id)) return undefined;
  return {
    repositoryId: CONTROL_REPOSITORY_ID,
    number: Number(id.slice("lax-".length)),
  };
}

async function verifyOwnerList(
  github: GitHubClient,
  reference: SubmissionReference,
  expected: GitHubIdentity[],
): Promise<void> {
  const loaded = await new ArchiveRepository(github).load(reference.id);
  if (loaded === undefined) throw new Error(`${reference.id} disappeared while synchronizing owners`);
  if (
    loaded.files.buildOutput.issue.repositoryId !== reference.issue.repositoryId ||
    loaded.files.buildOutput.issue.number !== reference.issue.number
  ) throw new Error(`${reference.id} changed its issue binding while synchronizing owners`);
  const actualIds = loaded.files.ownerList.owners.map((owner) => owner.githubId).sort((left, right) => left - right);
  const expectedIds = expected.map((owner) => owner.githubId).sort((left, right) => left - right);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error("the provisional owner list was not committed; it remains in manifest.yaml for retry");
  }
}

async function unusedSubmissionId(archive: ArchiveRepository): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = generateSubmissionId();
    const snapshot = await archive.snapshot();
    if (!await archive.exists(id, snapshot)) return id;
  }
  throw new Error("could not generate an unused six-digit submission id after 100 attempts");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
