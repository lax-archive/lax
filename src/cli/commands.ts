import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTROL_REPOSITORY,
  githubOauthBase,
  HANDLE_PATTERN,
  SUBMISSION_ID_PATTERN,
  submissionUrl,
} from "../shared/constants.js";
import { GitHubClient, GitHubError, repositoryPath } from "../shared/github.js";
import {
  normalizeSubmissionId,
  normalizeTitle,
  validateCommit,
  validateFolder,
  validateRepositoryUrl,
} from "../shared/validation.js";
import type { GitHubIdentity, SourceLocation } from "../shared/types.js";
import type { ValidationFinding } from "../submission-validation/contracts.js";
import { checkDeleteLocally, checkRegisterLocally } from "./archive-preflight.js";
import { AuthenticationError, ensureLoggedIn, githubAppUserToken } from "./auth.js";
import { buildSubmission, hasCurrentLocalBuild, showFindings } from "./build.js";
import { confirmTyped } from "./confirm.js";
import { databaseDirectory, tryRefreshDatabase } from "./database.js";
import { groupFindings } from "./findings.js";
import { installHint, toolVersion } from "./doctor.js";
import {
  CommandFailedError,
  followCommand,
  followInitialization,
  WorkflowOutcomeError,
  type FollowOptions,
  type FollowResult,
} from "./follow.js";
import { deriveSubmittedSource, repositoryRoot } from "./git.js";
import { issueNumberFromFolder } from "./manifest.js";
import { recordSubmission } from "./registry.js";
import { renderComment } from "./render.js";
import { ValidationReportUnavailableError } from "./run-artifacts.js";
import { ensureEmptyFolder, provisionScaffold, scaffoldSubmission } from "./scaffold.js";
import * as ui from "./ui.js";

const base = repositoryPath(CONTROL_REPOSITORY);

/**
 * What a row says before the archive has started on it.
 *
 * Not "waiting for the archive": the request is already there — the command
 * comment was posted before any of this was drawn — and a row that sounds like
 * the CLI is still trying to reach GitHub sends the author looking for a
 * network problem. What is pending is the archive *starting*, which is what a
 * queue is.
 */
const QUEUED = "queued";

async function client(): Promise<GitHubClient> {
  return GitHubClient.forGitHubAppUser(await githubAppUserToken());
}

export async function initializeSubmission(folder: string, titleInput?: string): Promise<void> {
  const root = ensureEmptyFolder(folder);
  // No title given means the folder name stands in for one — which is a thing
  // the author will want to fix, so the identity block says so once.
  const defaulted = titleInput === undefined;
  const title = normalizeTitle(titleInput ?? (path.basename(root) || "Untitled submission"));
  const notes = new ui.Notes();

  ui.title("Creating a submission");
  const steps = new ui.Steps();
  steps.add("account", "Signing in");
  steps.add("reserve", "Reserving an id");
  steps.add("files", "Creating the files");
  steps.add("mathlib", "Preparing mathlib");
  try {
    const github = await client();
    const user = await github.request<{ id: number; login: string; type: string }>("GET", "/user");
    if (user.type !== "User") throw new Error("the authenticated GitHub identity is not a human user");
    steps.settle("account", { label: `Signed in as ${user.login}` });

    const issue = await github.request<{ number: number; html_url: string }>("POST", `${base}/issues`, {
      title,
      body:
        "This issue is the control plane for one Lax submission. Keep it open and use `/lax` command comments through the CLI.",
    });
    ui.verbose(`submission issue: ${issue.html_url}`);
    const id = `lax-${issue.number}`;
    steps.relabel("reserve", `Reserving ${id}`);
    const result = await followInitialization(github, issue.number, {
      onStage: (stage) => {
        if (stage.row === "queued") steps.waiting("reserve", QUEUED);
        else steps.begin("reserve");
      },
    });
    if (result.outcome === "failure") {
      steps.settle("reserve", { status: "fail" });
      steps.settle("files", { hidden: true });
      steps.settle("mathlib", { hidden: true });
      steps.finish();
      ui.problem(`the archive refused to create ${id}`, renderComment(result.comment ?? "").split("\n"));
      throw new CommandFailedError(`${id} was not created`);
    }
    steps.settle("reserve", { label: `Reserved ${id}` });

    scaffoldSubmission(root, issue.number, title, user.login);
    recordSubmission(root);
    steps.settle("files", { label: "Created the files" });

    // Provision mathlib right away: a bare `lake build` straight after init
    // (agents do this) must replay the shared store, not clone mathlib.
    const provisioned = await provisionScaffold(root, issue.number);
    steps.settle("mathlib", {
      status: provisioned.ok ? "ok" : "warn",
      label: provisioned.ok ? "Prepared mathlib" : "Could not prepare mathlib",
    });
    if (!provisioned.ok) {
      notes.add(
        "The shared mathlib environment is not ready.",
        `Run ${ui.cmd("lax build")} before any direct ${ui.cmd("lake build")} — without it lake would`,
        "download and compile mathlib from scratch inside the submission.",
        ...(provisioned.reason === undefined ? [] : [ui.dim(provisioned.reason)]),
      );
    }
    try {
      repositoryRoot(root);
    } catch {
      notes.add(
        "This folder is not in a git repository yet.",
        `${ui.cmd("lax build")} and ${ui.cmd("lax submit")} both need one — run ${ui.cmd("git init")}, then push it to GitHub.`,
      );
    }
    steps.finish();

    ui.blank();
    ui.line(ui.bold(`${id} · ${title}`) + (defaulted ? ` ${ui.dim("(set title: in manifest.yaml)")}` : ""));
    ui.faint(ui.tilde(root));
    notes.print();
    ui.done();
  } finally {
    steps.finish();
  }
}

export async function replaceOwners(reference: string, handles: string[]): Promise<void> {
  if (handles.length === 0) throw new Error("--new-list requires at least one GitHub handle");
  const issue = resolveIssueReference(reference);
  const id = `lax-${issue}`;
  // Three seconds of work, so one row and no report.
  const steps = new ui.Steps();
  steps.add("owners", "Updating the owner list");
  try {
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
    await postCommand(issue, `/lax owners ${JSON.stringify(owners)}`, {
      acceptSuccessReaction: true,
      onStage: (stage) => {
        if (stage.row === "queued") steps.waiting("owners", QUEUED);
        else steps.begin("owners");
      },
    });
    steps.settle("owners", {
      label: `${id} is now owned by ${list(owners.map((owner) => owner.handle))}`,
      time: false,
    });
  } finally {
    steps.finish();
  }
  ui.done();
}

export async function submitExplicitSource(
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
  const id = `lax-${issue}`;
  ui.title(`Submitting ${id}`);
  const submit = new SubmitReport(id, { local: false });
  try {
    submit.steps.settle("account", { label: `Signed in as ${await ensureLoggedIn()}` });
    submit.steps.settle("source", {
      label: "Checked your source",
      detail: describeSource(source),
    });
    await withResumeHint(reference, () =>
      postCommand(issue, `/lax submit ${JSON.stringify(source)}`, submit.follow()));
    submit.succeed();
  } finally {
    submit.steps.finish();
  }
}

export async function submitFolder(
  folder: string,
  options: { allowDirty?: boolean; force?: boolean } = {},
): Promise<void> {
  const root = path.resolve(folder);
  const force = options.force ?? false;
  const issue = issueNumberFromFolder(root);
  const id = `lax-${issue}`;
  ui.title(`Submitting ${id}`);
  const submit = new SubmitReport(id, { local: !force });
  try {
    // Ahead of the local build, which is minutes of Lean: without a usable
    // login there is nothing to submit the result to, and the author should
    // learn that now rather than after the build.
    submit.steps.settle("account", { label: `Signed in as ${await ensureLoggedIn()}` });
    const source = deriveSubmittedSource(root, { allowDirty: options.allowDirty, force });
    submit.steps.settle("source", {
      label: "Checked your source",
      detail: describeSource(source),
    });
    if (force) {
      // Say it plainly rather than let a silent skip read as a passing check.
      submit.notes.add(
        "Skipping every local check — dirty worktree, pushed HEAD, and the build.",
        "The archive is the only verdict.",
      );
    } else {
      await checkLocally(submit, root, source, options.allowDirty ?? false);
    }
    await withResumeHint(folder, () =>
      postCommand(issue, `/lax submit ${JSON.stringify(source)}`, submit.follow()));
    submit.succeed();
  } finally {
    submit.steps.finish();
  }
}

/**
 * `lax submit --resume` — reattach to a submit whose CLI process lost its
 * connection (network, Ctrl-C). The durable job record is the Actions run, and
 * the run is correlated to the originating `/lax submit` command comment by the
 * hidden markers follow.ts already matches. Correlation is therefore re-derived
 * from the issue's own comments rather than from anything this machine stored:
 * the CLI can die *before* it learns whether its POST created a comment, so a
 * remembered comment id would be exactly the thing that is missing.
 */
export async function resumeSubmit(target: string): Promise<void> {
  const issue = resolveIssueReference(target);
  const id = `lax-${issue}`;
  ui.title(`Submitting ${id}`);
  ui.faint("Reattaching to the run already in progress.");
  const submit = new SubmitReport(id, { local: false, account: false, source: false });
  try {
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
          comment.user?.id === user.id && comment.body?.startsWith("/lax submit ") === true);
      if (command === undefined) {
        throw new NothingToResumeError(
          `no submit of yours is on ${id}; nothing is running — run \`lax submit\` instead`,
        );
      }
      ui.verbose(
        "reattaching to " +
          `${githubOauthBase()}/${CONTROL_REPOSITORY}/issues/${issue}#issuecomment-${command.id}`,
      );
      await followCommand(github, issue, command.id, submit.follow());
    });
    submit.succeed();
  } finally {
    submit.steps.finish();
  }
}

/**
 * The two rows a submit shares with every other submit — the archive
 * recompiling the submission on its own machine, and the archive writing the
 * result into the public record — plus the verdict they lead to.
 *
 * The labels name the work, not the ceremony around it: the two remote rows are
 * two different jobs doing two different things, and an author watching a
 * ten-minute wait is owed which one they are in. They live here rather than in
 * each of the three entry points because the bridge from the workflow's stages
 * to the author's rows is the fiddly part: a row must begin once, settle once,
 * and the failed-validation path has to end the command before the record
 * comment the workflow is still going to post.
 */
class SubmitReport {
  readonly steps = new ui.Steps();
  readonly notes = new ui.Notes();
  private archiveOpen = false;
  private archiveSettled = false;
  private publishOpen = false;

  constructor(
    private readonly id: string,
    rows: { local: boolean; account?: boolean; source?: boolean },
  ) {
    if (rows.account !== false) this.steps.add("account", "Signing in");
    if (rows.source !== false) this.steps.add("source", "Checking your source");
    if (rows.local) this.steps.add("local", "Building on your machine");
    this.steps.add("archive", "Rebuilding in the archive");
    this.steps.add("publish", "Writing the public record");
  }

  follow(): FollowOptions {
    return {
      onStage: (stage) => {
        if (stage.row === "queued") {
          this.steps.waiting("archive", QUEUED);
          return;
        }
        if (stage.row === "validate") {
          if (!this.archiveOpen) {
            this.archiveOpen = true;
            this.steps.begin("archive");
          }
          if (stage.detail !== undefined) this.steps.detail("archive", stage.detail);
          return;
        }
        this.settleArchive();
        if (!this.publishOpen) {
          this.publishOpen = true;
          this.steps.begin("publish");
        }
        if (stage.detail !== undefined) this.steps.detail("publish", stage.detail);
      },
      onValidationReport: (report) => {
        if (report.ok) {
          this.settleArchive();
          carryWarnings(this.notes, report.warnings);
          return;
        }
        this.steps.settle("archive", { status: "fail" });
        this.steps.settle("publish", { hidden: true });
        this.steps.finish();
        showFindings(report);
        ui.verdict(`${this.id} was not published`);
        ui.done();
        throw new CommandFailedError(`${this.id} did not pass the archive's checks`);
      },
    };
  }

  /**
   * A row that never got its own `begin()` has no honest duration: its clock is
   * still the one the whole command started on, so it says nothing rather than
   * attributing every earlier minute to itself. That happens whenever the run
   * had already moved past the row by the time this process looked — a resume,
   * or a workflow that finished between two polls.
   */
  private settleArchive(): void {
    if (this.archiveSettled) return;
    this.archiveSettled = true;
    this.steps.settle("archive", {
      label: "Rebuilt in the archive",
      ...(this.archiveOpen ? {} : { time: false as const }),
    });
  }

  succeed(): void {
    this.settleArchive();
    this.steps.settle("publish", {
      label: "Wrote the public record",
      ...(this.publishOpen ? {} : { time: false as const }),
    });
    this.steps.finish();
    ui.verdict(`${this.id} is a draft in the archive`);
    ui.link(submissionUrl(this.id));
    this.notes.print();
    ui.done();
  }
}

/** Warnings do not block anything, so they wait for the notes block. */
function carryWarnings(notes: ui.Notes, warnings: readonly ValidationFinding[]): void {
  const group = groupFindings(warnings, "warning");
  if (group !== undefined) notes.add(group.headline, ...group.body);
}

export async function requestDelete(reference: string, yes = false): Promise<number> {
  const issue = resolveIssueReference(reference);
  const id = `lax-${issue}`;
  ui.title(`Delete ${id}`);
  ui.line(`This is permanent. ${id} leaves the archive and the site, and its id is`);
  ui.line("retired — it will never be reused.");
  const preflight = checkDeleteLocally(id, tryRefreshDatabase());
  const notes = new ui.Notes();
  for (const warning of preflight.warnings) {
    notes.add(warning.text, ...(warning.fix === undefined ? [] : [warning.fix]));
  }
  notes.print();
  if (preflight.refusal !== undefined) {
    ui.blank();
    ui.problem(preflight.refusal, ["Nothing was sent to the archive."]);
    ui.done();
    return 1;
  }
  ui.blank();
  if (!yes && !(await confirmTyped({ expected: id, action: `deleting ${id}` }))) return 1;
  const steps = new ui.Steps();
  steps.add("delete", `Deleting ${id}`);
  try {
    await postCommand(issue, "/lax delete", {
      onPreview: (text) => ui.verbose(text),
      onStage: (stage) => {
        if (stage.row === "queued") steps.waiting("delete", QUEUED);
        else steps.begin("delete");
      },
    });
    steps.settle("delete", { label: "Deleted" });
  } finally {
    steps.finish();
  }
  ui.verdict(`${id} is gone.`);
  ui.done();
  return 0;
}

export async function requestRegistration(reference: string, yes = false): Promise<number> {
  const issue = resolveIssueReference(reference);
  const id = `lax-${issue}`;
  ui.title(`Register ${id}`);
  ui.line("Registering is permanent. The record becomes immutable and citable, and");
  ui.line("it can never be changed or removed.");
  const preflight = checkRegisterLocally(id, tryRefreshDatabase());
  const notes = new ui.Notes();
  for (const warning of preflight.warnings) {
    notes.add(warning.text, ...(warning.fix === undefined ? [] : [warning.fix]));
  }
  notes.print();
  if (preflight.refusal !== undefined) {
    ui.blank();
    ui.problem(preflight.refusal, ["Nothing was sent to the archive."]);
    ui.done();
    return 1;
  }
  ui.blank();
  if (!yes && !(await confirmTyped({ expected: id, action: `registering ${id}` }))) return 1;
  const steps = new ui.Steps();
  steps.add("register", `Registering ${id}`);
  try {
    await postCommand(issue, "/lax register", {
      // The control plane's echo of the request is dropped from the happy path:
      // the CLI ran the same preflight one second earlier and printed its
      // result. It reappears the moment the two disagree, which is the only
      // time it says anything.
      onPreview: (text) => ui.verbose(text),
      onStage: (stage) => {
        if (stage.row === "queued") steps.waiting("register", QUEUED);
        else steps.begin("register");
      },
    });
    steps.settle("register", { label: "Registered" });
  } finally {
    steps.finish();
  }
  ui.verdict(`${id} is registered`);
  ui.link(submissionUrl(id));
  ui.blank();
  // "Registered" and "citable" are the same sentence, and the citation is the
  // payoff — so the key the author will actually type is part of the answer.
  ui.aside("Cite", `\\cite{${id}}`);
  ui.done();
  return 0;
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
 * A GitHub HTTP status is an authoritative answer, a finished-workflow error is
 * final, a reported command failure is the workflow's own verdict, an
 * unreadable validation report already names its own recovery, and an
 * authentication failure happens strictly before the command comment is posted
 * — so none of them leaves a run behind unexplained. Anything else (transport
 * failure, timeout) does leave the Actions run going, so hand the author the
 * exact recovery command.
 */
async function withResumeHint<T>(target: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      !(error instanceof GitHubError) &&
      !(error instanceof WorkflowOutcomeError) &&
      !(error instanceof CommandFailedError) &&
      !(error instanceof NothingToResumeError) &&
      !(error instanceof ValidationReportUnavailableError) &&
      !(error instanceof AuthenticationError)
    ) {
      const notes = new ui.Notes();
      notes.add(
        "Lost contact with GitHub. The archive may still be working on this.",
        `Reattach with ${ui.cmd(resumeCommand(target))}`,
      );
      notes.print();
    }
    throw error;
  }
}

/**
 * The local half of a submit: refresh the archive copy, then reuse this
 * machine's current build or run one, reporting the build's own stage as the
 * row's detail rather than nesting a second step list under it.
 */
async function checkLocally(
  submit: SubmitReport,
  root: string,
  source: SourceLocation,
  allowDirty: boolean,
): Promise<void> {
  submit.steps.detail("local", "refreshing your copy of the archive");
  const refresh = tryRefreshDatabase();
  if (refresh === "missing") {
    throw new Error(
      `pre-submit checks need a local copy of the archive; run ${ui.cmd("lax sync")}`,
    );
  }
  if (refresh === "failed") {
    submit.notes.add(
      "Your copy of the archive could not be refreshed.",
      "The checks below ran against the copy you already had.",
    );
  }
  const archiveSha = git(databaseDirectory(), ["rev-parse", "HEAD"]);
  submit.steps.begin("local");
  if (!allowDirty && hasCurrentLocalBuild(root, source, archiveSha)) {
    submit.steps.settle("local", {
      label: "Built on your machine",
      detail: "reused your last build",
      time: false,
    });
    return;
  }
  // the local build runs on the host toolchain — no docker involved
  const missingTools = ["elan", "lake", "git"].filter((tool) => toolVersion(tool) === undefined);
  if (missingTools.length > 0) {
    throw new Error(
      "the required local build needs " +
        missingTools.map((tool) => `${tool} (${installHint(tool)})`).join(", "),
    );
  }
  const embed = (stage: string): void => submit.steps.detail("local", stage);
  const outcome = allowDirty
    ? await buildCommittedTree(root, source.commit, source.folder, embed)
    : await buildSubmission(root, { embed });
  if (!outcome.ok) {
    submit.steps.settle("local", { status: "fail" });
    submit.steps.settle("archive", { hidden: true });
    submit.steps.settle("publish", { hidden: true });
    submit.steps.finish();
    showFindings(outcome);
    ui.verdict("Nothing was sent to the archive");
    ui.done();
    throw new CommandFailedError("the local build failed");
  }
  submit.steps.settle("local", { label: "Built on your machine" });
  carryWarnings(submit.notes, outcome.warnings);
}

async function buildCommittedTree(
  root: string,
  commit: string,
  folder: string,
  embed: (stage: string) => void,
): Promise<Awaited<ReturnType<typeof buildSubmission>>> {
  const repository = repositoryRoot(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lax-submit-build-"));
  const checkout = path.join(temporary, "checkout");
  try {
    execFileSync("git", ["-C", repository, "worktree", "add", "--quiet", "--detach", checkout, commit], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const submission = folder === "." ? checkout : path.join(checkout, ...folder.split("/"));
    return await buildSubmission(submission, { embed });
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

async function postCommand(
  reference: string | number,
  body: string,
  options: FollowOptions = {},
): Promise<FollowResult> {
  const issue = typeof reference === "number" ? reference : parseIssueReference(reference);
  const github = await client();
  const comment = await github.request<{ id: number; html_url: string }>(
    "POST",
    `${base}/issues/${issue}/comments`,
    { body },
  );
  ui.verbose(`command posted: ${comment.html_url}`);
  const result = await followCommand(github, issue, comment.id, options);
  if (result.outcome === "failure") {
    ui.problem(
      `the archive refused this command`,
      renderComment(result.comment ?? "").split("\n"),
    );
    throw new CommandFailedError("the archive refused this command");
  }
  return result;
}

/** `jan/primes @ a1b2c3d`, which is what a developer reads without decoding. */
function describeSource(source: SourceLocation): string {
  const repository = source.repository.replace(/^https:\/\/github\.com\//u, "");
  const at = `${repository} @ ${source.commit.slice(0, 7)}`;
  return source.folder === "." ? at : `${at} · ${source.folder}`;
}

/** `alice`, `alice and bob`, `alice, bob and carol`. */
function list(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]!}`;
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
