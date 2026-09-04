// Wiring, permission, and pin assertions over .github/workflows/submission.yml,
// .github/workflows/ci.yml, and .github/workflows/release.yml. Everything here
// is structure that only exists
// in YAML: job graph shape, per-job token grants, action pins, and step
// ordering that separates credentials from untrusted input — plus the npm
// scripts those jobs invoke, because a gate that exists only as a script no
// job runs is the same drift as a job that went missing. All *logic*
// (routing, reporting, marker text, idempotence, credential-free preflight)
// lives in TS entry points and is tested behaviorally in
// submission-entry.test.ts and its siblings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  CAPTURE_FILENAME,
  GENERATED_BUILD_OUTPUT_FILENAME,
  PAPER_FILENAME,
  PAPER_WEB_FILENAME,
  VALIDATION_PROFILE_FILENAME,
  VALIDATION_REPORT_FILENAME,
} from "../../src/submission-validation/outputs.js";

const workflowsDirectory = new URL("../../.github/workflows/", import.meta.url);
const workflowFiles = fs
  .readdirSync(workflowsDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
const workflow = fs.readFileSync(new URL("../../.github/workflows/submission.yml", import.meta.url), "utf8");
const setupActionPath = new URL("../../.github/actions/setup-lax/action.yml", import.meta.url);
const setupAction = fs.readFileSync(setupActionPath, "utf8");
const ciWorkflow = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = fs.readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const environmentsWorkflow = fs.readFileSync(
  new URL("../../.github/workflows/environments.yml", import.meta.url),
  "utf8",
);
const packageScripts = (
  JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;
/** The second TypeScript project: everything in the repository, emitting nothing. */
const TYPECHECK_PROJECT = "tsconfig.typecheck.json";
const codeowners = fs.readFileSync(new URL("../../.github/CODEOWNERS", import.meta.url), "utf8");

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Array<{
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
    "continue-on-error"?: boolean;
  }>;
  [key: string]: unknown;
}

const parsed = YAML.parse(workflow) as { jobs: Record<string, WorkflowJob> };
const jobs = parsed.jobs;
const ciParsed = YAML.parse(ciWorkflow) as {
  on: unknown;
  jobs: Record<string, WorkflowJob & { "timeout-minutes"?: number }>;
};
const ciJobs = ciParsed.jobs;
const releaseParsed = YAML.parse(releaseWorkflow) as {
  on: unknown;
  jobs: Record<string, WorkflowJob>;
};
const environmentsParsed = YAML.parse(environmentsWorkflow) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob & { "timeout-minutes"?: number; strategy?: unknown; env?: Record<string, string> }>;
};

/**
 * Look a job up by name. Every assertion below dereferences jobs this way, and
 * a record lookup is optional in this project's type settings for a reason: a
 * renamed or deleted job is exactly the drift these tests exist to catch, so it
 * should fail once, naming the job it could not find, rather than as a pile of
 * reads off `undefined` in whichever assertion ran first.
 */
function requireJob<T>(all: Record<string, T>, name: string): T {
  const found = all[name];
  if (found === undefined) throw new Error(`the workflow declares no ${name} job`);
  return found;
}

/**
 * The host store's cache identity is computed, not spelled out in YAML:
 * host/setup.ts validationHostCacheKey derives it from the environment
 * table's row. The trusted validate job takes it from its static gate's
 * output (the environment the manifest selected); ci.yml and release.yml,
 * which always provision the epoch, take it from `setup-vm.js --cache-key`.
 */
const GATE_CACHE_KEY = "${{ steps.gate.outputs.cache_key }}";
const EPOCH_CACHE_KEY = "${{ steps.host-key.outputs.cache_key }}";
const CACHE_KEY_STEP = "node dist/submission-validation/host/setup-vm.js --cache-key";
const HOST_CACHE_PATHS = ["~/.elan", "~/.lax/warm", "~/.lax/tools"];

/** The provisioning step: setup-vm.js run for its side effect, not its key. */
function provisions(run: string | undefined): boolean {
  return (run ?? "").includes("dist/submission-validation/host/setup-vm.js") && !(run ?? "").includes("--cache-key");
}

// ---------------------------------------------------------------------------
// Pins: supply-chain lint that can only live at the YAML level.
// ---------------------------------------------------------------------------
describe("GitHub Actions dependency pins", () => {
  // A mutable tag would let a compromised action publish into trusted jobs.
  // The local composite action is linted with the workflows: it runs inside
  // every job, including the privileged ones.
  const pinned = [...workflowFiles.map((file) => [file, String(new URL(file, workflowsDirectory))] as const),
    ["actions/setup-lax/action.yml", String(setupActionPath)] as const];
  it.each(pinned)("pins every external action in %s to a full commit SHA", (_label, path) => {
    const definition = fs.readFileSync(new URL(path), "utf8");
    const references = [...definition.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu)].flatMap(
      (match) => match[1] ?? [],
    );

    for (const reference of references) {
      if (reference.startsWith("./")) continue;
      expect(reference, `${path}: ${reference}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }
  });
});

describe("workflow ownership", () => {
  it("assigns the complete workflow namespace to maintainers only", () => {
    const workflowRules = codeowners
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/.github/workflows/"));
    expect(workflowRules).toEqual(["/.github/workflows/ @lax-archive/maintainers"]);
  });
});

describe("submission workflow wiring", () => {
  // -------------------------------------------------------------------------
  // Concurrency: none, by design.
  // -------------------------------------------------------------------------
  it("declares no concurrency groups: CAS is the only write serializer", () => {
    // rewrite-plan.md red-team addendum point 4: classic Actions concurrency
    // cancels older pending runs (silently dropping queued submissions) and
    // `queue: max` semantics were never verified; the CAS retry loop in
    // src/shared/archive.ts is the correctness mechanism, so no group exists.
    expect(workflow).not.toMatch(/^\s*concurrency:/mu);
    expect(workflow).not.toContain("queue: max");
    expect(workflow).not.toContain("cancel-in-progress");
  });

  // -------------------------------------------------------------------------
  // Job graph: every needs/if reference must resolve.
  // -------------------------------------------------------------------------
  it("has a fully resolvable needs graph", () => {
    // A dangling needs entry would make GitHub reject or silently skip jobs.
    const names = new Set(Object.keys(jobs));
    for (const [name, job] of Object.entries(jobs)) {
      const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? [job.needs].flat() : [job.needs];
      for (const dependency of needs.flat()) {
        expect(names.has(dependency), `${name} needs ${dependency}`).toBe(true);
      }
      // Every needs.<job> mention in this job's if/outputs/steps must be declared.
      const jobText = workflow.slice(workflow.indexOf(`  ${name}:`));
      const section = jobText.slice(0, nextJobOffset(jobText));
      for (const match of section.matchAll(/needs\.([a-z-]+)\./gu)) {
        expect(needs, `${name} references undeclared ${match[1]}`).toContain(match[1]);
      }
    }
  });

  it("collapses validation into exactly one job", () => {
    // The single-job pipeline is the reviewed architecture; a new job name
    // appearing here must be a conscious decision, not drift. The success path
    // is four hops: precheck → route → validate → publish-submit.
    expect(Object.keys(jobs).sort()).toEqual([
      "precheck",
      "publish",
      "publish-submit",
      "report-validation-failure",
      "report-workflow-failure",
      "route",
      "validate",
    ]);
    const validate = requireJob(jobs, "validate");
    expect(validate.needs).toBe("route");
    expect(validate.if).toBe("needs.route.outputs.operation == 'validate'");
    // The three-stage machinery must not resurface: no stage entry points,
    // no tarball handoffs, no per-job stitching, no registry login.
    expect(workflow).not.toMatch(/run\.js (compile|replay|inspect|cleanup)/u);
    expect(workflow).not.toContain("stage-state");
    expect(workflow).not.toContain("docker/login-action");
    expect(workflow).not.toContain("ghcr.io");
    expect(workflow).not.toContain("LAX_VALIDATION_IMAGE");
    expect(workflow).not.toContain("packages: read");
    expect(workflow).not.toContain("actions: read");
  });

  // -------------------------------------------------------------------------
  // Untrusted-input gate before any checkout.
  // -------------------------------------------------------------------------
  it("gates candidate events without permissions, checkout, or dependencies", () => {
    // The job-level condition still drops ordinary traffic without a runner.
    // Candidate envelopes then get exact byte, actor, marker, and command-word
    // checks before any repository-controlled code executes. TypeScript repeats
    // all validation in route; this is deliberately only a cheap outer gate.
    const precheck = requireJob(jobs, "precheck");
    expect(precheck.needs).toBeUndefined();
    expect(precheck.if).toContain("startsWith(github.event.issue.body, '<!-- lax-submission-id:')");
    expect(precheck.if).toContain("github.event_name == 'issue_comment'");
    expect(precheck.if).toContain("startsWith(github.event.comment.body, '/lax')");
    expect(precheck.permissions).toEqual({});
    expect(precheck.outputs).toEqual({ should_run: "${{ steps.check.outputs.should_run }}" });
    expect(precheck.steps).toHaveLength(1);
    expect(precheck.steps[0]?.uses).toBeUndefined();
    const script = precheck.steps[0]?.run ?? "";
    expect(script).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(script).toContain("JSON.parse");
    expect(script).toContain('user.type === "User"');
    expect(script).toContain('Buffer.byteLength(body, "utf8") <= 16 * 1024');
    expect(script).toContain('/^\\/lax(?:\\s|$)/u.test(body)');
    expect(script).toContain("lax-[1-9][0-9]{5}");
    expect(script).not.toContain("${{ github.event");
    const route = requireJob(jobs, "route");
    expect(route.needs).toBe("precheck");
    expect(route.if).toBe("needs.precheck.outputs.should_run == 'true'");
  });

  it("admits only bounded human command envelopes through the precheck", () => {
    const reservation =
      "<!-- lax-submission-id:lax-123456 -->\n\n" +
      "This issue is the control plane for one Lax submission. Keep it open and use `/lax` command comments through the CLI.";
    const human = { id: 10, login: "alice", type: "User" };
    const bot = { id: 11, login: "robot", type: "Bot" };
    const issue = { body: reservation, user: human };

    expect(runPrecheck("issues", { action: "opened", issue })).toMatchObject({
      status: 0,
      output: "should_run=true\n",
    });
    const marker = "<!-- lax-submission-id:lax-123456 -->";
    for (const ending of ["\r\n\r\n", "\r\r", "\n\n", ""]) {
      expect(runPrecheck("issues", {
        action: "opened",
        issue: { ...issue, body: ending === "" ? marker : `${marker}${ending}Control` },
      }).output).toBe("should_run=true\n");
    }
    expect(runPrecheck("issues", { action: "opened", issue: { ...issue, user: bot } }).output)
      .toBe("should_run=false\n");
    expect(runPrecheck("issues", {
      action: "opened",
      issue: { ...issue, body: reservation.replace("lax-123456", "lax-12345") },
    }).output).toBe("should_run=false\n");
    expect(runPrecheck("issue_comment", {
      action: "created",
      issue,
      comment: { body: "/lax register", user: human },
    }).output).toBe("should_run=true\n");
    for (const comment of [
      { body: "/laxevil", user: human },
      { body: `/lax ${"x".repeat(16 * 1024)}`, user: human },
      { body: "/lax register", user: bot },
    ]) {
      expect(runPrecheck("issue_comment", { action: "created", issue, comment }).output)
        .toBe("should_run=false\n");
    }
    expect(runPrecheck("issues", undefined, Buffer.from([0xff])).status).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // Shared setup: one composite action, one per-commit cache, one writer.
  // -------------------------------------------------------------------------
  it("checks out and then sets up through the local composite action in every job", () => {
    // A local action is only resolvable after the repository is on disk, so
    // checkout cannot move into it; everything after it can.
    for (const [name, job] of Object.entries(jobs).filter(([name]) => name !== "precheck")) {
      const checkout = job.steps.findIndex((step) => step.uses?.startsWith("actions/checkout"));
      const setup = job.steps.findIndex((step) => step.uses === "./.github/actions/setup-lax");
      expect(checkout, name).toBe(0);
      expect(job.steps[checkout]?.with, name).toMatchObject({ "persist-credentials": false });
      expect(setup, name).toBe(1);
      // The boilerplate the action replaced must not creep back in.
      expect(job.steps.some((step) => step.run === "npm ci"), name).toBe(false);
      expect(job.steps.some((step) => step.run === "npm run build"), name).toBe(false);
    }
    // Exactly one job saves the shared entry: route, which precedes every
    // other job, so nothing else can claim the key first.
    const savers = Object.entries(jobs).filter(
      ([, job]) => job.steps[1]?.with?.save === "true",
    );
    expect(savers.map(([name]) => name)).toEqual(["route"]);
  });

  it("keys the shared dist cache on the commit, with no prefix fallback", () => {
    // Trust: a restore-keys prefix could match an entry saved from the
    // validate VM (its cache token is reachable from an escaped process) and
    // a privileged job would then execute those bytes. Exact per-commit keys
    // plus immutable cache entries mean route's bytes are the only ones a
    // publish job can ever restore.
    const action = YAML.parse(setupAction) as {
      runs: { steps: Array<{ uses?: string; if?: string; with?: Record<string, unknown> }> };
    };
    const cacheSteps = action.runs.steps.filter((step) => step.uses?.startsWith("actions/cache/"));
    expect(cacheSteps).toHaveLength(2);
    for (const step of cacheSteps) {
      expect(step.with?.key).toBe("lax-dist-${{ github.sha }}");
      expect(step.with?.["restore-keys"]).toBeUndefined();
      for (const cached of ["node_modules", "dist"]) expect(step.with?.path).toContain(cached);
    }
    expect(setupAction).not.toMatch(/^\s*restore-keys:/mu);
    expect(cacheSteps.at(-1)?.if).toContain("inputs.save == 'true'");
  });

  // -------------------------------------------------------------------------
  // The job that executes submission code: minimal grants, nothing secret.
  // -------------------------------------------------------------------------
  it("gives the job that executes submission code a read-only token and nothing else", () => {
    // Trust rule 1: no App key, no installation token, no issue write where
    // submission code runs; everything leaves as a credential-free artifact.
    const validate = requireJob(jobs, "validate");
    expect(validate.permissions).toEqual({ contents: "read" });
    const checkout = validate.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    for (const step of validate.steps) {
      expect(JSON.stringify(step.env ?? {})).not.toContain("secrets.");
    }
  });

  it("saves the warm-store cache before untrusted submission code runs", () => {
    // The cache may only ever hold what trusted setup produced: a post-job
    // save would snapshot the tree after a potential sandbox escape and
    // poison every later run (rewrite-plan.md stage 3 execution notes). The
    // static gate ahead of the restore only fetches and parses; it executes
    // nothing, and it writes only into the job dir.
    const steps = requireJob(jobs, "validate").steps;
    const gate = steps.findIndex((step) => step.run === "node dist/submission-validation/run.js --gate");
    const restore = steps.findIndex(
      (step) => step.uses?.startsWith("actions/cache/restore") === true && step.with?.key === GATE_CACHE_KEY,
    );
    const setup = steps.findIndex((step) => provisions(step.run));
    const save = steps.findIndex(
      (step) => step.uses?.startsWith("actions/cache/save") === true && step.with?.key === GATE_CACHE_KEY,
    );
    const validate = steps.findIndex((step) => step.run === "node dist/submission-validation/run.js");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(restore);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(setup);
    expect(setup).toBeLessThan(save);
    expect(save).toBeLessThan(validate);
    // Two cache identities exist in the job, each keyed by reviewed inputs:
    // the host store by the environment row the gate selected plus a layout
    // salt, the reflowtex encode venv by the hash-pinned requirements lock.
    // Nothing else.
    for (const step of steps) {
      if (step.uses?.startsWith("actions/cache/") !== true) continue;
      if (step.with?.key === GATE_CACHE_KEY) {
        for (const cached of HOST_CACHE_PATHS) expect(step.with?.path).toContain(cached);
      } else {
        expect(step.with?.key).toContain("hashFiles('reflowtex/requirements.lock')");
        expect(step.with?.path).toBe("reflowtex/venv");
      }
    }
  });

  it("provisions the environment the static gate selected, passed as data", () => {
    // environments-plan.md stage 2. The gate is the one step that knows which
    // archive environment the manifest named, and it says so through two step
    // outputs computed from the table row (run.ts writeGateOutputs): the row's
    // id and the host cache key. The restore and save steps take the key
    // through `with:`; the provisioning step takes the id through `env:` and
    // hands it to setup-vm.js as a quoted shell variable. Neither output is
    // interpolated into a `run:` script — an expression inside a script is
    // executed as code, which is what trust rule 2 forbids for a value that
    // originated in a submission's manifest, table-validated or not. No
    // restore-keys, as ever.
    const steps = requireJob(jobs, "validate").steps;
    const gate = steps.find((step) => step.run === "node dist/submission-validation/run.js --gate");
    expect(gate?.id).toBe("gate");
    const cacheSteps = steps.filter(
      (step) => step.uses?.startsWith("actions/cache/") === true && step.with?.path !== "reflowtex/venv",
    );
    expect(cacheSteps.map((step) => step.uses?.split("@")[0])).toEqual([
      "actions/cache/restore",
      "actions/cache/save",
    ]);
    for (const step of cacheSteps) {
      expect(step.with?.key).toBe(GATE_CACHE_KEY);
      expect(step.with?.["restore-keys"]).toBeUndefined();
    }
    expect(workflow).not.toMatch(/^\s*restore-keys:/mu);
    expect(workflow).not.toContain("hashFiles('src/submission-validation/pins.ts')");
    const setup = steps.find((step) => provisions(step.run));
    expect(setup?.env?.LAX_ENVIRONMENT).toBe("${{ steps.gate.outputs.environment }}");
    expect(setup?.run).toBe('node dist/submission-validation/host/setup-vm.js --env "$LAX_ENVIRONMENT"');
    // No script anywhere in the workflow interpolates a step output — or any
    // expression at all: every value a script needs arrives through env:.
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps) {
        if (step.run === undefined) continue;
        expect(step.run, `${name}: ${step.name ?? step.run}`).not.toContain("${{");
      }
    }
    // The gate's outputs are consumed only by the validate job's own steps:
    // the environment id never becomes a job output for a privileged job.
    expect(requireJob(jobs, "validate").outputs).toBeUndefined();
    expect(workflow.match(/steps\.gate\.outputs\.environment/gu)).toHaveLength(1);
    expect(workflow.match(/steps\.gate\.outputs\.cache_key/gu)).toHaveLength(2);
  });

  it("fetches the pinned reflowtex fork before untrusted submission code, failure-tolerant", () => {
    // The encode venv and checkout are runner-side prerequisites of the web
    // derivation; a fetch hiccup must degrade to a `web-toolchain` skip of
    // the web view, never a failed validation — so every step tolerates
    // failure. The venv save sits before the lean restore, i.e. before any
    // submission code can execute, same doctrine as the warm-store cache.
    const steps = requireJob(jobs, "validate").steps;
    const restore = steps.find((step) => step.name === "Restore the reflowtex encode venv");
    const fetch = steps.find((step) => step.name === "Fetch the pinned ReflowTeX fork");
    const save = steps.find((step) => step.name === "Save the reflowtex encode venv");
    for (const [name, step] of Object.entries({ restore, fetch, save })) {
      expect(step, name).toBeDefined();
      expect(step?.["continue-on-error"], name).toBe(true);
    }
    expect(fetch?.run).toContain("npm run reflowtex:fetch");
    expect(save?.if).toContain("steps.reflowtex-fetch.outcome == 'success'");
    const gate = steps.findIndex((step) => step.run === "node dist/submission-validation/run.js --gate");
    const leanRestore = steps.findIndex(
      (step) => step.uses?.startsWith("actions/cache/restore") === true && step.with?.key === GATE_CACHE_KEY,
    );
    expect(gate).toBeLessThan(steps.indexOf(restore!));
    expect(steps.indexOf(restore!)).toBeLessThan(steps.indexOf(fetch!));
    expect(steps.indexOf(fetch!)).toBeLessThan(steps.indexOf(save!));
    expect(steps.indexOf(save!)).toBeLessThan(leanRestore);
  });

  // -------------------------------------------------------------------------
  // Artifact handoff: one upload, names aligned with the TS output module.
  // -------------------------------------------------------------------------
  it("hands the validation output to trusted jobs through two aligned artifacts", () => {
    // The artifacts are the only channel out of the untrusted validate job.
    // The full one is the publisher's evidence: its file names must match
    // outputs.ts exactly or the re-validation reads nothing. The report-only
    // one is the reader's copy — the author's CLI and the failure reporter —
    // so neither has to pull the capture to learn what went wrong.
    const uploads = requireJob(jobs, "validate").steps.filter((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(uploads).toHaveLength(2);
    expect(workflow.match(/upload-artifact/gu)).toHaveLength(2);
    const [report, full] = uploads as [WorkflowJob["steps"][number], WorkflowJob["steps"][number]];
    for (const upload of uploads) {
      expect(upload.if).toBe("always()");
      // The artifacts are the only diagnosable record of a failed run, so they
      // keep the maximum retention.
      expect(upload.with?.["retention-days"]).toBe(90);
    }
    // The report is uploaded first: it is what the waiting author reads.
    expect(report.with?.name).toBe("submission-validation-report-${{ github.event.issue.number }}");
    expect(report.with?.path).toBe(`.build/submission-validation/${VALIDATION_REPORT_FILENAME}`);
    expect(full.with?.name).toBe("submission-validation-${{ github.event.issue.number }}");
    for (const filename of [
      VALIDATION_REPORT_FILENAME,
      VALIDATION_PROFILE_FILENAME,
      GENERATED_BUILD_OUTPUT_FILENAME,
      CAPTURE_FILENAME,
      PAPER_FILENAME,
      PAPER_WEB_FILENAME,
    ]) {
      expect(full.with?.path).toContain(`.build/submission-validation/${filename}`);
    }
    // Each download names the artifact holding what that job reads.
    const downloads = {
      "report-validation-failure": "submission-validation-report-${{ github.event.issue.number }}",
      "publish-submit": "submission-validation-${{ github.event.issue.number }}",
    };
    for (const [name, artifact] of Object.entries(downloads)) {
      const steps = requireJob(jobs, name).steps;
      const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact"));
      expect(download?.with?.name, name).toBe(artifact);
      expect(download?.with?.path, name).toBe(".build/submission-validation");
    }
    // The conditional paper artifacts reach both publish steps by the same
    // env names their credential-free re-validation reads
    // (readSuccessfulArtifacts), keyed off the workspace copy the download
    // step above populated.
    const submit = requireJob(jobs, "publish-submit");
    for (const stepName of [
      "Parse artifacts and revalidate current state without Archive credentials",
      "Promote capture, publish trusted submit, and dispatch Website",
    ]) {
      const step = submit.steps.find((candidate) => candidate.name === stepName);
      expect(step?.env?.VALIDATION_PAPER_PATH, stepName).toBe(
        `\${{ github.workspace }}/.build/submission-validation/${PAPER_FILENAME}`,
      );
      expect(step?.env?.VALIDATION_PAPER_WEB_PATH, stepName).toBe(
        `\${{ github.workspace }}/.build/submission-validation/${PAPER_WEB_FILENAME}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Join semantics: success and failure stay on one visible DAG path.
  // -------------------------------------------------------------------------
  it("takes the validation verdict from the validate job's own result", () => {
    // run.js exits 0 only when the full report is ok, so the job result is the
    // verdict; success unlocks publication and failure goes to the reporter,
    // with no bridging job and no output to forge in between. The publisher
    // still re-parses the report before it mints anything.
    const submit = requireJob(jobs, "publish-submit");
    expect(submit.needs).toEqual(["route", "validate"]);
    expect(submit.if).toContain("needs.route.outputs.operation == 'validate'");
    expect(submit.if).toContain("needs.validate.result == 'success'");
    expect(workflow).not.toContain("should_publish=");
    expect(workflow).not.toContain("validation-result");

    const reporter = requireJob(jobs, "report-validation-failure");
    expect(reporter.needs).toEqual(["route", "validate"]);
    // always(), so a failed validate still reports; the failure test keeps it
    // off skipped and cancelled runs.
    expect(reporter.if).toContain("always()");
    expect(reporter.if).toContain("needs.route.outputs.operation == 'validate'");
    expect(reporter.if).toContain("needs.validate.result == 'failure'");
    expect(reporter.permissions).toEqual({ contents: "read", issues: "write" });
    const download = reporter.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact"),
    );
    // A failed validate job may have uploaded nothing; reporting still runs.
    expect(download?.["continue-on-error"]).toBe(true);
    expect(reporter.steps.at(-1)?.run).toBe("node dist/workflows/submission.js report-validation");
  });

  // -------------------------------------------------------------------------
  // Credential separation: each App key scoped to its own environment/job.
  // -------------------------------------------------------------------------
  it("checks submit artifacts and fresh state before minting any token", () => {
    // Trust rule 2: the credential-free preflight step must complete before
    // either App key is touched, so a forged artifact can never reach a token.
    const submit = workflow.slice(workflow.indexOf("  publish-submit:"), workflow.indexOf("  publish:"));
    const prepare = submit.indexOf("Parse artifacts and revalidate current state");
    const mint = submit.indexOf("Mint lax-database token");
    const website = submit.indexOf("Mint lax-website dispatch token");
    const publish = submit.indexOf("Promote capture, publish trusted submit, and dispatch Website");
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(mint);
    expect(mint).toBeLessThan(website);
    expect(website).toBeLessThan(publish);
    expect(submit).toContain("steps.prepare-submit.outputs.should_publish == 'true'");
    expect(submit).toContain("environment: lax-database-publish");
    // Only the trusted submit publisher pushes captures to ghcr, with the
    // job's own GITHUB_TOKEN; no other job holds a packages grant.
    expect(requireJob(jobs, "publish-submit").permissions).toEqual({
      contents: "read",
      issues: "write",
      packages: "write",
    });
    expect(requireJob(jobs, "publish").permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("keeps both publisher keys in the publishing jobs and out of every other one", () => {
    // The two App keys deliberately coexist (Jan, 2026-08-07): the Website
    // rebuild is dispatched by the job that owns the commit, in the same
    // process, so no archive_commit ever crosses a job boundary. The invariant
    // that survives is trust rule 1 — no job holding an App key checks out or
    // executes submission code.
    for (const name of ["publish", "publish-submit"]) {
      const job = requireJob(jobs, name);
      const steps = job.steps.filter((step) =>
        step.uses?.startsWith("actions/create-github-app-token"),
      );
      expect(steps.map((step) => step.with?.repositories), name).toEqual([
        "lax-database",
        "lax-website",
      ]);
      expect(steps[0]?.with?.["private-key"], name).toContain("LAX_DATABASE_APP_PRIVATE_KEY");
      expect(steps[0]?.with?.["permission-administration"], name).toBe("read");
      expect(steps[1]?.with?.["private-key"], name).toContain("LAX_WEBSITE_APP_PRIVATE_KEY");
      // One environment now owns both keys; the old website environment is gone.
      expect(job.environment, name).toBe("lax-database-publish");
      const handler = job.steps.at(-1);
      expect(Object.keys(handler?.env ?? {}), name).toContain("LAX_DATABASE_TOKEN");
      expect(Object.keys(handler?.env ?? {}), name).toContain("LAX_WEBSITE_TOKEN");
    }
    expect(workflow).not.toContain("lax-website-dispatch");
    expect(workflow).not.toContain("archive_commit");
    expect(workflow).not.toContain("title_sync_error");
    // No unprivileged job may reference either key.
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "publish" || name === "publish-submit") continue;
      expect(JSON.stringify(job), name).not.toContain("secrets.");
    }
    // The one-key-per-workflow-secret rule: no legacy combined App secrets.
    expect(workflow).not.toContain("secrets.LAX_APP_ID");
    expect(workflow).not.toContain("secrets.LAX_APP_PRIVATE_KEY");
  });

  // -------------------------------------------------------------------------
  // Fallback failure reporter: a thin dispatcher, wired to every branch.
  // -------------------------------------------------------------------------
  it("dispatches setup and action failures into the typed report-failure mode", () => {
    // All logic lives in src/workflows/submission.ts (tested behaviorally in
    // submission-entry.test.ts); YAML only wires the job in after every
    // failure-capable branch and hands it the outputs the summary needs.
    const fallback = requireJob(jobs, "report-workflow-failure");
    // validate is deliberately absent: a failed validate job is
    // report-validation-failure's case, and a second dependency here would
    // double-post on it.
    expect(fallback.needs).toEqual([
      "precheck",
      "route",
      "publish",
      "publish-submit",
      "report-validation-failure",
    ]);
    expect(fallback.if).toContain("always()");
    for (const dependency of fallback.needs as string[]) {
      expect(fallback.if).toContain(`needs.${dependency}.result == 'failure'`);
    }
    expect(fallback.if).not.toContain("needs.validate.result");
    expect(fallback.permissions).toEqual({ contents: "read", issues: "write" });
    const report = fallback.steps.at(-1);
    expect(report?.run).toBe("node dist/workflows/submission.js report-failure");
    // Only the two publishing jobs can leave a lax-database commit behind, and
    // the commit itself is no longer a job output for the reporter to read.
    expect(Object.keys(report?.env ?? {}).sort()).toEqual([
      "ACTION",
      "GITHUB_TOKEN",
      "LAX_REPOSITORY_ID",
      "OPERATION",
      "PUBLICATION_FAILED",
    ]);
    expect(report?.env?.PUBLICATION_FAILED).toContain("needs.publish.result == 'failure'");
    expect(report?.env?.PUBLICATION_FAILED).toContain("needs.publish-submit.result == 'failure'");
    // The small permissionless precheck is the sole inline script; no
    // privileged job may regain github-script as a second logic host.
    expect(workflow).not.toContain("actions/github-script");
  });

  it("declares the validation branch before the shorter publish branch", () => {
    // Declaration order drives GitHub's automatic DAG layout; keep the long
    // validation row on top and the failure reporters last so run pages stay
    // readable.
    expect(workflow.indexOf("  validate:")).toBeLessThan(workflow.indexOf("  publish-submit:"));
    expect(workflow.indexOf("  publish-submit:")).toBeLessThan(workflow.indexOf("  publish:"));
    expect(workflow.indexOf("  publish:")).toBeLessThan(
      workflow.indexOf("  report-validation-failure:"),
    );
    expect(workflow.indexOf("  report-validation-failure:")).toBeLessThan(
      workflow.indexOf("  report-workflow-failure:"),
    );
  });
});

// ---------------------------------------------------------------------------
// CI: the docker smoke is the only gate that exercises the container-only
// seam, so its wiring is load-bearing and lives here with the rest of the YAML
// structure. The lesson is history/live-rehearsal.md: a container-only bug
// (installOwnConceptCapture dropping the build/ir companions) survived
// `npm run check` and only the smoke caught it.
// ---------------------------------------------------------------------------
describe("CI workflow wiring", () => {
  it("runs the host suite and the real-container smoke on the same triggers", () => {
    expect(Object.keys(ciJobs).sort()).toEqual([
      "check",
      "inspector-matrix",
      "inspector-plan",
      "smoke",
    ]);
    // Workflow-level `on:`, so a per-job trigger cannot exist in Actions: the
    // weekly cron the inspector matrix needs is declared here and the two
    // push-only jobs opt out of it by hand.
    expect(ciParsed.on).toMatchObject({ push: null, pull_request: null });
    expect(requireJob(ciJobs, "check").if).toBe("github.event_name != 'schedule'");
    expect(requireJob(ciJobs, "smoke").if).toBe("github.event_name != 'schedule'");
    for (const [name, job] of Object.entries(ciJobs)) {
      expect(job.permissions, name).toEqual({ contents: "read" });
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
      expect(checkout?.with, name).toMatchObject({ "persist-credentials": false });
    }
    const smoke = requireJob(ciJobs, "smoke");
    expect(smoke.steps.at(-1)?.run).toBe("npm run smoke:submission-validation");
    // A hung container must not burn the six-hour default budget.
    expect(smoke["timeout-minutes"]).toBeGreaterThan(0);
    expect(smoke["timeout-minutes"]).toBeLessThanOrEqual(60);
  });

  it("runs every smoke script the package declares", () => {
    // A smoke driver nothing invokes is a smoke that does not exist, and not
    // merely unrun: vitest collects `test/**/*.test.ts`, so the drivers under
    // test/smoke/ are loaded by no suite at all — an unwired one is never even
    // parsed, and a crash on its first line reads exactly like a green tree.
    // Every one the package declares therefore owes a step here.
    const scripts = Object.keys(packageScripts).filter((name) => name.startsWith("smoke:"));
    expect(scripts).not.toHaveLength(0);
    const runs = Object.values(ciJobs).flatMap((job) => job.steps.map((step) => step.run ?? ""));
    for (const script of scripts) {
      expect(runs.some((run) => run.includes(`npm run ${script}`)), script).toBe(true);
    }
  });

  it("runs the proof-tree smoke after the toolchain it drives exists", () => {
    // The smoke resolves `lean` through each environment's own entry
    // (leanenv.ts), which is what elan's --no-modify-path install leaves it no
    // choice about, so the step needs no PATH surgery — but it does need the
    // toolchain to be there, and it compiles fixture Lean, so it sits after
    // the provisioning *and* after the cache save, for the reason the
    // container smoke does.
    const runs = requireJob(ciJobs, "check").steps.map((step) => step.run ?? step.uses ?? "");
    const setup = runs.findIndex((run) => provisions(run));
    const save = runs.findIndex((run) => run.startsWith("actions/cache/save"));
    const prooftree = runs.findIndex((run) => run.includes("npm run smoke:prooftree"));
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(save).toBeGreaterThan(setup);
    expect(prooftree).toBeGreaterThan(save);
  });

  it("guards every admitted environment's inspector, on the table and weekly", () => {
    // The check job installs the epoch alone, so between admissions no other
    // admitted environment's inspector is built anywhere — and an environment
    // stays open forever (environments-plan.md, "Islands"). The matrix job is
    // that guard: one leg per table row, its toolchain and nothing else, the
    // inspector build (which carries Main.lean's shape guards) and the golden
    // report. It answers to the weekly cron as well as to a push touching the
    // Lean sources or the table.
    expect(ciParsed.on).toMatchObject({ schedule: [{ cron: expect.any(String) }] });
    const plan = requireJob(ciJobs, "inspector-plan");
    expect(plan.outputs).toEqual({
      run: "${{ steps.decide.outputs.run }}",
      matrix: "${{ steps.decide.outputs.matrix }}",
    });
    const decide = plan.steps.find((step) => step.run?.includes("scripts/environments/matrix.mjs"));
    expect(decide).toBeDefined();
    // event values reach the script through the environment, never through an
    // expression the shell would parse (trust rule 2)
    expect(decide?.env?.BEFORE).toBe("${{ github.event.before }}");
    expect(decide?.run).not.toContain("${{ github.event.before }}");
    for (const gated of [
      "src/submission-validation/lean/",
      "assets/prooftree/",
      "src/submission-validation/environments",
    ]) {
      expect(decide?.run, gated).toContain(gated);
    }
    // the parent has to be in the clone for the diff to mean anything
    const checkout = plan.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with).toMatchObject({ "fetch-depth": 0 });

    const matrix = requireJob(ciJobs, "inspector-matrix");
    expect(matrix.needs).toBe("inspector-plan");
    expect(matrix.if).toBe("needs.inspector-plan.outputs.run == 'true'");
    expect(matrix.strategy).toMatchObject({
      "fail-fast": false,
      matrix: "${{ fromJSON(needs.inspector-plan.outputs.matrix) }}",
    });
    expect(matrix["timeout-minutes"]).toBeGreaterThan(0);
    const steps = matrix.steps.map((step) => step.run ?? step.uses ?? "");
    const install = steps.findIndex((run) => run.includes("install-toolchain.mjs"));
    const golden = steps.findIndex((run) => run.includes("test/e2e/inspector-golden.test.ts"));
    const composer = steps.findIndex((run) => run.includes("npm run smoke:prooftree"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(golden).toBeGreaterThan(install);
    expect(composer).toBeGreaterThan(install);
    // no mathlib: the whole point of this job is that it costs a toolchain
    expect(steps.some((run) => run.includes("setup-vm.js"))).toBe(false);
    expect(matrix.steps[install]?.env?.LEAN_TOOLCHAIN).toBe("${{ matrix.leanToolchain }}");
  });

  it("typechecks the trees it never compiles", () => {
    // `npm run build` compiles tsconfig.json, which includes src/** and
    // nothing else, so a type error in test/** or scripts/** — an argument
    // dropped from a call, a fake that drifted from the interface it stands
    // in for — stays invisible until the file happens to run, and a file no
    // suite imports never does. The second project closes that, and is worth
    // having only while it extends the shipped one (same strictness, same
    // module resolution) and keeps the two unshipped trees in scope.
    const runs = requireJob(ciJobs, "check").steps.map((step) => step.run ?? "");
    expect(runs).toContain("npm run typecheck");
    // `npm run check` is what a developer runs before pushing; CI must not be
    // the first place a broken test file is typechecked.
    expect(packageScripts.check).toContain("npm run typecheck");
    expect(packageScripts.typecheck).toBe(`tsc -p ${TYPECHECK_PROJECT}`);
    const project = JSON.parse(
      fs.readFileSync(new URL(`../../${TYPECHECK_PROJECT}`, import.meta.url), "utf8"),
    ) as { extends: string; compilerOptions: { noEmit: boolean }; include: string[] };
    expect(project.extends).toBe("./tsconfig.json");
    // Emitting would fight `npm run build` over dist/, which is what ships.
    expect(project.compilerOptions.noEmit).toBe(true);
    for (const tree of ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"]) {
      expect(project.include, tree).toContain(tree);
    }
  });

  it("installs dependencies without lifecycle scripts", () => {
    for (const [name, job] of Object.entries(ciJobs)) {
      const installs = job.steps.filter((step) => step.run?.startsWith("npm ci"));
      // A job that installs nothing (inspector-plan reads the table's source
      // text with bare node) must then run nothing that would need the tree.
      if (installs.length === 0) {
        for (const step of job.steps) {
          expect(step.run ?? "", name).not.toMatch(/^(?:npm|npx) /u);
        }
        continue;
      }
      expect(installs, name).toHaveLength(1);
      expect(installs[0]?.run, name).toBe("npm ci --ignore-scripts");
    }
    const action = YAML.parse(setupAction) as {
      runs: { steps: Array<{ run?: string }> };
    };
    const install = action.runs.steps.find((step) => step.run?.startsWith("npm ci"));
    expect(install?.run).toBe("npm ci --ignore-scripts && npm run build");
  });

  it("saves the warm-store cache before the smoke runs a container", () => {
    // The smoke shares its cache key with the trusted validate job, so it owes
    // the same discipline: only trusted provisioning may ever write the store.
    // Sandboxed fixture builds happen in the final step, after the save.
    const smokeJob = requireJob(ciJobs, "smoke");
    const runs = smokeJob.steps.map((step) => step.run ?? step.uses ?? "");
    const restore = runs.findIndex((run) => run.startsWith("actions/cache/restore"));
    const setup = runs.findIndex((run) => provisions(run));
    const save = runs.findIndex((run) => run.startsWith("actions/cache/save"));
    const smoke = runs.findIndex((run) => run === "npm run smoke:submission-validation");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(setup);
    expect(setup).toBeLessThan(save);
    expect(save).toBeLessThan(smoke);
    expect(smokeJob.steps[save]?.if).toBe("steps.lean-cache.outputs.cache-hit != 'true'");
    // Same store identity as submission.yml for the epoch: a divergent key
    // would double the provisioning cost and let the two paths drift onto
    // different pins.
    expectEpochHostCache(smokeJob);
  });

  it("provisions the epoch under the key the trusted workflow would use for it", () => {
    // ci.yml has no static gate to select an environment: setup-vm.js
    // without --env provisions the epoch, and the same script's --cache-key
    // names the key host/setup.ts derives for that row — the very function
    // the gate calls — so an epoch store saved here is the one a submission
    // in the epoch restores, and vice versa. The key step precedes the
    // restore, and provisioning is never given an --env here.
    for (const name of ["check", "smoke"]) expectEpochHostCache(requireJob(ciJobs, name));
  });

  it("equips the check job for the paper web e2es before the test step", () => {
    // paper-web-plan.md stage 2: the reflow e2es need lualatex (+ tikz), a
    // dvisvgm with the mutool PDF backend, fontspec's Latin Modern OTFs, and
    // the hash-pinned encode venv from `reflowtex:fetch` — installed before
    // `npm test`, with the venv cached on the lock so warm runs stay fast.
    const check = requireJob(ciJobs, "check");
    const runs = check.steps.map((step) => step.run ?? step.uses ?? "");
    const tex = runs.findIndex((run) => run.includes("texlive-luatex"));
    const fetch = runs.findIndex((run) => run.includes("npm run reflowtex:fetch"));
    const test = runs.indexOf("npm test");
    expect(tex).toBeGreaterThanOrEqual(0);
    for (const piece of ["texlive-pictures", "dvisvgm", "mupdf-tools", "fonts-lmodern", "latexmk"]) {
      expect(runs[tex]).toContain(piece);
    }
    expect(fetch).toBeGreaterThan(tex);
    expect(test).toBeGreaterThan(fetch);
    // the fork e2es gate on the reference clone; the fetch step exports it
    expect(runs[fetch]).toContain("LAX_REFLOWTEX_SOURCE");
    const venvCache = check.steps.find((step) => step.with?.path === "reflowtex/venv");
    expect(venvCache?.uses?.startsWith("actions/cache")).toBe(true);
    expect(venvCache?.with?.key).toContain("hashFiles('reflowtex/requirements.lock')");
  });

  it("keeps the test seams out of the smoke job", () => {
    // The smoke asserts the real pins (it refuses to start with LAX_MATHLIB_*
    // set); a seam leaking into CI would turn the gate into a fake-mathlib
    // rerun of what the host suite already covers.
    expect(ciWorkflow).not.toContain("LAX_MATHLIB_");
    expect(ciWorkflow).not.toContain("LAX_CAPTURE_REGISTRY_URL");
    expect(ciWorkflow).not.toContain("LAX_GITHUB_API_URL");
  });
});

// ---------------------------------------------------------------------------
// Admission: environments.yml proposes a new archive environment. It runs
// mathlib and this repository's tests and nothing else; the only write it can
// perform is a branch and a pull request here, and only after a green run.
// ---------------------------------------------------------------------------
describe("environments workflow wiring", () => {
  const jobsOf = environmentsParsed.jobs;

  it("runs weekly and on request, with no key and no database", () => {
    expect(Object.keys(environmentsParsed.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(environmentsParsed.on.schedule).toMatchObject([{ cron: expect.any(String) }]);
    expect(environmentsParsed.permissions).toEqual({ contents: "read" });
    // Trust rule 1: nothing here checks out or executes submission code, and
    // nothing here may hold an App key or reach lax-database either.
    expect(environmentsWorkflow).not.toContain("LAX_APP_PRIVATE_KEY");
    expect(environmentsWorkflow).not.toContain("lax-database");
    // A second run while one is in flight would propose the same environment
    // twice; admission is never urgent.
    expect(environmentsWorkflow).toContain("cancel-in-progress: false");
  });

  it("discovers candidates before testing any of them", () => {
    const discover = requireJob(jobsOf, "discover");
    expect(discover.permissions).toEqual({ contents: "read" });
    expect(discover.outputs).toMatchObject({ any: expect.any(String) });
    const step = discover.steps.find((one) => one.run?.includes("discover.mjs"));
    // a workflow_dispatch input is untrusted: through the environment, never
    // interpolated into the shell (trust rule 2)
    expect(step?.env?.TAG).toBe("${{ inputs.tag }}");
    expect(step?.run).not.toContain("${{ inputs.tag }}");
  });

  it("gives each candidate the whole gate, in cheapest-first order", () => {
    const test = requireJob(jobsOf, "test");
    expect(test.needs).toBe("discover");
    expect(test.permissions).toEqual({ contents: "read" });
    expect(test["timeout-minutes"]).toBeGreaterThan(0);
    expect(test.strategy).toMatchObject({ "fail-fast": false });
    // LAX_TEST_ENVIRONMENTS is a test seam, and an admission run is a test:
    // the candidate is not in the table yet, and the run exists to decide
    // whether it belongs there.
    expect(test.env?.LAX_TEST_ENVIRONMENTS).toContain("${{ matrix.id }}");
    expect(test.env?.LAX_TEST_ENVIRONMENTS).toContain("${{ matrix.mathlibCommit }}");
    const runs = test.steps.map((step) => step.run ?? step.uses ?? "");
    const install = runs.findIndex((run) => run.includes("install-toolchain.mjs"));
    const unit = runs.indexOf("npm test");
    const golden = runs.findIndex((run) => run.includes("test/e2e/inspector-golden.test.ts"));
    const composer = runs.findIndex((run) => run.includes("npm run smoke:prooftree"));
    const container = runs.findIndex((run) => run.includes("npm run smoke:submission-validation"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(unit).toBeGreaterThan(install);
    // The spike's lesson: the unit and fake-mathlib suites passed straight
    // through the v4.33 composer break, so these two are the ones that decide.
    expect(golden).toBeGreaterThan(unit);
    expect(composer).toBeGreaterThan(unit);
    expect(container).toBeGreaterThan(composer);
    // The smoke's peak is read off the log after the container step and
    // travels to the admit job as a note for the pull request.
    const measure = runs.findIndex((run) => run.includes("peakMemoryBytes"));
    expect(measure).toBeGreaterThan(container);
    expect(runs.some((run) => run.startsWith("actions/upload-artifact"))).toBe(true);
  });

  it("writes only after a green run, and only a pull request", () => {
    const admit = requireJob(jobsOf, "admit");
    expect(admit.needs).toEqual(["discover", "test"]);
    // No `if: always()`: a red leg means no entry is proposed at all.
    expect(admit.if).not.toContain("always");
    expect(admit.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    const runs = admit.steps.map((step) => step.run ?? step.uses ?? "");
    expect(runs.some((run) => run.includes("admit.mjs"))).toBe(true);
    expect(runs.some((run) => run.includes("gh pr create"))).toBe(true);
    // The smoke's peak is a fixture figure, not a budget: it reaches the pull
    // request body as a note and never the entry's `limits`, which would
    // become the container cap that refuses every real submission (the first
    // admission run, 2026-09-04, nearly merged 1.15 GiB as exactly that).
    const append = runs.find((run) => run.includes("admit.mjs"));
    expect(append).not.toContain("--memory-bytes");
    expect(append).not.toContain("--lean-threads");
    expect(append).toContain("peak");
    // The table is the only file an admission may touch.
    const commit = runs.find((run) => run.includes("git commit"));
    expect(commit).toContain("src/submission-validation/environments.ts");
    expect(runs.some((run) => run.includes("git push origin main"))).toBe(false);

    const report = requireJob(jobsOf, "report-failure");
    expect(report.if).toBe("failure()");
    expect(report.permissions).toEqual({ issues: "write", actions: "read" });
    expect(report.steps.some((step) => step.run?.includes("gh issue create"))).toBe(true);
  });
});

describe("release workflow wiring", () => {
  // The npm trusted-publisher registration names this repository and the
  // workflow *file*, so the filename itself is load-bearing: renaming
  // release.yml silently breaks publishing until the registration follows.
  const build = requireJob(releaseParsed.jobs, "build");
  const publish = requireJob(releaseParsed.jobs, "publish");

  it("publishes only tested mainline tags through an isolated OIDC job", () => {
    expect(Object.keys(releaseParsed.jobs)).toEqual(["build", "publish"]);
    expect(releaseParsed.on).toEqual({ push: { tags: ["v*"] } });
    expect(build.permissions).toEqual({ contents: "read" });
    expect(publish.needs).toBe("build");
    expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    const checkout = build.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with).toMatchObject({ "persist-credentials": false, "fetch-depth": 0 });
    expect(build.steps.find((step) => step.name === "Require the tagged commit on main")?.run)
      .toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    const buildNode = build.steps.find((step) => step.uses?.startsWith("actions/setup-node"));
    expect(buildNode?.with?.["registry-url"]).toBeUndefined();
    const publishNode = publish.steps.find((step) => step.uses?.startsWith("actions/setup-node"));
    expect(publishNode?.with).toMatchObject({ "registry-url": "https://registry.npmjs.org" });
  });

  it("provisions the host toolchain before the test gate", () => {
    // The fast suite drives real elan/lake against the fake mathlib; without
    // this ordering the release gate dies at `spawn lake ENOENT` on a bare
    // runner. Same store identity and save-from-trusted-provisioning-only
    // discipline as ci.yml and the trusted validate job.
    const runs = build.steps.map((step) => step.run ?? step.uses ?? "");
    const typecheck = runs.indexOf("npm run typecheck");
    const compile = runs.indexOf("npm run build");
    const restore = runs.findIndex((run) => run.startsWith("actions/cache/restore"));
    const setup = runs.findIndex((run) => provisions(run));
    const save = runs.findIndex((run) => run.startsWith("actions/cache/save"));
    const test = runs.indexOf("npm test");
    expect(typecheck).toBeGreaterThanOrEqual(0);
    expect(typecheck).toBeLessThan(compile);
    expect(compile).toBeLessThan(restore);
    expect(restore).toBeLessThan(setup);
    expect(setup).toBeLessThan(save);
    expect(save).toBeLessThan(test);
    expect(build.steps[save]?.if).toBe("steps.lean-cache.outputs.cache-hit != 'true'");
    // The epoch's store, under the trusted workflow's key for it (see the
    // CI test of the same name for why).
    expectEpochHostCache(build);
  });

  it("vendors the page-builder after the last build and packs without scripts", () => {
    // `npm run build` wipes dist/ (including dist/cli/vendor), so the vendored
    // page-builder must land after the final build, and `npm pack` must run
    // with --ignore-scripts or prepack would rebuild and wipe it again.
    const runs = build.steps.map((step) => step.run ?? step.uses ?? "");
    const vendor = runs.findIndex((run) => run.includes("page-builder:fetch"));
    expect(runs[vendor]).toContain("page-builder:package");
    expect(runs[vendor]).toContain("page-builder:verify");
    const pack = runs.findIndex((run) => run.startsWith("npm pack"));
    const lastBuild = runs.lastIndexOf("npm run build");
    expect(lastBuild).toBeLessThan(vendor);
    expect(vendor).toBeLessThan(pack);
    expect(runs[pack]).toContain("--ignore-scripts");
    const upload = build.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
    expect(upload?.with).toMatchObject({
      name: "cli-package",
      path: "lax-archive-*.tgz",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    // The tag/package.json equality check must gate everything downstream.
    const tagCheck = build.steps.findIndex((step) => step.name === "Check release tag");
    expect(tagCheck).toBeGreaterThanOrEqual(0);
    expect(tagCheck).toBeLessThan(vendor);
  });

  it("keeps repository code and lifecycle scripts out of the OIDC boundary", () => {
    expect(JSON.stringify(build)).not.toContain("id-token");
    expect(publish.steps.some((step) => step.uses?.startsWith("actions/checkout"))).toBe(false);
    expect(JSON.stringify(publish)).not.toContain("npm test");
    expect(JSON.stringify(publish)).not.toContain("npm run build");
    const download = publish.steps.find((step) => step.uses?.startsWith("actions/download-artifact"));
    expect(download?.with).toMatchObject({ name: "cli-package", path: ".release" });
    const identity = publish.steps.find((step) => step.name === "Verify the package identity");
    expect(identity?.run).toContain('test "${#packages[@]}" -eq 1');
    expect(identity?.run).toContain('lax-archive-${GITHUB_REF_NAME#v}.tgz');
    const publishStep = publish.steps.at(-1);
    expect(publishStep?.env).toEqual({ PACKAGE_PATH: "${{ steps.package.outputs.path }}" });
    const command = publishStep?.run;
    expect(command).toContain('npm publish "$PACKAGE_PATH"');
    expect(command).toContain("--ignore-scripts");
    for (const [name, job] of Object.entries(releaseParsed.jobs)) {
      for (const step of job.steps.filter((candidate) =>
        candidate.run?.startsWith("npm ci") || candidate.run?.startsWith("npm install"),
      )) {
        expect(step.run, name).toContain("--ignore-scripts");
      }
    }
  });
});

/**
 * A job that provisions the epoch: one `--cache-key` step with id host-key
 * ahead of the host cache restore, both host cache steps keyed on its output
 * and on nothing else, no restore-keys, and a provisioning step with no
 * `--env` (the epoch is the default) and no interpolated expression.
 */
function expectEpochHostCache(job: WorkflowJob): void {
  const keyStep = job.steps.findIndex((step) => step.run === CACHE_KEY_STEP);
  expect(keyStep).toBeGreaterThanOrEqual(0);
  expect(job.steps[keyStep]?.id).toBe("host-key");
  const hostCache = job.steps.filter(
    (step) => step.uses?.startsWith("actions/cache/") === true && step.with?.path !== "reflowtex/venv",
  );
  expect(hostCache.map((step) => step.uses?.split("@")[0])).toEqual([
    "actions/cache/restore",
    "actions/cache/save",
  ]);
  expect(keyStep).toBeLessThan(job.steps.indexOf(hostCache[0]!));
  for (const step of hostCache) {
    expect(step.with?.key).toBe(EPOCH_CACHE_KEY);
    expect(step.with?.["restore-keys"]).toBeUndefined();
    for (const cached of HOST_CACHE_PATHS) expect(step.with?.path).toContain(cached);
  }
  const setup = job.steps.filter((step) => provisions(step.run));
  expect(setup).toHaveLength(1);
  expect(setup[0]?.run).toBe("node dist/submission-validation/host/setup-vm.js");
  for (const step of job.steps) {
    if (step.run !== undefined) expect(step.run, step.name ?? step.run).not.toContain("${{");
  }
}

function nextJobOffset(jobText: string): number {
  const match = /\n {2}[a-z-]+:\n/gu;
  match.lastIndex = 1;
  const found = match.exec(jobText);
  return found === null ? jobText.length : found.index;
}

function runPrecheck(
  eventName: string,
  event?: unknown,
  eventBytes = Buffer.from(JSON.stringify(event), "utf8"),
): { status: number | null; output: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lax-precheck-"));
  const eventPath = path.join(directory, "event.json");
  const outputPath = path.join(directory, "output");
  try {
    fs.writeFileSync(eventPath, eventBytes);
    const precheck = requireJob(jobs, "precheck");
    const result = spawnSync("/bin/bash", ["-c", precheck.steps[0]?.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
    });
    return {
      status: result.status,
      output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
