import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTROL_REPOSITORY,
  CONTROL_REPOSITORY_ID,
  githubOauthBase,
  HANDLE_PATTERN,
  LEGACY_SUBMISSION_IDS,
  MAX_OWNERS,
  NEW_SUBMISSION_ID_PATTERN,
  PLACEHOLDER_SUBMISSION_ID,
  SUBMISSION_ID_PATTERN,
  submissionUrl,
} from "../shared/constants.js";
import { ArchiveRepository } from "../shared/archive.js";
import { GitHubClient, GitHubError, repositoryPath } from "../shared/github.js";
import { issueReservationBody } from "../shared/issue-reservation.js";
import {
  normalizeSubmissionId,
  normalizeTitle,
  isObject,
  validateCommit,
  validateFolder,
  validateNewSubmissionId,
  validateRepositoryUrl,
} from "../shared/validation.js";
import type { GitHubIdentity, IssueBinding, SourceLocation } from "../shared/types.js";
import type { ValidationFinding } from "../submission-validation/contracts.js";
import { checkDeleteLocally, checkRegisterLocally } from "./archive-preflight.js";
import { AuthenticationError, ensureLoggedIn, githubAppUserToken } from "./auth.js";
import {
  buildSubmission,
  hasCurrentLocalBuild,
  showFindings,
  showValidationFailure,
} from "./build.js";
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
import {
  clearInitialOwners,
  declaresPaper,
  readLocalSubmissionManifest,
  setInitialOwners,
  setManifestIssue,
} from "./manifest.js";
import { rekeySubmission } from "./rekey.js";
import { forgetSubmissionsById, recordSubmission } from "./registry.js";
import { renderComment } from "./render.js";
import {
  ValidationReportUnavailableError,
  type RemotePaperFacts,
} from "./run-artifacts.js";
import {
  ensureEmptyFolder,
  provisionScaffold,
  scaffoldSubmission,
} from "./scaffold.js";
import { generateSubmissionId, validateScaffoldIdentity } from "./submission-id.js";
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

export interface InitOptions {
  title?: string;
  /** Accepted temporarily for scripts written while loginless init was opt-in. */
  offline?: boolean;
}

export async function initializeSubmission(
  folder: string,
  options: InitOptions = {},
): Promise<void> {
  const root = ensureEmptyFolder(folder);
  // No title given means the folder name stands in for one — which is a thing
  // the author will want to fix, so the identity block says so once.
  const defaulted = options.title === undefined;
  const title = normalizeTitle(options.title ?? (path.basename(root) || "Untitled submission"));
  const id = generateSubmissionId();
  const notes = new ui.Notes();

  ui.title("Creating a submission");
  const steps = new ui.Steps();
  steps.add("files", "Creating the files");
  steps.add("mathlib", "Preparing mathlib");
  try {
    scaffoldSubmission(root, id, title);
    recordSubmission(root);
    steps.settle("files", { label: "Created the files" });

    // Provision mathlib right away: a bare `lake build` straight after init
    // (agents do this) must replay the shared store, not clone mathlib.
    const provisioned = await provisionScaffold(root, id);
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
    notes.add(
      "Nothing was sent to GitHub and no login was needed.",
      `${ui.cmd("lax submit")} will create and bind the control issue when the source is ready.`,
    );
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
  if (handles.length > MAX_OWNERS) throw new Error(`--new-list accepts at most ${MAX_OWNERS} handles`);
  const local = localFolder(reference);
  if (local !== undefined) {
    const manifest = readLocalSubmissionManifest(local);
    if (manifest.issue === undefined && legacyIssueBinding(manifest.id) === undefined) {
      const checked = await checkLocalOwnerHandles(handles);
      setInitialOwners(local, checked);
      ui.verdict(
        `Stored ${ui.plural(checked.length, "provisional owner")} for ${manifest.id}`,
      );
      ui.line("They will be authenticated and synchronized when the submission first creates its issue.");
      ui.done();
      return;
    }
  }
  const target = resolveSubmissionReference(reference);
  const { id } = target;
  // Three seconds of work, so one row and no report.
  const steps = new ui.Steps();
  steps.add("owners", "Updating the owner list");
  try {
    const github = await client();
    const owners = await resolveOwnerHandles(github, handles);
    await postCommand(github, target, `/lax owners ${id} ${JSON.stringify(owners)}`, {
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
  const local = localFolder(reference);
  if (local !== undefined && await prepareBeforeSubmit(local)) return;
  const target = resolveSubmissionReference(reference);
  const { id } = target;
  ui.title(`Submitting ${id}`);
  const submit = new SubmitReport(id, { local: false });
  try {
    submit.steps.settle("account", { label: `Signed in as ${await ensureLoggedIn()}` });
    const github = await client();
    submit.steps.settle("source", {
      label: "Checked your source",
      detail: describeSource(source),
    });
    await withResumeHint(reference, () =>
      postCommand(github, target, `/lax submit ${id} ${JSON.stringify(source)}`, submit.follow()));
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
  if (await prepareBeforeSubmit(root)) return;
  const target = resolveSubmissionReference(root);
  const { id } = target;
  ui.title(`Submitting ${id}`);
  // The paper row is declared from the manifest, as `lax build` declares
  // its own: even a forced submit knows up front whether the archive will
  // be compiling a paper.
  const submit = new SubmitReport(id, { local: !force, paper: declaresPaper(root) });
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
    const github = await client();
    await withResumeHint(folder, () =>
      postCommand(github, target, `/lax submit ${id} ${JSON.stringify(source)}`, submit.follow()));
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
  const reference = resolveSubmissionReference(target);
  const { id } = reference;
  const issue = reference.issue.number;
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
        created_at?: string;
        user: { id: number } | null;
      }>(`${base}/issues/${issue}/comments`);
      const command = [...comments]
        .reverse()
        .find((comment) =>
          comment.user?.id === user.id &&
          (comment.body?.startsWith(`/lax submit ${id} `) === true ||
            (id === `lax-${issue}` && comment.body?.startsWith("/lax submit ") === true)));
      if (command === undefined) {
        throw new NothingToResumeError(
          `no submit of yours is on ${id}; nothing is running — run \`lax submit\` instead`,
        );
      }
      ui.verbose(
        "reattaching to " +
          `${githubOauthBase()}/${CONTROL_REPOSITORY}/issues/${issue}#issuecomment-${command.id}`,
      );
      await followCommand(github, issue, command.id, {
        ...submit.follow(),
        ...(command.created_at === undefined ? {} : { since: command.created_at }),
      });
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
export class SubmitReport {
  readonly steps = new ui.Steps();
  readonly notes = new ui.Notes();
  /**
   * Every warning the submit collected — the local build's and the archive's
   * — rendered as one block at the end. Both runs check the same things
   * against the same archive, so most warnings arrive twice; `groupFindings`
   * already drops the duplicates, and one block is also one count.
   */
  private readonly warnings: ValidationFinding[] = [];
  /** Whether the step list carries a "Compiling the paper" row of its own —
   * declared only when the caller knows the manifest declares one. */
  readonly paperRow: boolean;
  private archiveOpen = false;
  private archiveSettled = false;
  private publishOpen = false;
  private paperRowSettled = false;
  /** The archive's paper facts, when the report carried them but no row was
   * declared for them (a resume, an explicit-source submit): `succeed()`
   * hands them to a closing aside instead. */
  private paperAside?: string;

  constructor(
    private readonly id: string,
    rows: { local: boolean; account?: boolean; source?: boolean; paper?: boolean },
  ) {
    this.paperRow = rows.paper === true;
    if (rows.account !== false) this.steps.add("account", "Signing in");
    if (rows.source !== false) this.steps.add("source", "Checking your source");
    if (rows.local) this.steps.add("local", "Building on your machine");
    this.steps.add("archive", "Rebuilding in the archive");
    // Between the archive rows, where the work happens: the paper compiles
    // inside the validate job, and its facts arrive with the report.
    if (this.paperRow) this.steps.add("paper", "Compiling the paper");
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
        // A report that never arrived (upload lag, a reattach past the
        // window) must not leave the paper row spinning under the publish
        // stage: no facts by now means no facts at all.
        this.settlePaperRow(undefined, []);
        if (!this.publishOpen) {
          this.publishOpen = true;
          this.steps.begin("publish");
        }
        if (stage.detail !== undefined) this.steps.detail("publish", stage.detail);
      },
      onValidationReport: (report) => {
        if (report.ok) {
          this.settleArchive();
          this.settlePaperRow(report.paper, report.warnings);
          this.carry(report.warnings);
          return;
        }
        this.steps.settle("archive", { status: "fail" });
        if (this.paperRow) this.steps.settle("paper", { hidden: true });
        this.steps.settle("publish", { hidden: true });
        this.steps.finish();
        if (report.failure !== undefined) showValidationFailure(report.failure);
        showFindings(report);
        ui.verdict(
          report.failure === undefined
            ? `${this.id} was not published`
            : `${this.id} could not be validated`,
        );
        ui.done();
        throw new CommandFailedError(
          report.failure === undefined
            ? `${this.id} did not pass the archive's checks`
            : `${this.id} did not receive a validation verdict`,
        );
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

  /**
   * Close the paper's part of the report with whatever the archive said.
   * With a declared row, the facts settle it in place — the row the local
   * build shows, now with the archive's numbers; without one, they wait for
   * `succeed()`'s aside. No facts hides a declared row rather than letting
   * it spin (its clock never honestly ran either way: the compile ran
   * inside the archive row, concurrent with the Lean chain).
   */
  private settlePaperRow(
    facts: RemotePaperFacts | undefined,
    warnings: readonly ValidationFinding[],
  ): void {
    const summary = facts === undefined ? undefined : paperSummary(facts, warnings);
    if (!this.paperRow) {
      if (summary !== undefined) this.paperAside = summary;
      return;
    }
    if (this.paperRowSettled) return;
    this.paperRowSettled = true;
    if (summary === undefined) {
      this.steps.settle("paper", { hidden: true });
      return;
    }
    this.steps.settle("paper", { label: "Compiled the paper", detail: summary, time: false });
  }

  /** Warnings do not block anything, so they wait for the notes block. */
  carry(warnings: readonly ValidationFinding[]): void {
    this.warnings.push(...warnings);
  }

  succeed(): void {
    this.settleArchive();
    this.settlePaperRow(undefined, []);
    this.steps.settle("publish", {
      label: "Wrote the public record",
      ...(this.publishOpen ? {} : { time: false as const }),
    });
    this.steps.finish();
    ui.verdict(`${this.id} is a draft in the archive`);
    ui.link(submissionUrl(this.id));
    if (this.paperAside !== undefined) ui.aside("Paper", this.paperAside);
    const warnings = groupFindings(this.warnings, "warning");
    if (warnings !== undefined) this.notes.add(warnings.headline, ...warnings.body);
    this.notes.print();
    ui.done();
  }
}

/**
 * The paper row's answer, in `lax build`'s vocabulary plus the web view's
 * fate: recorded (`paper.web`, with the bundle's size), skipped (a `web-*`
 * warning carries the reason into the notes), or — a manifest that opted
 * out — not mentioned at all, exactly as silent as the derivation was.
 */
export function paperSummary(
  facts: RemotePaperFacts,
  warnings: readonly ValidationFinding[],
): string {
  const counts = `${ui.plural(facts.pages, "page")} · ${ui.plural(facts.marks, "mark")}`;
  if (facts.webBytes !== undefined) {
    return `${counts} · web view derived (${(facts.webBytes / (1024 * 1024)).toFixed(1)} MiB)`;
  }
  const skipped = warnings.some((warning) => warning.rule.startsWith("web-"));
  return skipped ? `${counts} · web view skipped` : counts;
}

export async function requestDelete(reference: string, yes = false): Promise<number> {
  const target = resolveSubmissionReference(reference);
  const { id } = target;
  const issue = target.issue.number;
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
    const github = await client();
    await postCommand(github, target, `/lax delete ${id}`, {
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
  // The record is gone; tidy what pointed at it. The registry entry stops
  // `lax doctor` checking a folder for a submission that no longer exists,
  // and the tracking issue — which the trusted workflow leaves open, having
  // no issue-state writes of its own — has served its purpose: the id it
  // bound is retired for good. Both are the author's own tidiness, so a
  // failure here is a note, never a failed delete.
  for (const root of forgetSubmissionsById(id)) {
    ui.verbose(`forgot ${root} in the submission registry`);
  }
  const tidy = new ui.Notes();
  try {
    const github = await client();
    await github.request("PATCH", `${base}/issues/${issue}`, {
      state: "closed",
      state_reason: "completed",
    });
  } catch (error) {
    tidy.add(
      `The tracking issue could not be closed (${(error as Error).message}).`,
      `Close ${githubOauthBase()}/${CONTROL_REPOSITORY}/issues/${issue} yourself if you like.`,
    );
  }
  ui.verdict(`${id} is gone.`);
  tidy.print();
  ui.done();
  return 0;
}

export async function requestRegistration(reference: string, yes = false): Promise<number> {
  const target = resolveSubmissionReference(reference);
  const { id } = target;
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
    const github = await client();
    await postCommand(github, target, `/lax register ${id}`, {
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
    if (submit.paperRow) submit.steps.settle("paper", { hidden: true });
    submit.steps.settle("publish", { hidden: true });
    submit.steps.finish();
    if (outcome.failure !== undefined) showValidationFailure(outcome.failure);
    showFindings(outcome);
    ui.verdict("Nothing was sent to the archive");
    ui.done();
    throw new CommandFailedError("the local build failed");
  }
  submit.steps.settle("local", { label: "Built on your machine" });
  submit.carry(outcome.warnings);
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
  github: GitHubClient,
  reference: SubmissionReference,
  body: string,
  options: FollowOptions = {},
): Promise<FollowResult> {
  const issue = reference.issue.number;
  const comment = await github.request<{ id: number; html_url: string; created_at?: string }>(
    "POST",
    `${base}/issues/${issue}/comments`,
    { body },
  );
  ui.verbose(`command posted: ${comment.html_url}`);
  const result = await followCommand(github, issue, comment.id, {
    ...options,
    ...(comment.created_at === undefined ? {} : { since: comment.created_at }),
  });
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
      throw new Error(
        `${manifest.filename} has no issue binding; run ${ui.cmd("lax submit")} for this folder first`,
      );
    }
    return { id: manifest.id, issue: manifest.issue };
  }
  if (SUBMISSION_ID_PATTERN.test(value) || /^Lax[1-9][0-9]*$/u.test(value)) {
    const id = normalizeSubmissionId(value);
    const fromDatabase = bindingFromLocalDatabase(id);
    if (fromDatabase !== undefined) return { id, issue: fromDatabase };
    if (LEGACY_SUBMISSION_IDS.has(id)) {
      return {
        id,
        issue: {
          repositoryId: CONTROL_REPOSITORY_ID,
          number: Number(id.slice("lax-".length)),
        },
      };
    }
    throw new Error(
      `${id} is not in your local archive copy; use its submission folder or run ${ui.cmd("lax sync")}`,
    );
  }
  const issue = parseIssueReference(value);
  const legacyId = `lax-${issue}`;
  if (!LEGACY_SUBMISSION_IDS.has(legacyId)) {
    throw new Error(
      `issue #${issue} does not identify a legacy submission; use the submission folder or lax-N id`,
    );
  }
  return {
    id: legacyId,
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
    Object.keys(value.issue).sort().join(",") !== "number,repositoryId" ||
    value.issue.repositoryId !== CONTROL_REPOSITORY_ID ||
    !Number.isSafeInteger(value.issue.number) ||
    (value.issue.number as number) <= 0
  ) {
    throw new Error(`${filename} has an invalid issue binding`);
  }
  return { repositoryId: CONTROL_REPOSITORY_ID, number: value.issue.number as number };
}

/**
 * Bind an unbound local manifest, migrate a historical manifest, or synchronize
 * provisional owners. Returns true exactly when it changed manifest.yaml and
 * the caller must ask for a commit before it can submit immutable source.
 */
export async function prepareLocalSubmission(
  rootInput: string,
  github: GitHubClient,
  followOptions: FollowOptions = {},
): Promise<boolean> {
  const root = path.resolve(rootInput);
  let manifest = readLocalSubmissionManifest(root);
  const archive = new ArchiveRepository(github);

  if (manifest.id === PLACEHOLDER_SUBMISSION_ID) {
    validateScaffoldIdentity(root, manifest.id);
    const replacement = await unusedSubmissionId(archive, manifest.id);
    rekeySubmission(root, manifest.id, replacement);
    ui.verbose(`rekeyed the old ${PLACEHOLDER_SUBMISSION_ID} scaffold to ${replacement}`);
    return true;
  }

  if (manifest.issue !== undefined) {
    if (NEW_SUBMISSION_ID_PATTERN.test(manifest.id)) {
      validateScaffoldIdentity(root, manifest.id);
      const binding = await recoverArchiveBinding(
        archive,
        github,
        { id: manifest.id, issue: manifest.issue },
        followOptions,
      );
      if (binding === "mismatch") {
        const replacement = await unusedSubmissionId(archive, manifest.id);
        rekeySubmission(root, manifest.id, replacement);
        ui.verbose(
          `issue #${manifest.issue.number} did not reserve ${manifest.id}; rekeyed to ${replacement}`,
        );
        return true;
      }
      // The binding was written before polling began. A recovery therefore
      // still owes the normal commit-and-push stop, even though this retry did
      // not have to rewrite manifest.yaml itself.
      if (binding === "recovered" && manifest.initialOwners.length === 0) return true;
    } else {
      await verifyArchiveBinding(github, { id: manifest.id, issue: manifest.issue });
    }
    if (manifest.initialOwners.length === 0) return false;
    await synchronizeInitialOwners(root, github, followOptions);
    return true;
  }

  const legacyIssue = legacyIssueBinding(manifest.id);
  if (legacyIssue !== undefined) {
    await verifyArchiveBinding(github, { id: manifest.id, issue: legacyIssue });
    setManifestIssue(root, legacyIssue);
    if (manifest.initialOwners.length > 0) {
      await synchronizeInitialOwners(root, github, followOptions);
    }
    return true;
  }

  validateNewSubmissionId(manifest.id);
  validateScaffoldIdentity(root, manifest.id);
  if (manifest.title === undefined) {
    throw new Error(`${manifest.filename} must contain a non-empty title before its first submit`);
  }
  const actor = await currentUser(github);
  // Resolve every provisional owner before issue creation so a typo cannot
  // leave behind a needless control-plane issue.
  const pendingOwners = await resolveOwnerHandles(github, [actor.handle, ...manifest.initialOwners]);
  const snapshot = await archive.snapshot();
  if (await archive.exists(manifest.id, snapshot)) {
    const replacement = await unusedSubmissionId(archive, manifest.id);
    rekeySubmission(root, manifest.id, replacement);
    ui.verbose(`${manifest.id} already existed; rekeyed the local submission to ${replacement}`);
    return true;
  }

  const issue = await github.request<{ number: number; html_url: string; created_at?: string }>(
    "POST",
    `${base}/issues`,
    { title: normalizeTitle(manifest.title), body: issueReservationBody(manifest.id) },
  );
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.number <= 0 ||
    typeof issue.html_url !== "string" ||
    issue.html_url === ""
  ) {
    throw new Error("GitHub returned an invalid issue allocation response");
  }
  const binding = { repositoryId: CONTROL_REPOSITORY_ID, number: issue.number };
  // Persist immediately. If polling is interrupted, retrying will inspect this
  // authoritative binding instead of creating a second issue.
  try {
    setManifestIssue(root, binding);
  } catch (error) {
    throw new Error(
      `created ${issue.html_url}, but could not record its binding in manifest.yaml: ` +
        `${(error as Error).message}. Add issue.repositoryId=${binding.repositoryId} and ` +
        `issue.number=${binding.number} before retrying`,
    );
  }
  ui.verbose(`control issue: ${issue.html_url}`);
  const result = await followInitialization(github, issue.number, {
    ...followOptions,
    ...(issue.created_at === undefined ? {} : { since: issue.created_at }),
  });

  const loaded = await archive.load(manifest.id);
  if (
    loaded === undefined ||
    loaded.files.buildOutput.issue.repositoryId !== binding.repositoryId ||
    loaded.files.buildOutput.issue.number !== binding.number
  ) {
    const replacement = await unusedSubmissionId(archive, manifest.id);
    rekeySubmission(root, manifest.id, replacement);
    ui.verbose(`issue #${issue.number} did not reserve ${manifest.id}; rekeyed to ${replacement}`);
    return true;
  }
  if (result.outcome === "failure") {
    ui.faint("The initialization report failed after the id was reserved; submission can continue.");
  }

  manifest = readLocalSubmissionManifest(root);
  if (manifest.initialOwners.length > 0) {
    const target = { id: manifest.id, issue: binding };
    await postCommand(
      github,
      target,
      `/lax owners ${manifest.id} ${JSON.stringify(pendingOwners)}`,
      { ...followOptions, acceptSuccessReaction: true },
    );
    await verifyOwnerList(github, target, pendingOwners);
    clearInitialOwners(root);
  }
  return true;
}

async function prepareBeforeSubmit(root: string): Promise<boolean> {
  const manifest = readLocalSubmissionManifest(root);
  if (manifest.issue !== undefined && manifest.initialOwners.length === 0) {
    // Historical ids were already initialized before this recovery protocol
    // existed. Their recorded binding needs no initialization reattach.
    if (!NEW_SUBMISSION_ID_PATTERN.test(manifest.id)) return false;
    const localBinding = bindingFromLocalDatabase(manifest.id);
    if (
      localBinding?.repositoryId === manifest.issue.repositoryId &&
      localBinding.number === manifest.issue.number
    ) {
      return false;
    }
  }

  ui.title(`Preparing ${manifest.id} for submission`);
  const steps = new ui.Steps();
  steps.add("account", "Signing in");
  steps.add("binding", "Binding the control issue");
  try {
    steps.settle("account", { label: `Signed in as ${await ensureLoggedIn()}` });
    const github = await client();
    const changed = await prepareLocalSubmission(root, github, {
      onStage: (stage) => {
        if (stage.row === "queued") steps.waiting("binding", QUEUED);
        else steps.begin("binding");
      },
    });
    if (!changed) return false;
    const updated = readLocalSubmissionManifest(root);
    steps.settle("binding", {
      label: updated.issue === undefined ? `Assigned ${updated.id}` : `Bound ${updated.id}`,
    });
    steps.finish();
    ui.verdict(`${updated.id} is ready for its next commit`);
    ui.line(`Commit and push the changed files, then run ${ui.cmd("lax submit")} again.`);
    ui.done();
    return true;
  } finally {
    steps.finish();
  }
}

async function synchronizeInitialOwners(
  root: string,
  github: GitHubClient,
  followOptions: FollowOptions,
): Promise<void> {
  const manifest = readLocalSubmissionManifest(root);
  if (manifest.issue === undefined || manifest.initialOwners.length === 0) return;
  const actor = await currentUser(github);
  const owners = await resolveOwnerHandles(github, [actor.handle, ...manifest.initialOwners]);
  const target = { id: manifest.id, issue: manifest.issue };
  await postCommand(
    github,
    target,
    `/lax owners ${manifest.id} ${JSON.stringify(owners)}`,
    { ...followOptions, acceptSuccessReaction: true },
  );
  await verifyOwnerList(github, target, owners);
  clearInitialOwners(root);
}

async function currentUser(github: GitHubClient): Promise<GitHubIdentity> {
  const user = await github.request<{ id: number; login: string; type: string }>("GET", "/user");
  if (
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    !HANDLE_PATTERN.test(user.login) ||
    user.type !== "User"
  ) {
    throw new Error("the authenticated GitHub identity is not a human user");
  }
  return { githubId: user.id, handle: user.login };
}

async function resolveOwnerHandles(
  github: GitHubClient,
  handles: string[],
): Promise<GitHubIdentity[]> {
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
      if (
        !(error instanceof GitHubError) &&
        !String((error as Error).message).startsWith("GitHub request failed:")
      ) {
        throw error;
      }
      ui.faint(
        `Could not verify ${handle} without a login; it will be checked on first submission.`,
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
  if (values.length > MAX_OWNERS) {
    throw new Error(`owner list may contain at most ${MAX_OWNERS} users`);
  }
  return values;
}

async function verifyArchiveBinding(
  github: GitHubClient,
  reference: SubmissionReference,
): Promise<void> {
  const loaded = await new ArchiveRepository(github).load(reference.id);
  if (loaded === undefined) throw new Error(`${reference.id} does not exist in lax-database`);
  if (
    loaded.files.buildOutput.issue.repositoryId !== reference.issue.repositoryId ||
    loaded.files.buildOutput.issue.number !== reference.issue.number
  ) {
    throw new Error(`${reference.id} is not bound to issue #${reference.issue.number}`);
  }
}

/**
 * A manifest binding is persisted before the CLI starts polling Actions. If
 * that polling was interrupted, reattach to the same initialization and then
 * inspect the authoritative Archive record; never create a duplicate issue.
 */
async function recoverArchiveBinding(
  archive: ArchiveRepository,
  github: GitHubClient,
  reference: SubmissionReference,
  followOptions: FollowOptions,
): Promise<"verified" | "recovered" | "mismatch"> {
  let loaded = await archive.load(reference.id);
  let recovered = false;
  if (loaded === undefined) {
    await followInitialization(github, reference.issue.number, followOptions);
    loaded = await archive.load(reference.id);
    recovered = true;
  }
  const matches =
    loaded !== undefined &&
    loaded.files.buildOutput.issue.repositoryId === reference.issue.repositoryId &&
    loaded.files.buildOutput.issue.number === reference.issue.number;
  return matches ? (recovered ? "recovered" : "verified") : "mismatch";
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
  if (loaded === undefined) {
    throw new Error(`${reference.id} disappeared while synchronizing owners`);
  }
  if (
    loaded.files.buildOutput.issue.repositoryId !== reference.issue.repositoryId ||
    loaded.files.buildOutput.issue.number !== reference.issue.number
  ) {
    throw new Error(`${reference.id} changed its issue binding while synchronizing owners`);
  }
  const actualIds = loaded.files.ownerList.owners
    .map((owner) => owner.githubId)
    .sort((left, right) => left - right);
  const expectedIds = expected.map((owner) => owner.githubId).sort((left, right) => left - right);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(
      "the provisional owner list was not committed; it remains in manifest.yaml for retry",
    );
  }
}

async function unusedSubmissionId(
  archive: ArchiveRepository,
  excluded?: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = generateSubmissionId();
    if (id === excluded) continue;
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
