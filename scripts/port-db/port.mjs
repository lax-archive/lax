#!/usr/bin/env node
// Re-validate every existing lax-database record through the issue control
// plane, bottom-up in dependency order.
//
// The old records were validated by the pre-rework pipeline and carry a
// Releases-based capture (`downloadUrl`, no `registryBlob`). The reworked
// pipeline republishes captures as digest-addressed OCI artifacts on ghcr, and
// archive/snapshot.ts refuses to read the old shape at all — so until a record
// is ported, every record that depends on it fails Resolution with "no
// capture". Hence the order: dependencies first, always.
//
// Porting a record is not a data migration. It is one `/lax update` comment
// carrying the record's *own* recorded source triple, posted on its own issue
// by a maintainer who owns it. The workflow does the rest: it re-fetches the
// source, re-runs the whole pipeline, pushes a fresh capture to ghcr, and
// commits the new build-output.json through the trusted publisher. This driver
// never writes to lax-database, never holds an App key, and never mints a
// token: it posts comments and reads runs with the maintainer's own `gh` auth.
//
//   node scripts/port-db/port.mjs --dry-run
//   node scripts/port-db/port.mjs --only lax-13
//   node scripts/port-db/port.mjs
//   node scripts/port-db/port.mjs --start-after lax-12
//
// See scripts/port-db/README.md.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareIds,
  formatMarkdown,
  formatMs,
  formatTable,
  hasResultMarker,
  heaviestPhase,
  isActionsBot,
  issueNumberForId,
  parseRunId,
  peakMemoryBytes,
  planOrder,
  skipReason,
  SUBMISSION_ID_PATTERN,
  updateCommandBody,
  visibleComment,
} from "./plan.mjs";

// Same env names src/shared/constants.ts reads, with the same production
// defaults, so a rehearsal against scratch repositories needs no code change.
const DATABASE_REPOSITORY = process.env.LAX_DATABASE_REPOSITORY ?? "lax-archive/lax-database";
const CONTROL_REPOSITORY = process.env.LAX_CONTROL_REPOSITORY ?? "lax-archive/lax";
const PRODUCTION_CONTROL_REPOSITORY = "lax-archive/lax";
// CONTROL_REPOSITORY_ID in src/shared/constants.ts.
const PRODUCTION_CONTROL_REPOSITORY_ID = 1_320_232_165;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

class PortError extends Error {}

// --- gh ----------------------------------------------------------------------

class GhError extends Error {
  constructor(args, code, stderr) {
    super(`gh ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
    this.stderr = stderr;
  }
}

/**
 * Run `gh` and return its stdout. The maintainer's own login is the only
 * credential this driver ever uses: comment writes and run/artifact reads,
 * nothing that could touch lax-database directly.
 */
function gh(args, { input, json = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new GhError(args, code, stderr));
        return;
      }
      try {
        resolve(json ? JSON.parse(stdout) : stdout);
      } catch (error) {
        reject(new Error(`gh ${args.join(" ")} returned unparseable JSON: ${error.message}`));
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** A repository file as parsed JSON, or undefined when it does not exist. */
async function readRepositoryJson(repository, filePath) {
  try {
    return JSON.parse(
      await gh(
        ["api", `repos/${repository}/contents/${filePath}`, "-H", "Accept: application/vnd.github.raw"],
        { json: false },
      ),
    );
  } catch (error) {
    if (/HTTP 404/u.test(`${error.stderr ?? ""}${error.message}`)) return undefined;
    throw error;
  }
}

/** `gh api --paginate` merges array pages into one JSON array. */
function paginate(endpoint) {
  return gh(["api", endpoint, "--paginate"]);
}

// --- database state ----------------------------------------------------------

async function loadRecords() {
  const listing = await gh(["api", `repos/${DATABASE_REPOSITORY}/contents/`]);
  const ids = listing
    .filter((entry) => entry.type === "dir" && SUBMISSION_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareIds);
  const records = [];
  for (const id of ids) {
    const [record, buildOutput, ownerList] = await Promise.all([
      readRepositoryJson(DATABASE_REPOSITORY, `${id}/record.json`),
      readRepositoryJson(DATABASE_REPOSITORY, `${id}/build-output.json`),
      readRepositoryJson(DATABASE_REPOSITORY, `${id}/owner-list.json`),
    ]);
    if (record === undefined) throw new PortError(`${id} has no record.json`);
    records.push({
      id,
      state: record.state,
      source: record.source,
      buildOutput,
      owners: Array.isArray(ownerList?.owners) ? ownerList.owners : [],
      // The record's own issue binding is authoritative; the id-derived number
      // is only a cross-check. A mismatch means the driver would comment on
      // the wrong issue, so it is fatal rather than corrected silently.
      issueNumber: buildOutput?.issue?.number ?? issueNumberForId(id),
      issueRepositoryId: buildOutput?.issue?.repositoryId,
      captureDigest: buildOutput?.capture?.digest,
      captureFormat:
        buildOutput?.capture === undefined
          ? "none"
          : typeof buildOutput.capture.registryBlob === "string"
            ? "ghcr"
            : "legacy",
    });
  }
  return records;
}

function checkIssueBinding(record) {
  const derived = issueNumberForId(record.id);
  if (record.issueNumber !== derived) {
    throw new PortError(
      `${record.id} claims issue #${record.issueNumber} but its id binds it to #${derived}`,
    );
  }
  if (
    CONTROL_REPOSITORY === PRODUCTION_CONTROL_REPOSITORY &&
    record.issueRepositoryId !== undefined &&
    record.issueRepositoryId !== PRODUCTION_CONTROL_REPOSITORY_ID
  ) {
    throw new PortError(
      `${record.id} is bound to repository id ${record.issueRepositoryId}, not ${PRODUCTION_CONTROL_REPOSITORY_ID}`,
    );
  }
}

// --- the plan ----------------------------------------------------------------

function selectScope(order, options) {
  if (options.only !== undefined) {
    if (!order.includes(options.only)) {
      throw new PortError(`--only ${options.only} is not a portable record in the plan`);
    }
    return [options.only];
  }
  if (options.startAfter === undefined) return order;
  const at = order.indexOf(options.startAfter);
  if (at < 0) throw new PortError(`--start-after ${options.startAfter} is not in the plan`);
  return order.slice(at + 1);
}

function printPlan(plan, records, scope, viewer) {
  const byId = new Map(records.map((record) => [record.id, record]));
  console.log(`database ${DATABASE_REPOSITORY}`);
  console.log(`control  ${CONTROL_REPOSITORY}`);
  console.log(`viewer   ${viewer.login} (${viewer.id})`);
  console.log("");
  console.log("plan (dependencies before dependents):");
  const rows = plan.order.map((id, index) => {
    const record = byId.get(id);
    const dependencies = plan.dependencies.get(id) ?? [];
    return [
      scope.includes(id) ? String(index + 1) : "-",
      id,
      `#${record.issueNumber}`,
      String(plan.depth.get(id)),
      record.state,
      record.captureFormat,
      dependencies.length === 0 ? "-" : dependencies.join(","),
      `${record.source.repository}@${record.source.commit.slice(0, 12)}:${record.source.folder}`,
    ];
  });
  const header = ["#", "id", "issue", "depth", "state", "capture", "depends on", "source triple"];
  const widths = header.map((name, index) =>
    Math.max(name.length, ...rows.map((cells) => cells[index].length)),
  );
  const line = (cells) => `  ${cells.map((cell, index) => cell.padEnd(widths[index])).join("  ")}`.trimEnd();
  console.log(line(header));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const cells of rows) console.log(line(cells));

  if (plan.skipped.length > 0) {
    console.log("");
    console.log("skipped:");
    for (const entry of plan.skipped) {
      const loud = entry.state === "registered" ? "  !! " : "  ";
      console.log(`${loud}${entry.id} (${entry.state}) — ${entry.reason}`);
    }
  }
  if (plan.unportableDependencies.size > 0) {
    console.log("");
    console.log("dependencies outside the plan (these dependents cannot resolve):");
    for (const [id, blocked] of plan.unportableDependencies) {
      console.log(`  ${id} needs ${blocked.join(", ")}`);
    }
  }
  // A narrowed scope can put a dependent before its dependency has a ghcr
  // capture. Resolution would fail with "no capture"; say so up front.
  const premature = scope.flatMap((id) => {
    const missing = (plan.dependencies.get(id) ?? []).filter(
      (dependency) => byId.get(dependency).captureFormat !== "ghcr" && !earlierInScope(scope, dependency, id),
    );
    return missing.length === 0 ? [] : [`${id} needs ${missing.join(", ")}`];
  });
  if (premature.length > 0) {
    console.log("");
    console.log("!! these records are scheduled before a dependency that has no ghcr capture yet:");
    for (const entry of premature) console.log(`     ${entry}`);
    console.log("   they will fail Resolution. Port the dependency first.");
  }

  const strangers = plan.order
    .filter((id) => scope.includes(id))
    .filter((id) => !byId.get(id).owners.some((owner) => owner.githubId === viewer.id));
  if (strangers.length > 0) {
    console.log("");
    console.log(`!! ${viewer.login} is not an owner of: ${strangers.join(", ")}`);
    console.log("   /lax update on those issues is rejected by the route job before anything runs.");
    console.log("   Pass --ignore-ownership to try anyway.");
  }
  return strangers;
}

function earlierInScope(scope, dependency, dependent) {
  const at = scope.indexOf(dependency);
  return at >= 0 && at < scope.indexOf(dependent);
}

// --- one record --------------------------------------------------------------

function heartbeat(id, startedAt, text) {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  console.log(`  [${id}] ${clock}  ${text}`);
}

async function postUpdateComment(record) {
  const body = updateCommandBody(record.source);
  const response = await gh(
    ["api", `repos/${CONTROL_REPOSITORY}/issues/${record.issueNumber}/comments`, "--method", "POST", "--input", "-"],
    { input: JSON.stringify({ body }) },
  );
  return { id: response.id, url: response.html_url, body };
}

/**
 * Wait for the control plane to answer our comment. Correlation is by the
 * hidden markers of src/shared/workflow-comments.ts, exactly as the CLI's
 * follow logic does it: the route job annotates our own comment with the
 * workflow-run marker, and the terminal comment carries our comment id in its
 * result marker. The run's own conclusion is the authoritative verdict; the
 * comment is what a human reads.
 */
async function awaitOutcome(record, comment, options) {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let runId;
  let runUrl;
  let resultBody;
  let completedWithoutResult = 0;

  while (Date.now() <= deadline) {
    const comments = await paginate(`repos/${CONTROL_REPOSITORY}/issues/${record.issueNumber}/comments`);
    for (const candidate of comments) {
      // Our own comment (the workflow annotates it in place) and the Actions
      // bot are the only authors whose markers mean anything.
      const ours = candidate.id === comment.id;
      if (!ours && !isActionsBot(candidate.user)) continue;
      if (ours) runId = parseRunId(candidate.body) ?? runId;
      if (!ours && hasResultMarker(candidate.body, comment.id)) {
        resultBody = candidate.body;
        runId = parseRunId(candidate.body) ?? runId;
      }
    }

    if (runId === undefined) {
      heartbeat(record.id, startedAt, "waiting for the route job to claim the comment");
      await sleep(options.pollMs);
      continue;
    }
    runUrl = `https://github.com/${CONTROL_REPOSITORY}/actions/runs/${runId}`;

    const workflowRun = await gh(["api", `repos/${CONTROL_REPOSITORY}/actions/runs/${runId}`]);
    if (workflowRun.status !== "completed") {
      const jobs = await gh([
        "api",
        `repos/${CONTROL_REPOSITORY}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      ]);
      const active =
        jobs.jobs.find((job) => job.status === "in_progress") ??
        jobs.jobs.find((job) => job.status !== "completed");
      const step = active?.steps?.find((candidate) => candidate.status === "in_progress");
      heartbeat(
        record.id,
        startedAt,
        `run ${runId} ${workflowRun.status}${active === undefined ? "" : ` · ${active.name}`}` +
          `${step === undefined ? "" : ` · ${step.name}`}`,
      );
      await sleep(options.pollMs);
      continue;
    }

    // The run is done. Give the result comment one more poll to land — the
    // final comment is posted by the last job and can trail the run's own
    // completion by a moment.
    if (resultBody === undefined && completedWithoutResult < 2) {
      completedWithoutResult += 1;
      heartbeat(record.id, startedAt, `run ${runId} completed (${workflowRun.conclusion}); awaiting the result comment`);
      await sleep(options.pollMs);
      continue;
    }
    heartbeat(record.id, startedAt, `run ${runId} ${workflowRun.conclusion}`);
    return {
      runId,
      runUrl,
      conclusion: workflowRun.conclusion,
      resultBody,
      runWallMs:
        Date.parse(workflowRun.updated_at) - Date.parse(workflowRun.run_started_at ?? workflowRun.created_at),
    };
  }
  throw new PortError(
    `timed out after ${Math.round(options.timeoutMs / 60_000)} min waiting for ${record.id}; ` +
      `inspect ${comment.url}${runUrl === undefined ? "" : ` and ${runUrl}`}`,
  );
}

/**
 * Pull the validation artifact of a finished run and read the diagnostics out
 * of it. Every failure here is reported, never fatal: the profile is
 * diagnostics (src/shared/profile.ts), and a missing artifact must not turn a
 * successful port into a failed one.
 */
async function readRunDiagnostics(record, runId, reportsDir) {
  const measurements = {};
  const destination = path.join(reportsDir, "artifacts", `${record.id}-${runId}`);
  try {
    const { artifacts } = await gh(["api", `repos/${CONTROL_REPOSITORY}/actions/runs/${runId}/artifacts`]);
    const name = artifacts.find((artifact) => artifact.name.startsWith("submission-validation-"))?.name;
    if (name === undefined) return { note: "no submission-validation artifact on the run" };
    fs.mkdirSync(destination, { recursive: true });
    await gh(["run", "download", String(runId), "--repo", CONTROL_REPOSITORY, "--name", name, "--dir", destination], {
      json: false,
    });
  } catch (error) {
    return { note: `artifact download failed: ${error.message}` };
  }

  const profile = readJsonFile(path.join(destination, "validation-profile.json"));
  if (profile !== undefined) {
    const stages = Array.isArray(profile.stages) ? profile.stages : [];
    measurements.profileMs = stages.reduce((total, stage) => total + (stage.totalMs ?? 0), 0);
    measurements.stages = stages.map((stage) => ({ stage: stage.stage, totalMs: stage.totalMs }));
    // Phases are the immediate children of each stage's span; naming them
    // "<stage>/<phase>" keeps vm-setup's spans distinguishable from the
    // pipeline's without pretending they are the same tree.
    measurements.phases = stages.flatMap((stage) =>
      (stage.span?.children ?? []).map((child) => ({
        name: `${stage.stage}/${child.name}`,
        ms: Math.round(child.ms),
      })),
    );
    measurements.heaviestPhase = heaviestPhase({ children: measurements.phases });
  }
  const report = readJsonFile(path.join(destination, "validation-report.json"));
  // The peak-memory field is optional and lands in whichever of the two
  // documents records it; absence is normal, not an error.
  measurements.peakMemoryBytes = peakMemoryBytes(profile) ?? peakMemoryBytes(report);
  if (report !== undefined) {
    measurements.warnings = (report.warnings ?? []).length;
    measurements.violations = (report.violations ?? []).length;
  }
  measurements.artifactDir = path.relative(repositoryRoot, destination);
  return measurements;
}

async function awaitGhcrCapture(record, options) {
  let capture;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(options.pollMs, 15_000));
    const buildOutput = await readRepositoryJson(DATABASE_REPOSITORY, `${record.id}/build-output.json`);
    capture = buildOutput?.capture;
    if (typeof capture?.registryBlob === "string") return capture;
  }
  return capture;
}

async function portRecord(record, options, reportsDir) {
  const row = {
    id: record.id,
    priorState: record.state,
    priorCaptureFormat: record.captureFormat,
    priorCaptureDigest: record.captureDigest,
    issueUrl: `https://github.com/${CONTROL_REPOSITORY}/issues/${record.issueNumber}`,
    result: "failed",
  };
  console.log("");
  console.log(`== ${record.id} (${record.state}) — ${row.issueUrl}`);
  const comment = await postUpdateComment(record);
  row.commentId = comment.id;
  row.commentUrl = comment.url;
  console.log(`  posted ${comment.body}`);
  console.log(`  comment ${comment.url}`);

  const outcome = await awaitOutcome(record, comment, options);
  row.runId = outcome.runId;
  row.runUrl = outcome.runUrl;
  row.conclusion = outcome.conclusion;
  row.wallMs = outcome.runWallMs;
  if (outcome.resultBody !== undefined) row.detail = visibleComment(outcome.resultBody);

  if (outcome.conclusion === "success") {
    // The run succeeding is necessary but not sufficient: what the port is for
    // is the ghcr capture, so confirm the committed record actually carries
    // one before calling the record ported. The contents API can serve the
    // pre-commit blob for a moment after the publisher's ref update, so a
    // missing capture is re-read a few times before it is believed.
    const capture = await awaitGhcrCapture(record, options);
    row.captureDigest = capture?.digest;
    row.registryBlob = capture?.registryBlob;
    if (typeof capture?.registryBlob === "string") row.result = "ok";
    else row.detail = `${row.detail ?? ""}\nthe run succeeded but ${record.id} still has no ghcr capture`.trim();
  }
  Object.assign(row, await readRunDiagnostics(record, outcome.runId, reportsDir));
  console.log(
    `  ${row.result === "ok" ? "OK" : "FAILED"}  ${formatMs(row.wallMs)}` +
      `${row.captureDigest === undefined ? "" : `  capture ${row.captureDigest.slice(0, 16)}`}`,
  );
  if (row.result !== "ok") {
    console.log(`  run ${row.runUrl}`);
    if (row.detail !== undefined) for (const line of row.detail.split("\n")) console.log(`  | ${line}`);
  }
  return row;
}

// --- reports -----------------------------------------------------------------

function writeReports(report, reportsDir) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const stem = `port-db-${report.startedAt.replaceAll(":", "-").replace(/\..*$/u, "")}`;
  const jsonPath = path.join(reportsDir, `${stem}.json`);
  const markdownPath = path.join(reportsDir, `${stem}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, formatMarkdown(report));
  return { jsonPath, markdownPath };
}

// --- entry point -------------------------------------------------------------

function parseArguments(argv) {
  const options = {
    dryRun: false,
    only: undefined,
    startAfter: undefined,
    continueOnFailure: false,
    ignoreOwnership: false,
    timeoutMs: 20 * 60 * 1000,
    pollMs: 20 * 1000,
    reportsDir: path.join(repositoryRoot, "reports"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new PortError(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--only") options.only = value();
    else if (flag === "--start-after") options.startAfter = value();
    else if (flag === "--continue-on-failure") options.continueOnFailure = true;
    else if (flag === "--ignore-ownership") options.ignoreOwnership = true;
    else if (flag === "--timeout-minutes") options.timeoutMs = positive(value(), flag) * 60 * 1000;
    else if (flag === "--poll-seconds") options.pollMs = positive(value(), flag) * 1000;
    else if (flag === "--reports-dir") options.reportsDir = path.resolve(value());
    else if (flag === "-h" || flag === "--help") options.help = true;
    else throw new PortError(`unknown argument ${flag}`);
  }
  if (options.only !== undefined && options.startAfter !== undefined) {
    throw new PortError("--only and --start-after are mutually exclusive");
  }
  return options;
}

function positive(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new PortError(`${flag} must be a positive number`);
  return parsed;
}

const USAGE = `usage: node scripts/port-db/port.mjs [options]

  --dry-run                print the plan and exit; touches nothing
  --only lax-N             port exactly one record (the canary)
  --start-after lax-N      resume a partial run after this record
  --continue-on-failure    keep going past a failure (default: abort)
  --ignore-ownership       post even where the viewer is not a record owner
  --timeout-minutes N      per-record timeout (default 20)
  --poll-seconds N         polling interval (default 20)
  --reports-dir DIR        where the report is written (default ./reports)

Repositories come from LAX_DATABASE_REPOSITORY and LAX_CONTROL_REPOSITORY,
defaulting to production. Authentication is the maintainer's own gh CLI login.`;

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help === true) {
    console.log(USAGE);
    return 0;
  }

  const viewer = await gh(["api", "user"]);
  const records = await loadRecords();
  for (const record of records) if (skipReason(record) === undefined) checkIssueBinding(record);
  const plan = planOrder(records);
  const scope = selectScope(plan.order, options);
  const strangers = printPlan(plan, records, scope, viewer);

  if (options.dryRun) {
    console.log("");
    console.log(`dry run: ${scope.length} record(s) would be ported, nothing was posted`);
    return 0;
  }
  if (strangers.length > 0 && !options.ignoreOwnership) {
    throw new PortError(
      `${viewer.login} does not own ${strangers.join(", ")}; those /lax update comments would be ` +
        "rejected. Re-run with --ignore-ownership to post them anyway, or narrow the scope with --only.",
    );
  }

  const byId = new Map(records.map((record) => [record.id, record]));
  const report = {
    startedAt: new Date().toISOString(),
    databaseRepository: DATABASE_REPOSITORY,
    controlRepository: CONTROL_REPOSITORY,
    viewer: { login: viewer.login, id: viewer.id },
    mode: options.only !== undefined ? `--only ${options.only}` : options.startAfter !== undefined
      ? `--start-after ${options.startAfter}`
      : "full run",
    plannedOrder: plan.order,
    scope,
    skipped: plan.skipped,
    rows: [],
  };

  let aborted;
  for (const id of scope) {
    try {
      report.rows.push(await portRecord(byId.get(id), options, options.reportsDir));
    } catch (error) {
      report.rows.push({
        id,
        priorState: byId.get(id).state,
        result: "failed",
        issueUrl: `https://github.com/${CONTROL_REPOSITORY}/issues/${byId.get(id).issueNumber}`,
        detail: error.message,
      });
      console.error(`  FAILED ${id}: ${error.message}`);
    }
    if (report.rows.at(-1).result !== "ok" && !options.continueOnFailure) {
      aborted = id;
      break;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.abortedAt = aborted;

  console.log("");
  console.log(formatTable(report.rows));
  const written = writeReports(report, options.reportsDir);
  console.log("");
  console.log(`report ${path.relative(process.cwd(), written.jsonPath)}`);
  console.log(`report ${path.relative(process.cwd(), written.markdownPath)}`);
  if (aborted !== undefined) {
    const at = scope.indexOf(aborted);
    const remaining = scope.slice(at);
    const predecessor = scope[at - 1];
    console.error("");
    console.error(`aborted at ${aborted}. ${remaining.length} record(s) left: ${remaining.join(", ")}`);
    console.error(
      "resume, once the failure is understood, with: node scripts/port-db/port.mjs" +
        `${predecessor === undefined ? "" : ` --start-after ${predecessor}`}`,
    );
    return 1;
  }
  return report.rows.every((row) => row.result === "ok") ? 0 : 1;
}

function readJsonFile(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
