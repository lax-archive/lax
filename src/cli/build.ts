import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchiveSnapshot } from "../submission-validation/archive/snapshot.js";
import type {
  ValidationFailure,
  ValidationFinding,
  ValidationScope,
} from "../submission-validation/contracts.js";
import { validateSubmissionOnHost } from "../submission-validation/host/pipeline.js";
import { warmDir, warmReady } from "../submission-validation/host/warmstore.js";
import { hostValidationRuntime } from "../submission-validation/pins.js";
import { removeValidationWorkspace } from "../submission-validation/workspace-cleanup.js";
import { formatProfile, Profiler } from "../shared/profile.js";
import { databaseDirectory } from "./database.js";
import { groupFindings } from "./findings.js";
import { deriveLocalSource, repositoryRoot } from "./git.js";
import { declaresPaper, submissionIdFromFolder } from "./manifest.js";
import { recordSubmission } from "./registry.js";
import * as ui from "./ui.js";
import type { SourceLocation } from "../shared/types.js";

export interface LocalBuildOptions {
  replay?: boolean;
  scope?: ValidationScope;
  profile?: boolean;
  buildFromSource?: boolean;
  /**
   * Run inside another command's step list rather than owning the screen.
   * `lax submit` needs the local build as one row of its own report, showing
   * the build's current stage as that row's detail instead of nesting a second
   * list; when this is set the build prints nothing at all and the caller
   * renders the outcome it returns.
   */
  embed?: (stage: string) => void;
}

export interface LocalBuildOutcome {
  ok: boolean;
  warnings: ValidationFinding[];
  violations: ValidationFinding[];
  failure?: ValidationFailure;
  /** Statement counts, once there is a build output to count them in. */
  concepts?: number;
  proofs?: number;
}

/**
 * The author's six rows, and which of the pipeline's phases belong to each.
 *
 * The pipeline reports nineteen internal phases; an author waiting on a build
 * wants to know which of six things is happening. The mapping is monotonic —
 * every phase of a row runs before every phase of the next — which is what lets
 * a row settle the moment a phase of the following one starts. A package's
 * provisioning, olean materialization, and capture belong to that package's
 * compile row rather than to the shared resolution row for exactly that reason:
 * they run per package, interleaved with the builds.
 */
const ROW_OF_PHASE = new Map<string, string>([
  ["static validation", "layout"],
  ["dependency resolution", "dependencies"],
  ["warm store", "mathlib"],
  ["provision concepts", "concepts"],
  ["compile concepts", "concepts"],
  ["materialize oleans (concepts)", "concepts"],
  ["capture concepts", "concepts"],
  ["provision proofs", "proofs"],
  ["compile proofs", "proofs"],
  ["materialize oleans (proofs)", "proofs"],
  ["capture proofs", "proofs"],
  ["replay concepts", "replay"],
  ["replay proofs", "replay"],
  ["inspector binary", "statements"],
  ["inspect concepts", "statements"],
  ["inspect proofs", "statements"],
  ["judge inspection", "statements"],
  ["resolve marks", "statements"],
  ["emit", "statements"],
  // The one row that settles out of order: the paper compiles beside the
  // Lean chain and closes on its own answer (`ok` on its complete event).
  ["paper", "paper"],
]);

const ROW_LABEL = new Map<string, string>([
  ["layout", "Checked the layout"],
  ["dependencies", "Resolved dependencies"],
  ["mathlib", "Prepared mathlib"],
  ["concepts", "Compiled concepts"],
  ["proofs", "Compiled proofs"],
  ["replay", "Replayed the kernel proofs"],
  ["statements", "Inspected the statements"],
  ["paper", "Compiled the paper"],
]);

/** What each row says while it is still running. */
const ROW_RUNNING = new Map<string, string>([
  ["layout", "Checking the layout"],
  ["dependencies", "Resolving dependencies"],
  ["mathlib", "Preparing mathlib"],
  ["concepts", "Compiling concepts"],
  ["proofs", "Compiling proofs"],
  ["replay", "Replaying the kernel proofs"],
  ["statements", "Inspecting the statements"],
  ["paper", "Compiling the paper"],
]);

/**
 * Run the shared validation pipeline on the host toolchain, in place, against
 * the working tree and local database clone.
 *
 * Lean's own transcript is a `--verbose` concern: with `echo` off a failing
 * `lake build` folds its whole output into the violation instead, so nothing is
 * lost and the happy path stays six lines.
 */
export async function buildSubmission(
  folder: string,
  options: LocalBuildOptions = {},
): Promise<LocalBuildOutcome> {
  const submissionRoot = fs.realpathSync(path.resolve(folder));
  const repository = fs.realpathSync(repositoryRoot(submissionRoot));
  const database = databaseDirectory();
  if (!fs.existsSync(path.join(database, ".git"))) {
    throw new Error(
      `there is no local copy of the archive at ${ui.tilde(database)} yet — run ${ui.cmd("lax sync")}`,
    );
  }
  const archiveSha = git(database, ["rev-parse", "HEAD"]);
  const id = submissionIdFromFolder(submissionRoot);
  const request = {
    requestVersion: 1 as const,
    id,
    source: deriveLocalSource(submissionRoot),
    archiveSha,
  };
  recordSubmission(submissionRoot);
  const runtime = hostValidationRuntime();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lax-build-"));
  const jobDir = path.join(temporary, "work");
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const scope = options.scope ?? "both";
  const profiler = new Profiler();
  const embedded = options.embed !== undefined;

  // A row per stage this run will actually have. mathlib only earns one when
  // this machine has no warm store yet: otherwise the phase is a lookup, and a
  // row that flashes past says nothing.
  const rows = ["layout", "dependencies"];
  // The paper row sits where its phase starts — right after resolution —
  // and stays open while the Lean rows below it come and go.
  const paperRow = scope === "both" && declaresPaper(submissionRoot);
  if (paperRow) rows.push("paper");
  if (!warmReady(warmDir())) rows.push("mathlib");
  rows.push("concepts");
  if (scope !== "concepts") rows.push("proofs");
  if (options.replay === true) rows.push("replay");
  rows.push("statements");

  const steps = embedded ? undefined : new ui.Steps();
  if (steps !== undefined) {
    ui.title(`Building ${id}`);
    for (const row of rows) steps.add(row, ROW_RUNNING.get(row) ?? row);
  }
  const details = new Map<string, string>();
  let current: string | undefined;
  /** The paper row's own lifecycle, outside the monotonic `enter` walk. */
  let paperState: "pending" | "running" | "settled" = "pending";
  /** Settle every row up to and including `row`, and open the next one. */
  const enter = (row: string): void => {
    if (row === current || row === "paper") return;
    if (current !== undefined) settle(current, "ok");
    current = row;
    options.embed?.(ROW_RUNNING.get(row)?.toLowerCase() ?? row);
  };
  const settle = (row: string, status: "ok" | "fail"): void => {
    const detail = details.get(row);
    steps?.settle(row, {
      status,
      // A failed row keeps the label it was spinning under: "✗ Compiled proofs"
      // would say the one thing that did not happen.
      ...(status === "ok" ? { label: ROW_LABEL.get(row) ?? row } : {}),
      ...(detail === undefined ? {} : { detail }),
    });
  };

  try {
    const report = await validateSubmissionOnHost(request, jobDir, {
      local: {
        fetched: { repositoryRoot: repository, submissionRoot },
        archive: new ArchiveSnapshot(database, archiveSha),
      },
      replay: options.replay ?? false,
      scope,
      fromSource: options.buildFromSource ?? false,
      profiler,
      echo: ui.isVerbose(),
      onDetail: (phase, detail) => {
        const row = ROW_OF_PHASE.get(phase);
        if (row === undefined) return;
        // On the row now — a phase that says what it is doing is saying it to
        // someone who is waiting — and kept as the row's detail when it
        // settles, unless something later has more to report by then.
        details.set(row, detail);
        steps?.detail(row, detail);
      },
      onPhase: (event) => {
        const row = ROW_OF_PHASE.get(event.name);
        if (row === "paper") {
          if (!paperRow) return;
          if (event.state === "start") {
            paperState = "running";
            steps?.begin("paper");
            return;
          }
          paperState = "settled";
          // Skipped (no latexmk) is a note, not a failure: the archive
          // compiles the paper regardless, and Lean validation stands.
          const skipped = details.get("paper")?.startsWith("skipped:") === true;
          const status = event.ok === false ? "fail" : skipped ? "warn" : "ok";
          steps?.settle("paper", {
            status,
            ...(status === "ok" ? { label: ROW_LABEL.get("paper")! } : status === "warn" ? { label: "Paper not compiled here" } : {}),
            ...(details.has("paper") ? { detail: details.get("paper")! } : {}),
          });
          return;
        }
        if (event.state !== "start") return;
        if (row !== undefined && rows.includes(row)) enter(row);
      },
    });
    const outcome: LocalBuildOutcome = {
      ok: report.ok && (scope !== "both" || report.buildOutput !== undefined),
      warnings: report.warnings,
      violations: report.violations,
      ...(report.failure === undefined ? {} : { failure: report.failure }),
    };
    if (report.buildOutput !== undefined) {
      outcome.concepts = report.buildOutput.concepts.length;
      outcome.proofs = report.buildOutput.proofs.length;
      // The last row's answer is the inventory it just inspected.
      details.set(
        "statements",
        [
          ui.plural(outcome.concepts, "concept"),
          ...(scope === "concepts" ? [] : [ui.plural(outcome.proofs ?? 0, "proof")]),
        ].join(" · "),
      );
    }
    if (current !== undefined) settle(current, outcome.ok ? "ok" : "fail");
    // Rows the run never reached: hide them rather than leave them spinning.
    // The paper row settles on its own event, or never started at all.
    for (const row of rows.slice(current === undefined ? 0 : rows.indexOf(current) + 1)) {
      if (row === "paper" && paperState !== "pending") continue;
      steps?.settle(row, { hidden: true });
    }
    if (!outcome.ok) {
      steps?.finish();
      if (steps !== undefined) {
        if (outcome.failure !== undefined) showValidationFailure(outcome.failure);
        showFindings(outcome);
        ui.verdict(`${id} did not build`);
        ui.done();
      }
      if (options.profile === true) showProfile(profiler);
      return outcome;
    }
    if (scope === "both") {
      const output = {
        specVersion: "1",
        id,
        ...report.buildOutput!,
        localValidation: {
          version: 1,
          source: request.source,
          archiveSha,
          runtimeImageDigest: runtime.imageDigest,
          replay: options.replay === true,
        },
      };
      // `build-output.json` never reaches the report: the author does not open
      // it, and .gitignore already hides it.
      const filename = path.join(submissionRoot, "build-output.json");
      const staging = `${filename}.${process.pid}.tmp`;
      fs.writeFileSync(staging, `${JSON.stringify(output, null, 2)}\n`);
      fs.renameSync(staging, filename);
      ui.verbose(`wrote ${filename}`);
      // The compiled paper lives beside it, bound by the digest the output
      // records; a build without one (no paper, or none compiled here)
      // leaves no stale PDF behind to disagree with the output.
      const pdf = path.join(submissionRoot, "paper.pdf");
      if (report.paperPdfPath !== undefined) {
        const pdfStaging = `${pdf}.${process.pid}.tmp`;
        fs.copyFileSync(report.paperPdfPath, pdfStaging);
        fs.renameSync(pdfStaging, pdf);
        ui.verbose(`wrote ${pdf}`);
      } else {
        fs.rmSync(pdf, { force: true });
      }
    }
    if (steps !== undefined) {
      const total = steps.total();
      steps.finish();
      ui.verdict(
        scope === "both"
          ? `Built ${id} in ${total}`
          : `Compiled the ${scope} of ${id} in ${total} · partial build, nothing saved`,
      );
      showFindings(outcome);
      ui.done();
    }
    if (options.profile === true) showProfile(profiler);
    return outcome;
  } finally {
    steps?.finish();
    try {
      // parts of the job dir may be read-only (e.g. sealed capture files);
      // removeValidationWorkspace restores directory write bits before rm so
      // the temp tree never lingers in /tmp
      removeValidationWorkspace(temporary);
    } catch (error) {
      // never mask the build result with a cleanup failure
      ui.verbose(
        `could not remove the temporary workspace ${temporary}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Phase timings, for `--profile`. Not a `--verbose` internal: the author asked
 * for exactly this and nothing else.
 */
function showProfile(profiler: Profiler): void {
  ui.blank();
  for (const text of formatProfile(profiler.snapshot()).split("\n")) ui.line(text);
}

/** Errors first, then warnings: both in the notes shape, after the verdict. */
export function showFindings(outcome: {
  warnings: readonly ValidationFinding[];
  violations: readonly ValidationFinding[];
}): void {
  const errors = groupFindings(outcome.violations, "error");
  if (errors !== undefined) ui.problem(errors.headline, errors.body);
  const warnings = groupFindings(outcome.warnings, "warning");
  if (warnings !== undefined) {
    const notes = new ui.Notes();
    notes.add(warnings.headline, ...warnings.body);
    notes.print();
  }
}

export function showValidationFailure(failure: ValidationFailure): void {
  const headline = failure.kind === "resource-limit"
    ? "validation reached a resource limit"
    : "validation infrastructure failed";
  const guidance = failure.kind === "resource-limit"
    ? "The submission was not rejected on content; reduce its resource use before retrying."
    : failure.retryable
      ? "The submission was not rejected on content; retrying it unchanged may succeed."
      : "The submission was not rejected on content; inspect the workflow run or report this archive failure.";
  ui.problem(
    headline,
    [`[${failure.phase}/${failure.rule}]`, ...failure.message.split("\n"), guidance],
  );
}

/** A clean checkout can reuse a full build only when source, Archive snapshot,
 * and the runtime that produced it all match: a pin bump changes what the same
 * sources compile to, so a pre-bump build-output is not current. */
export function hasCurrentLocalBuild(
  folder: string,
  source: SourceLocation,
  archiveSha: string,
): boolean {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(path.resolve(folder), "build-output.json"), "utf8"),
    ) as Record<string, unknown>;
    const validation = value.localValidation as Record<string, unknown> | undefined;
    const builtSource = validation?.source as Record<string, unknown> | undefined;
    // A recorded paper binds paper.pdf by digest: a missing or edited PDF is
    // not the build the output describes.
    const paper = value.paper as { pdf?: { digest?: unknown } } | undefined;
    if (paper !== undefined) {
      const pdf = fs.readFileSync(path.join(path.resolve(folder), "paper.pdf"));
      if (createHash("sha256").update(pdf).digest("hex") !== paper.pdf?.digest) return false;
    }
    return (
      value.id === submissionIdFromFolder(folder) &&
      validation?.version === 1 &&
      validation.archiveSha === archiveSha &&
      validation.runtimeImageDigest === hostValidationRuntime().imageDigest &&
      builtSource?.repository === source.repository &&
      builtSource.commit === source.commit &&
      builtSource.folder === source.folder
    );
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
