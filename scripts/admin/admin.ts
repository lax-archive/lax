#!/usr/bin/env -S npx tsx
// The maintainer's driver for the archive: `npm run admin -- <command> …`.
//
// It holds no power of its own. Every mutation is a `/lax admin <verb>`
// comment on the submission's own issue, which the trusted workflow
// (`.github/workflows/submission.yml`) routes, gates against
// ADMIN_GITHUB_IDS, validates, and publishes exactly as it does an author's
// command — so the secrets doctrine stands (this laptop holds no App key and
// never writes lax-database), the publisher invariants stand (schema checks,
// compare-and-swap, Website dispatch), and the issue thread is the public
// audit log. The one action that is not a comment, `rebuild-website`, is a
// repository_dispatch the maintainer's own GitHub token may already send.
//
// The token is the maintainer's own login (`gh auth token`, or
// LAX_ADMIN_TOKEN); a non-maintainer's comments are refused by the route job
// before anything runs, which the driver says up front.
//
//   npm run admin -- status
//   npm run admin -- revalidate lax-48
//   npm run admin -- revalidate --all --papers --dry-run
//   npm run admin -- delete lax-50
//   npm run admin -- reset-draft lax-50
//   npm run admin -- owners lax-50 alice bob
//   npm run admin -- rebuild-website
//
// See scripts/admin/README.md.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ADMIN_GITHUB_IDS, CONTROL_REPOSITORY, DATABASE_REPOSITORY, WEBSITE_REPOSITORY, githubOauthBase } from "../../src/shared/constants.js";
import { ArchiveRepository, type ArchiveSnapshot } from "../../src/shared/archive.js";
import { GitHubClient, repositoryPath } from "../../src/shared/github.js";
import type { AdminVerb, GitHubIdentity } from "../../src/shared/types.js";
import { normalizeSubmissionId, validateIdentity } from "../../src/shared/validation.js";
import { compareSubmissionIds } from "../../src/submission-validation/contracts.js";
import { showFindings, showValidationFailure } from "../../src/cli/build.js";
import { confirmTyped } from "../../src/cli/confirm.js";
import {
  CommandFailedError,
  followCommand,
  type FollowOptions,
} from "../../src/cli/follow.js";
import { renderComment } from "../../src/cli/render.js";
import * as ui from "../../src/cli/ui.js";
import {
  adminCommandBody,
  adminRecord,
  describeSource,
  formatTable,
  revalidationOrder,
  revalidationSkipReason,
  STATUS_HEADER,
  statusRows,
  type AdminRecord,
} from "./plan.js";

const USAGE = `usage: npm run admin -- <command> [options]

  status [lax-N ...]              every record's state, capture, paper, and edges (read-only)
  revalidate <lax-N ...> | --all  rebuild from the recorded source and republish the build output
  delete <lax-N>                  tombstone the record in any state, even registered
  reset-draft <lax-N>             registered -> draft, so it can be resubmitted and re-registered
  owners <lax-N> <handle ...>     replace the owner list outright
  rebuild-website                 ask lax-website to rebuild from the database as it is

options:
  --dry-run       print the commands that would be posted and post nothing
  --yes           skip the typed confirmation on delete and reset-draft
  --papers        with --all: only records that declare a paper
  --continue      with several records: keep going after one fails
  --verbose       show the workflow run and the archive's own comments

The token is \`gh auth token\` unless LAX_ADMIN_TOKEN is set. Repositories come from
LAX_CONTROL_REPOSITORY and LAX_DATABASE_REPOSITORY, defaulting to production.`;

interface Options {
  command?: string;
  positional: string[];
  dryRun: boolean;
  yes: boolean;
  all: boolean;
  papers: boolean;
  continueOnFailure: boolean;
  verbose: boolean;
  help: boolean;
}

class AdminError extends Error {}

const controlBase = repositoryPath(CONTROL_REPOSITORY);
const databaseBase = repositoryPath(DATABASE_REPOSITORY);

export function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    positional: [],
    dryRun: false,
    yes: false,
    all: false,
    papers: false,
    continueOnFailure: false,
    verbose: false,
    help: false,
  };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--yes") options.yes = true;
    else if (argument === "--all") options.all = true;
    else if (argument === "--papers") options.papers = true;
    else if (argument === "--continue") options.continueOnFailure = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument.startsWith("-")) throw new AdminError(`unknown option ${argument}`);
    else if (options.command === undefined) options.command = argument;
    else options.positional.push(argument);
  }
  return options;
}

// --- GitHub -------------------------------------------------------------------

function token(): string {
  const configured = process.env.LAX_ADMIN_TOKEN;
  if (configured !== undefined && configured !== "") return configured;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new AdminError(
      `no token: set LAX_ADMIN_TOKEN or sign in with \`gh auth login\` (${(error as Error).message.split("\n")[0]})`,
    );
  }
}

interface Viewer {
  id: number;
  login: string;
}

async function viewer(client: GitHubClient): Promise<Viewer> {
  const user = await client.request<{ id: number; login: string }>("GET", "/user");
  return { id: user.id, login: user.login };
}

interface GitCommit {
  tree: { sha: string };
}

interface GitTree {
  truncated: boolean;
  tree: Array<{ path: string; type: string }>;
}

async function listIds(client: GitHubClient, snapshot: ArchiveSnapshot): Promise<string[]> {
  const commit = await client.request<GitCommit>("GET", `${databaseBase}/git/commits/${snapshot.sha}`);
  const root = await client.request<GitTree>("GET", `${databaseBase}/git/trees/${commit.tree.sha}`);
  if (root.truncated) throw new AdminError("lax-database root tree listing is truncated");
  return root.tree
    .filter((entry) => entry.type === "tree" && /^lax-[1-9][0-9]*$/u.test(entry.path))
    .map((entry) => entry.path)
    .sort(compareSubmissionIds);
}

async function loadRecords(client: GitHubClient, ids?: readonly string[]): Promise<AdminRecord[]> {
  const archive = new ArchiveRepository(client);
  const snapshot = await archive.snapshot();
  const selected = ids ?? (await listIds(client, snapshot));
  const records: AdminRecord[] = [];
  for (const id of selected) {
    const loaded = await archive.load(id, snapshot);
    if (loaded === undefined) throw new AdminError(`${id} does not exist in lax-database`);
    records.push(adminRecord(loaded));
  }
  return records;
}

function issueUrl(issueNumber: number): string {
  return `${githubOauthBase()}/${CONTROL_REPOSITORY}/issues/${issueNumber}`;
}

// --- the command comment ------------------------------------------------------

/**
 * The two rows a maintainer watches — the archive rebuilding (only when the
 * verb validates) and the archive writing the record — mirroring the author's
 * `lax submit` rows, minus the sign-in and source rows the driver has no use
 * for. A failed validation ends the command here, with the findings; the
 * refusal comment that follows says the same thing with less in it.
 */
class Report {
  readonly steps = new ui.Steps();
  private archiveOpen = false;
  private archiveSettled = false;
  private publishOpen = false;

  constructor(
    private readonly id: string,
    private readonly validates: boolean,
  ) {
    if (validates) this.steps.add("archive", "Rebuilding in the archive");
    this.steps.add("publish", "Writing the public record");
  }

  follow(): FollowOptions {
    return {
      onPreview: (text) => ui.verbose(text),
      onStage: (stage) => {
        if (stage.row === "queued") {
          this.steps.waiting(this.validates ? "archive" : "publish", "queued");
          return;
        }
        if (stage.row === "validate" && this.validates) {
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
      ...(this.validates
        ? {
            onValidationReport: (report) => {
              if (report.ok) {
                this.settleArchive();
                return;
              }
              this.steps.settle("archive", { status: "fail" });
              this.steps.settle("publish", { hidden: true });
              this.steps.finish();
              if (report.failure !== undefined) showValidationFailure(report.failure);
              showFindings(report);
              throw new CommandFailedError(
                report.failure === undefined
                  ? `${this.id} did not pass the archive's checks`
                  : `${this.id} did not receive a validation verdict`,
              );
            },
          }
        : {}),
    };
  }

  private settleArchive(): void {
    if (!this.validates || this.archiveSettled) return;
    this.archiveSettled = true;
    this.steps.settle("archive", {
      label: "Rebuilt in the archive",
      ...(this.archiveOpen ? {} : { time: false as const }),
    });
  }

  succeed(label: string): void {
    this.settleArchive();
    this.steps.settle("publish", { label, ...(this.publishOpen ? {} : { time: false as const }) });
    this.steps.finish();
  }

  finish(): void {
    this.steps.finish();
  }
}

async function postAndFollow(
  client: GitHubClient,
  record: AdminRecord,
  verb: AdminVerb,
  body: string,
  options: Options,
  successLabel: string,
): Promise<void> {
  ui.faint(`${body}  →  ${issueUrl(record.issueNumber)}`);
  if (options.dryRun) {
    ui.faint("dry run: nothing was posted");
    return;
  }
  const comment = await client.request<{ id: number; html_url: string; created_at?: string }>(
    "POST",
    `${controlBase}/issues/${record.issueNumber}/comments`,
    { body },
  );
  ui.verbose(`command posted: ${comment.html_url}`);
  const report = new Report(record.id, verb === "revalidate");
  try {
    const result = await followCommand(client, record.issueNumber, comment.id, {
      ...report.follow(),
      ...(comment.created_at === undefined ? {} : { since: comment.created_at }),
      acceptSuccessReaction: verb === "owners",
    });
    if (result.outcome === "failure") {
      report.finish();
      ui.problem("the archive refused this command", renderComment(result.comment ?? "").split("\n"));
      throw new CommandFailedError("the archive refused this command");
    }
    report.succeed(successLabel);
  } finally {
    report.finish();
  }
}

// --- commands -----------------------------------------------------------------

function selectRecords(records: readonly AdminRecord[], ids: readonly string[]): AdminRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return ids.map((id) => {
    const record = byId.get(id);
    if (record === undefined) throw new AdminError(`${id} does not exist in lax-database`);
    return record;
  });
}

function submissionIds(values: readonly string[]): string[] {
  return values.map((value) => {
    try {
      return normalizeSubmissionId(value);
    } catch (error) {
      throw new AdminError(`${value} is not a submission id: ${(error as Error).message}`);
    }
  });
}

async function status(client: GitHubClient, options: Options): Promise<number> {
  const ids = options.positional.length === 0 ? undefined : submissionIds(options.positional);
  const records = await loadRecords(client, ids);
  console.log(`database ${DATABASE_REPOSITORY} · control ${CONTROL_REPOSITORY}`);
  console.log("");
  console.log(formatTable(STATUS_HEADER, statusRows(records)));
  return 0;
}

async function revalidate(client: GitHubClient, options: Options): Promise<number> {
  if (options.all === (options.positional.length > 0)) {
    throw new AdminError("revalidate takes submission ids or --all, not both and not neither");
  }
  const records = await loadRecords(client);
  const byId = new Map(records.map((record) => [record.id, record]));
  let scope: string[];
  if (options.all) {
    scope = records
      .filter((record) => revalidationSkipReason(record) === undefined)
      .filter((record) => !options.papers || record.paper !== "none")
      .map((record) => record.id);
  } else {
    scope = submissionIds(options.positional);
    const refused = selectRecords(records, scope)
      .map((record) => [record.id, revalidationSkipReason(record)] as const)
      .filter(([, reason]) => reason !== undefined);
    if (refused.length > 0) {
      throw new AdminError(
        `cannot revalidate ${refused.map(([id, reason]) => `${id} (${reason})`).join(", ")}`,
      );
    }
  }
  const order = revalidationOrder(records, scope);
  if (order.length === 0) {
    ui.line("nothing to revalidate");
    return 0;
  }
  ui.title(`Revalidating ${order.length === 1 ? order[0]! : `${order.length} records`}`);
  ui.line("Each record is rebuilt by the archive from its recorded source; its state does not change.");
  if (order.length > 1) {
    ui.line("Order (dependencies first):");
    for (const id of order) {
      const record = byId.get(id)!;
      ui.line(`  ${id.padEnd(11)} ${record.state.padEnd(10)} ${record.paper.padEnd(8)} ${describeSource(record.source)}`);
    }
  }
  ui.blank();
  const rows: Array<[string, string]> = [];
  for (const id of order) {
    const record = byId.get(id)!;
    if (order.length > 1) ui.title(id);
    try {
      await postAndFollow(
        client,
        record,
        "revalidate",
        adminCommandBody("revalidate", id),
        options,
        `Republished ${id} (${record.state})`,
      );
      rows.push([id, options.dryRun ? "dry run" : "ok"]);
    } catch (error) {
      rows.push([id, `failed: ${(error as Error).message}`]);
      if (!(error instanceof CommandFailedError)) ui.failure((error as Error).message);
      if (!options.continueOnFailure) break;
    }
  }
  if (order.length > 1) {
    ui.blank();
    console.log(formatTable(["id", "result"], rows));
  }
  const unfinished = order.length - rows.length;
  if (unfinished > 0) ui.failure(`stopped; ${unfinished} record(s) not attempted — rerun with --continue to go past a failure`);
  return rows.length === order.length && rows.every(([, result]) => result === "ok" || result === "dry run") ? 0 : 1;
}

async function destructive(
  client: GitHubClient,
  verb: "delete" | "reset-draft",
  options: Options,
): Promise<number> {
  if (options.positional.length !== 1) throw new AdminError(`${verb} takes exactly one submission id`);
  const [id] = submissionIds(options.positional);
  const [record] = await loadRecords(client, [id!]);
  ui.title(`${verb === "delete" ? "Delete" : "Reset to draft"} ${id}`);
  ui.line(`Currently ${record!.state}; ${describeSource(record!.source)}.`);
  if (verb === "delete") {
    ui.line("This is permanent. The record leaves the archive and the site, and its id is retired.");
    if (record!.state === "registered") ui.line("It is registered: this is the takedown power, and it strands every dependent.");
  } else {
    ui.line("The record becomes a draft again: mutable, and not citable until re-registered.");
    if (record!.supersedes !== undefined) ui.line(`It claims to supersede ${record!.supersedes}; the claim rebinds on re-registration.`);
  }
  ui.line("The rationale belongs in a comment on the issue, not in the record.");
  ui.blank();
  if (!options.dryRun && !options.yes && !(await confirmTyped({ expected: id!, action: `${verb} of ${id}` }))) return 1;
  await postAndFollow(
    client,
    record!,
    verb,
    adminCommandBody(verb, id!),
    options,
    verb === "delete" ? `Deleted ${id}` : `Reset ${id} to draft`,
  );
  return 0;
}

async function owners(client: GitHubClient, options: Options): Promise<number> {
  if (options.positional.length < 2) throw new AdminError("owners takes a submission id and at least one handle");
  const [id] = submissionIds(options.positional.slice(0, 1));
  const handles = options.positional.slice(1);
  const [record] = await loadRecords(client, [id!]);
  const identities: GitHubIdentity[] = [];
  for (const handle of handles) {
    const user = await client.request<{ id: number; login: string; type: string }>(
      "GET",
      `/users/${encodeURIComponent(handle)}`,
    );
    if (user.type !== "User") throw new AdminError(`${handle} is not a human GitHub user`);
    identities.push(validateIdentity({ githubId: user.id, handle: user.login }, handle));
  }
  identities.sort((left, right) => left.githubId - right.githubId);
  ui.title(`Owners of ${id}`);
  ui.line(`Now: ${record!.owners.map((owner) => owner.handle).join(", ") || "-"}`);
  ui.line(`New: ${identities.map((owner) => `${owner.handle} (${owner.githubId})`).join(", ")}`);
  ui.blank();
  await postAndFollow(
    client,
    record!,
    "owners",
    adminCommandBody("owners", id!, identities),
    options,
    `Replaced the owners of ${id}`,
  );
  return 0;
}

async function rebuildWebsite(client: GitHubClient, options: Options): Promise<number> {
  const snapshot = await new ArchiveRepository(client).snapshot();
  const payload = {
    event_type: "lax-db-updated",
    client_payload: { archiveCommit: snapshot.sha, submissionId: "-", action: "rebuild-website" },
  };
  ui.title("Rebuild the Website");
  ui.faint(`repository_dispatch ${payload.event_type} → ${WEBSITE_REPOSITORY} at lax-database ${snapshot.sha.slice(0, 12)}`);
  if (options.dryRun) {
    ui.faint("dry run: nothing was dispatched");
    return 0;
  }
  await client.request("POST", `${repositoryPath(WEBSITE_REPOSITORY)}/dispatches`, payload);
  ui.verdict("The rebuild event was accepted.");
  ui.link(`${githubOauthBase()}/${WEBSITE_REPOSITORY}/actions`);
  return 0;
}

// --- entry point --------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  if (options.help || options.command === undefined) {
    console.log(USAGE);
    return options.help ? 0 : 2;
  }
  ui.configure({ verbose: options.verbose });
  const client = new GitHubClient(token());
  const who = await viewer(client);
  if (options.command === "status") return status(client, options);
  if (options.command === "rebuild-website") return rebuildWebsite(client, options);
  // Everything below posts a maintainer command. The route job refuses a
  // non-maintainer before anything runs; say so here instead of after a
  // round trip through Actions.
  if (!ADMIN_GITHUB_IDS.has(who.id)) {
    throw new AdminError(
      `${who.login} (${who.id}) is not in ADMIN_GITHUB_IDS (src/shared/constants.ts); the archive would refuse the command`,
    );
  }
  ui.faint(`signed in as ${who.login} · control ${CONTROL_REPOSITORY} · database ${DATABASE_REPOSITORY}`);
  if (options.command === "revalidate") return revalidate(client, options);
  if (options.command === "delete" || options.command === "reset-draft") return destructive(client, options.command, options);
  if (options.command === "owners") return owners(client, options);
  throw new AdminError(`unknown command ${options.command}\n\n${USAGE}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      if (!(error instanceof CommandFailedError)) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
      process.exitCode = 1;
    },
  );
}
