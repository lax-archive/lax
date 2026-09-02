// Wiring, permission, and pin assertions over .github/workflows/submission.yml,
// .github/workflows/ci.yml, and .github/workflows/release.yml. Everything here
// is structure that only exists
// in YAML: job graph shape, per-job token grants, action pins, and step
// ordering that separates credentials from untrusted input. All *logic*
// (routing, reporting, marker text, idempotence, credential-free preflight)
// lives in TS entry points and is tested behaviorally in
// submission-entry.test.ts and its siblings.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  CAPTURE_FILENAME,
  GENERATED_BUILD_OUTPUT_FILENAME,
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

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Array<{
    name?: string;
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

/** The one cache identity both the trusted validate job and the CI smoke use. */
const HOST_CACHE_KEY =
  "lax-validation-host-v1-${{ runner.os }}-${{ hashFiles('src/submission-validation/pins.ts') }}";
const HOST_CACHE_PATHS = ["~/.elan", "~/.lax/warm", "~/.lax/tools"];

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
    const references = [...definition.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu)].map(
      (match) => match[1],
    );

    for (const reference of references) {
      if (reference.startsWith("./")) continue;
      expect(reference, `${path}: ${reference}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }
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
    // is three hops: route → validate → publish-submit.
    expect(Object.keys(jobs).sort()).toEqual([
      "publish",
      "publish-submit",
      "report-validation-failure",
      "report-workflow-failure",
      "route",
      "validate",
    ]);
    expect(jobs.validate.needs).toBe("route");
    expect(jobs.validate.if).toBe("needs.route.outputs.operation == 'validate'");
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
  it("gates unrelated comments before a runner is allocated", () => {
    // The gate is a job-level condition, not a job: an unrelated comment on
    // this repository must not start a runner at all. It is evaluated as data
    // — no comment text is ever interpolated into a `run:` script — and for
    // `issues` events the absent comment body makes the prefix test false.
    expect(jobs.route.needs).toBeUndefined();
    expect(jobs.route.if).toBe(
      "github.event_name == 'issues' || startsWith(github.event.comment.body, '/lax')",
    );
    expect(workflow).not.toContain("precheck");
    expect(workflow).not.toContain("should_run");
  });

  // -------------------------------------------------------------------------
  // Shared setup: one composite action, one per-commit cache, one writer.
  // -------------------------------------------------------------------------
  it("checks out and then sets up through the local composite action in every job", () => {
    // A local action is only resolvable after the repository is on disk, so
    // checkout cannot move into it; everything after it can.
    for (const [name, job] of Object.entries(jobs)) {
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
    expect(jobs.validate.permissions).toEqual({ contents: "read" });
    const checkout = jobs.validate.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    for (const step of jobs.validate.steps) {
      expect(JSON.stringify(step.env ?? {})).not.toContain("secrets.");
    }
  });

  it("saves the warm-store cache before untrusted submission code runs", () => {
    // The cache may only ever hold what trusted setup produced: a post-job
    // save would snapshot the tree after a potential sandbox escape and
    // poison every later run (rewrite-plan.md stage 3 execution notes). The
    // static gate ahead of the restore only fetches and parses; it executes
    // nothing, and it writes only into the job dir.
    const runs = jobs.validate.steps.map((step) => step.run ?? step.uses ?? "");
    const gate = runs.findIndex((run) => run === "node dist/submission-validation/run.js --gate");
    const restore = runs.findIndex((run) => run.startsWith("actions/cache/restore"));
    const setup = runs.findIndex((run) => run.includes("dist/submission-validation/host/setup-vm.js"));
    const save = runs.findIndex((run) => run.startsWith("actions/cache/save"));
    const validate = runs.findIndex((run) => run === "node dist/submission-validation/run.js");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(restore);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(setup);
    expect(setup).toBeLessThan(save);
    expect(save).toBeLessThan(validate);
    // The cache identity is the reviewed pins module plus a layout salt.
    for (const step of jobs.validate.steps) {
      if (step.uses?.startsWith("actions/cache/") !== true) continue;
      expect(step.with?.key).toBe(HOST_CACHE_KEY);
      for (const cached of HOST_CACHE_PATHS) expect(step.with?.path).toContain(cached);
    }
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
    const uploads = jobs.validate.steps.filter((step) =>
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
    ]) {
      expect(full.with?.path).toContain(`.build/submission-validation/${filename}`);
    }
    // Each download names the artifact holding what that job reads.
    const downloads = {
      "report-validation-failure": "submission-validation-report-${{ github.event.issue.number }}",
      "publish-submit": "submission-validation-${{ github.event.issue.number }}",
    };
    for (const [name, artifact] of Object.entries(downloads)) {
      const download = jobs[name].steps.find((step) => step.uses?.startsWith("actions/download-artifact"));
      expect(download?.with?.name, name).toBe(artifact);
      expect(download?.with?.path, name).toBe(".build/submission-validation");
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
    expect(jobs["publish-submit"].needs).toEqual(["route", "validate"]);
    expect(jobs["publish-submit"].if).toContain("needs.route.outputs.operation == 'validate'");
    expect(jobs["publish-submit"].if).toContain("needs.validate.result == 'success'");
    expect(workflow).not.toContain("should_publish=");
    expect(workflow).not.toContain("validation-result");

    const reporter = jobs["report-validation-failure"];
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
    expect(jobs["publish-submit"].permissions).toEqual({
      contents: "read",
      issues: "write",
      packages: "write",
    });
    expect(jobs.publish.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("keeps both publisher keys in the publishing jobs and out of every other one", () => {
    // The two App keys deliberately coexist (Jan, 2026-08-07): the Website
    // rebuild is dispatched by the job that owns the commit, in the same
    // process, so no archive_commit ever crosses a job boundary. The invariant
    // that survives is trust rule 1 — no job holding an App key checks out or
    // executes submission code.
    for (const name of ["publish", "publish-submit"]) {
      const job = jobs[name]!;
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
    const fallback = jobs["report-workflow-failure"];
    // validate is deliberately absent: a failed validate job is
    // report-validation-failure's case, and a second dependency here would
    // double-post on it.
    expect(fallback.needs).toEqual([
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
    // No inline JS anywhere: github-script was the last untyped logic host.
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
    expect(Object.keys(ciJobs).sort()).toEqual(["check", "smoke"]);
    // Workflow-level `on:`, so both jobs answer to the same events; a per-job
    // trigger cannot exist in Actions, but a second workflow file could drift.
    expect(ciParsed.on).toEqual({ push: null });
    for (const [name, job] of Object.entries(ciJobs)) {
      expect(job.permissions, name).toEqual({ contents: "read" });
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
      expect(checkout?.with, name).toMatchObject({ "persist-credentials": false });
    }
    expect(ciJobs.smoke.steps.at(-1)?.run).toBe("npm run smoke:submission-validation");
    // A hung container must not burn the six-hour default budget.
    expect(ciJobs.smoke["timeout-minutes"]).toBeGreaterThan(0);
    expect(ciJobs.smoke["timeout-minutes"]).toBeLessThanOrEqual(60);
  });

  it("saves the warm-store cache before the smoke runs a container", () => {
    // The smoke shares its cache key with the trusted validate job, so it owes
    // the same discipline: only trusted provisioning may ever write the store.
    // Sandboxed fixture builds happen in the final step, after the save.
    const runs = ciJobs.smoke.steps.map((step) => step.run ?? step.uses ?? "");
    const restore = runs.findIndex((run) => run.startsWith("actions/cache/restore"));
    const setup = runs.findIndex((run) => run.includes("dist/submission-validation/host/setup-vm.js"));
    const save = runs.findIndex((run) => run.startsWith("actions/cache/save"));
    const smoke = runs.findIndex((run) => run === "npm run smoke:submission-validation");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(setup);
    expect(setup).toBeLessThan(save);
    expect(save).toBeLessThan(smoke);
    expect(ciJobs.smoke.steps[save]?.if).toBe("steps.lean-cache.outputs.cache-hit != 'true'");
    // Same store identity as submission.yml: a divergent key would double the
    // provisioning cost and let the two paths drift onto different pins.
    let cacheSteps = 0;
    for (const step of ciJobs.smoke.steps) {
      if (step.uses?.startsWith("actions/cache/") !== true) continue;
      cacheSteps += 1;
      expect(step.with?.key).toBe(HOST_CACHE_KEY);
      for (const cached of HOST_CACHE_PATHS) expect(step.with?.path).toContain(cached);
    }
    expect(cacheSteps).toBe(2);
  });

  it("equips the check job for the paper web e2es before the test step", () => {
    // paper-web-plan.md stage 2: the reflow e2es need lualatex (+ tikz), a
    // dvisvgm with the mutool PDF backend, fontspec's Latin Modern OTFs, and
    // the hash-pinned encode venv from `reflowtex:fetch` — installed before
    // `npm test`, with the venv cached on the lock so warm runs stay fast.
    const runs = ciJobs.check.steps.map((step) => step.run ?? step.uses ?? "");
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
    const venvCache = ciJobs.check.steps.find((step) => step.with?.path === "reflowtex/venv");
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

describe("release workflow wiring", () => {
  // The npm trusted-publisher registration names this repository and the
  // workflow *file*, so the filename itself is load-bearing: renaming
  // release.yml silently breaks publishing until the registration follows.
  const job = releaseParsed.jobs.publish!;

  it("publishes only from version tags, with OIDC and nothing else", () => {
    expect(Object.keys(releaseParsed.jobs)).toEqual(["publish"]);
    expect(releaseParsed.on).toEqual({ push: { tags: ["v*"] } });
    // id-token is the trusted-publishing credential; contents stays read-only
    // and no other grant exists that a compromised test could reach.
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    const setupNode = job.steps.find((step) => step.uses?.startsWith("actions/setup-node"));
    expect(setupNode?.with).toMatchObject({ "registry-url": "https://registry.npmjs.org" });
  });

  it("provisions the host toolchain before the test gate", () => {
    // The fast suite drives real elan/lake against the fake mathlib; without
    // this ordering the release gate dies at `spawn lake ENOENT` on a bare
    // runner. Same store identity and save-from-trusted-provisioning-only
    // discipline as ci.yml and the trusted validate job.
    const runs = job.steps.map((step) => step.run ?? step.uses ?? "");
    const build = runs.indexOf("npm run build");
    const restore = runs.findIndex((run) => run.startsWith("actions/cache/restore"));
    const setup = runs.findIndex((run) => run.includes("dist/submission-validation/host/setup-vm.js"));
    const save = runs.findIndex((run) => run.startsWith("actions/cache/save"));
    const test = runs.indexOf("npm test");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(restore);
    expect(restore).toBeLessThan(setup);
    expect(setup).toBeLessThan(save);
    expect(save).toBeLessThan(test);
    expect(job.steps[save]?.if).toBe("steps.lean-cache.outputs.cache-hit != 'true'");
    let cacheSteps = 0;
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/cache/") !== true) continue;
      cacheSteps += 1;
      expect(step.with?.key).toBe(HOST_CACHE_KEY);
      for (const cached of HOST_CACHE_PATHS) expect(step.with?.path).toContain(cached);
    }
    expect(cacheSteps).toBe(2);
  });

  it("vendors the page-builder after the last build and packs without scripts", () => {
    // `npm run build` wipes dist/ (including dist/cli/vendor), so the vendored
    // page-builder must land after the final build, and `npm pack` must run
    // with --ignore-scripts or prepack would rebuild and wipe it again.
    const runs = job.steps.map((step) => step.run ?? step.uses ?? "");
    const vendor = runs.findIndex((run) => run.includes("page-builder:fetch"));
    expect(runs[vendor]).toContain("page-builder:package");
    expect(runs[vendor]).toContain("page-builder:verify");
    const pack = runs.findIndex((run) => run.startsWith("npm pack"));
    const publish = runs.findIndex((run) => run.startsWith("npm publish"));
    const lastBuild = runs.lastIndexOf("npm run build");
    expect(lastBuild).toBeLessThan(vendor);
    expect(vendor).toBeLessThan(pack);
    expect(runs[pack]).toContain("--ignore-scripts");
    // Publishing the packed tarball (not the working tree) is what keeps
    // prepack from running a vendor-wiping rebuild inside `npm publish`.
    expect(pack).toBeLessThan(publish);
    expect(runs[publish]).toContain(".tgz");
    // The tag/package.json equality check must gate everything downstream.
    const tagCheck = job.steps.findIndex((step) => step.name === "Check release tag");
    expect(tagCheck).toBeGreaterThanOrEqual(0);
    expect(tagCheck).toBeLessThan(vendor);
  });
});

function nextJobOffset(jobText: string): number {
  const match = /\n {2}[a-z-]+:\n/gu;
  match.lastIndex = 1;
  const found = match.exec(jobText);
  return found === null ? jobText.length : found.index;
}
