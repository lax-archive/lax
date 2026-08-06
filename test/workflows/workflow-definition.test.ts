// Wiring, permission, and pin assertions over .github/workflows/submission.yml
// and .github/workflows/ci.yml. Everything here is structure that only exists
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
const ciWorkflow = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

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

/** The one cache identity both the trusted validate job and the CI smoke use. */
const HOST_CACHE_KEY =
  "lax-validation-host-v1-${{ runner.os }}-${{ hashFiles('src/submission-validation/pins.ts') }}";
const HOST_CACHE_PATHS = ["~/.elan", "~/.lax/warm", "~/.lax/tools"];

// ---------------------------------------------------------------------------
// Pins: supply-chain lint that can only live at the YAML level.
// ---------------------------------------------------------------------------
describe("GitHub Actions dependency pins", () => {
  // A mutable tag would let a compromised action publish into trusted jobs.
  it.each(workflowFiles)("pins every external action in %s to a full commit SHA", (file) => {
    const definition = fs.readFileSync(new URL(file, workflowsDirectory), "utf8");
    const references = [...definition.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu)].map(
      (match) => match[1],
    );

    for (const reference of references) {
      if (reference.startsWith("./")) continue;
      expect(reference, `${file}: ${reference}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
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
    // appearing here must be a conscious decision, not drift.
    expect(Object.keys(jobs).sort()).toEqual([
      "precheck",
      "publish",
      "publish-update",
      "report-workflow-failure",
      "route",
      "validate",
      "validation-result",
      "website",
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
  it("gates unrelated comments before checkout or dependency installation", () => {
    // The precheck must stay checkout-free: it runs on every issue comment on
    // the repository, so nothing may be installed or executed from the tree.
    // Its four-character prefix test is inline by necessity — there is no
    // built tree to dispatch into before the first checkout.
    const precheck = workflow.slice(workflow.indexOf("  precheck:"), workflow.indexOf("  route:"));
    expect(precheck).not.toContain("actions/checkout");
    expect(precheck).toContain('event.comment.body.slice(0, 4) === "/lax"');
    expect(jobs.route.needs).toBe("precheck");
    expect(jobs.route.if).toBe("needs.precheck.outputs.should_run == 'true'");
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
    // poison every later run (rewrite-plan.md stage 3 execution notes).
    const runs = jobs.validate.steps.map((step) => step.run ?? step.uses ?? "");
    const restore = runs.findIndex((run) => run.startsWith("actions/cache/restore"));
    const setup = runs.findIndex((run) => run.includes("dist/submission-validation/host/setup-vm.js"));
    const save = runs.findIndex((run) => run.startsWith("actions/cache/save"));
    const validate = runs.findIndex((run) => run === "node dist/submission-validation/run.js");
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
  it("hands the validation output to trusted jobs through one aligned artifact", () => {
    // The artifact is the only channel between the untrusted validate job and
    // the trusted publisher; its file names must match outputs.ts exactly or
    // the publisher's re-validation reads nothing.
    const upload = jobs.validate.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.name).toBe("submission-validation-${{ github.event.issue.number }}");
    expect(upload?.with?.["retention-days"]).toBe(30);
    for (const filename of [
      VALIDATION_REPORT_FILENAME,
      VALIDATION_PROFILE_FILENAME,
      GENERATED_BUILD_OUTPUT_FILENAME,
      CAPTURE_FILENAME,
    ]) {
      expect(upload?.with?.path).toContain(`.build/submission-validation/${filename}`);
    }
    expect(workflow.match(/upload-artifact/gu)).toHaveLength(1);
    // Every download must name the same artifact the validate job uploaded.
    for (const name of ["validation-result", "publish-update"]) {
      const download = jobs[name].steps.find((step) => step.uses?.startsWith("actions/download-artifact"));
      expect(download?.with?.name, name).toBe("submission-validation-${{ github.event.issue.number }}");
      expect(download?.with?.path, name).toBe(".build/submission-validation");
    }
  });

  // -------------------------------------------------------------------------
  // Join semantics: success and failure stay on one visible DAG path.
  // -------------------------------------------------------------------------
  it("joins the validation result before reporting or publishing", () => {
    // validation-result is the single join between the untrusted validate job
    // and everything privileged; publish-update must run only behind it.
    expect(jobs["validation-result"].needs).toEqual(["route", "validate"]);
    expect(jobs["validation-result"].if).toBe(
      "always() && needs.route.outputs.operation == 'validate'",
    );
    expect(jobs["validation-result"].permissions).toEqual({ contents: "read", issues: "write" });
    const download = jobs["validation-result"].steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact"),
    );
    // A failed validate job may have uploaded nothing; reporting still runs.
    expect(download?.["continue-on-error"]).toBe(true);
    expect(jobs["publish-update"].needs).toEqual(["route", "validation-result"]);
    expect(jobs["publish-update"].if).toContain(
      "needs.validation-result.outputs.should_publish == 'true'",
    );
  });

  // -------------------------------------------------------------------------
  // Credential separation: each App key scoped to its own environment/job.
  // -------------------------------------------------------------------------
  it("checks update artifacts and fresh state before minting the database token", () => {
    // Trust rule 2: the credential-free preflight step must complete before
    // the App key is touched, so a forged artifact can never reach a token.
    const update = workflow.slice(workflow.indexOf("  publish-update:"), workflow.indexOf("  publish:"));
    const prepare = update.indexOf("Parse artifacts and revalidate current state");
    const mint = update.indexOf("Mint lax-database token");
    const publish = update.indexOf("Promote capture and publish trusted update");
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(mint);
    expect(mint).toBeLessThan(publish);
    expect(update).toContain("steps.prepare-update.outputs.should_publish == 'true'");
    expect(update).toContain("environment: lax-database-publish");
    // Only the trusted update publisher pushes captures to ghcr, with the
    // job's own GITHUB_TOKEN; no other job holds a packages grant.
    expect(jobs["publish-update"].permissions).toEqual({
      contents: "read",
      issues: "write",
      packages: "write",
    });
    expect(jobs.publish.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("separates database publication from Website credential creation", () => {
    // Each job mints only its own App token inside its own protected
    // environment; a cross-reference would collapse the two trust domains.
    const publish = workflow.slice(workflow.indexOf("  publish:"), workflow.indexOf("  # Website"));
    const website = workflow.slice(workflow.indexOf("  website:"), workflow.indexOf("  # TypeScript reports"));
    expect(publish).toContain("environment: lax-database-publish");
    expect(publish).toContain("vars.LAX_DATABASE_APP_ID");
    expect(publish).toContain("secrets.LAX_DATABASE_APP_PRIVATE_KEY");
    expect(publish).toContain("permission-administration: read");
    expect(publish).not.toContain("Mint lax-website dispatch token");
    expect(publish).not.toContain("LAX_WEBSITE_TOKEN");
    expect(website).toContain("environment: lax-website-dispatch");
    expect(website).toContain("vars.LAX_WEBSITE_APP_ID");
    expect(website).toContain("secrets.LAX_WEBSITE_APP_PRIVATE_KEY");
    expect(website).not.toContain("LAX_DATABASE_APP_PRIVATE_KEY");
    // Website credentials exist only after lax-database advanced.
    expect(jobs.website.needs).toEqual(["route", "publish", "publish-update"]);
    expect(jobs.website.if).toContain("needs.publish.outputs.archive_commit != ''");
    expect(jobs.website.if).toContain("needs.publish-update.outputs.archive_commit != ''");
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
    expect(fallback.needs).toEqual([
      "precheck",
      "route",
      "publish",
      "publish-update",
      "website",
      "validation-result",
    ]);
    expect(fallback.if).toContain("always()");
    for (const dependency of fallback.needs as string[]) {
      expect(fallback.if).toContain(`needs.${dependency}.result == 'failure'`);
    }
    expect(fallback.permissions).toEqual({ contents: "read", issues: "write" });
    const report = fallback.steps.at(-1);
    expect(report?.run).toBe("node dist/workflows/submission.js report-failure");
    expect(Object.keys(report?.env ?? {}).sort()).toEqual([
      "ACTION",
      "ARCHIVE_COMMIT",
      "GITHUB_TOKEN",
      "LAX_REPOSITORY_ID",
      "OPERATION",
      "VALIDATION_RESULT",
    ]);
    // No inline JS anywhere: github-script was the last untyped logic host.
    expect(workflow).not.toContain("actions/github-script");
  });

  it("declares the validation branch before the shorter publish branch", () => {
    // Declaration order drives GitHub's automatic DAG layout; keep the long
    // validation row on top so run pages stay readable.
    expect(workflow.indexOf("  validate:")).toBeLessThan(workflow.indexOf("  publish:"));
    expect(workflow.indexOf("  publish-update:")).toBeLessThan(workflow.indexOf("  publish:"));
    expect(workflow.indexOf("  publish:")).toBeLessThan(workflow.indexOf("  website:"));
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

  it("keeps the test seams out of the smoke job", () => {
    // The smoke asserts the real pins (it refuses to start with LAX_MATHLIB_*
    // set); a seam leaking into CI would turn the gate into a fake-mathlib
    // rerun of what the host suite already covers.
    expect(ciWorkflow).not.toContain("LAX_MATHLIB_");
    expect(ciWorkflow).not.toContain("LAX_CAPTURE_REGISTRY_URL");
    expect(ciWorkflow).not.toContain("LAX_GITHUB_API_URL");
  });
});

function nextJobOffset(jobText: string): number {
  const match = /\n {2}[a-z-]+:\n/gu;
  match.lastIndex = 1;
  const found = match.exec(jobText);
  return found === null ? jobText.length : found.index;
}
