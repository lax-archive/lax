import fs from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const workflowsDirectory = new URL("../../.github/workflows/", import.meta.url);
const workflowFiles = fs
  .readdirSync(workflowsDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
const workflow = fs.readFileSync(new URL("../../.github/workflows/submission.yml", import.meta.url), "utf8");

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
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

describe("GitHub Actions dependency pins", () => {
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

describe("submission workflow definition", () => {
  it("queues workflow and publication runs per issue", () => {
    expect(workflow.match(/queue: max/gu)).toHaveLength(3);
    expect(workflow).not.toContain("cancel-in-progress");
    expect(
      workflow.match(
        /group: lax-archive-publish-\$\{\{ github\.repository_id \}\}-\$\{\{ github\.event\.issue\.number \}\}/gu,
      ),
    ).toHaveLength(2);
  });

  it("checks the first four comment characters before checkout", () => {
    const precheck = workflow.slice(workflow.indexOf("  precheck:"), workflow.indexOf("  route:"));
    expect(precheck).toContain('event.comment.body.slice(0, 4) === "/lax"');
    expect(precheck).toContain('TextDecoder("utf-8", { fatal: true })');
    expect(precheck).not.toContain("actions/checkout");
    expect(workflow).toContain("needs: precheck");
    expect(workflow).toContain("if: needs.precheck.outputs.should_run == 'true'");
  });

  it("collapses validation into exactly one job", () => {
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
    // The three-stage machinery is gone: no stage entry points, no tarball
    // handoffs, no per-job stitching, no registry login.
    expect(workflow).not.toMatch(/run\.js (compile|replay|inspect|cleanup)/u);
    expect(workflow).not.toContain("stage-state");
    expect(workflow).not.toContain("--create");
    expect(workflow).not.toContain("--extract");
    expect(workflow).not.toContain("docker/login-action");
    expect(workflow).not.toContain("ghcr.io");
    expect(workflow).not.toContain("job-profile");
    expect(workflow).not.toContain("LAX_VALIDATION_IMAGE");
    expect(workflow).not.toContain("packages: read");
    expect(workflow).not.toContain("actions: read");
    expect(workflow).not.toMatch(/^\s*docker system prune/mu);
    expect(workflow).not.toMatch(/^\s*sudo rm -rf/mu);
  });

  it("gives the job that executes submission code a read-only token and nothing else", () => {
    expect(jobs.validate.permissions).toEqual({ contents: "read" });
    const checkout = jobs.validate.steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    for (const step of jobs.validate.steps) {
      expect(JSON.stringify(step.env ?? {})).not.toContain("secrets.");
    }
  });

  it("provisions the pinned host toolchain before running validation", () => {
    const runs = jobs.validate.steps.map((step) => step.run ?? step.uses ?? "");
    const restore = runs.findIndex((run) => run.startsWith("actions/cache/restore"));
    const setup = runs.findIndex((run) => run.includes("dist/submission-validation/host/setup-vm.js"));
    const save = runs.findIndex((run) => run.startsWith("actions/cache/save"));
    const validate = runs.findIndex((run) => run === "node dist/submission-validation/run.js");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(setup);
    expect(setup).toBeLessThan(save);
    // Save the cache before untrusted submission code can touch the store.
    expect(save).toBeLessThan(validate);
    // The cache identity is the reviewed pins module plus a layout salt.
    for (const step of jobs.validate.steps) {
      if (step.uses?.startsWith("actions/cache/") !== true) continue;
      expect(step.with?.key).toBe(
        "lax-validation-host-v1-${{ runner.os }}-${{ hashFiles('src/submission-validation/pins.ts') }}",
      );
      expect(step.with?.path).toContain("~/.elan");
      expect(step.with?.path).toContain("~/.lax/warm");
      expect(step.with?.path).toContain("~/.lax/tools");
    }
    const validateStep = jobs.validate.steps.find(
      (step) => step.run === "node dist/submission-validation/run.js",
    );
    expect(validateStep?.env?.VALIDATION_REQUEST).toBe(
      "${{ needs.route.outputs.validation_request }}",
    );
  });

  it("always uploads the one validation artifact", () => {
    const upload = jobs.validate.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.name).toBe("submission-validation-${{ github.event.issue.number }}");
    expect(upload?.with?.["retention-days"]).toBe(30);
    for (const filename of [
      "validation-report.json",
      "validation-profile.json",
      "generated-build-output.json",
      "capture.tar",
    ]) {
      expect(upload?.with?.path).toContain(`.build/submission-validation/${filename}`);
    }
    expect(workflow.match(/upload-artifact/gu)).toHaveLength(1);
  });

  it("joins the validation result before reporting or publishing", () => {
    expect(jobs["validation-result"].needs).toEqual(["route", "validate"]);
    expect(jobs["validation-result"].if).toBe(
      "always() && needs.route.outputs.operation == 'validate'",
    );
    expect(jobs["validation-result"].permissions).toEqual({ contents: "read", issues: "write" });
    const result = workflow.slice(workflow.indexOf("  validation-result:"), workflow.indexOf("  # The first step"));
    expect(result).toContain("needs.validate.result == 'success'");
    expect(result).toContain("steps.outcome.outputs.should_publish != 'true'");
    expect(result).toContain("node dist/workflows/submission.js report-validation");
    const download = jobs["validation-result"].steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact"),
    );
    expect(download?.["continue-on-error"]).toBe(true);
    expect(download?.with?.name).toBe("submission-validation-${{ github.event.issue.number }}");
    expect(jobs["publish-update"].needs).toEqual(["route", "validation-result"]);
    expect(jobs["publish-update"].if).toContain(
      "needs.validation-result.outputs.should_publish == 'true'",
    );
  });

  it("separates database publication from Website credential creation", () => {
    const publish = workflow.slice(workflow.indexOf("  publish:"), workflow.indexOf("  # Website"));
    const website = workflow.slice(workflow.indexOf("  website:"), workflow.indexOf("  # TypeScript reports"));
    expect(publish).toContain("Mint lax-database token");
    expect(publish).toContain("environment: lax-database-publish");
    expect(publish).toContain("vars.LAX_DATABASE_APP_ID");
    expect(publish).toContain("secrets.LAX_DATABASE_APP_PRIVATE_KEY");
    expect(publish).toContain("permission-administration: read");
    expect(publish).not.toContain("Mint lax-website dispatch token");
    expect(publish).not.toContain("LAX_WEBSITE_TOKEN");
    expect(website).toContain("needs: [route, publish, publish-update]");
    expect(website).toContain("needs.publish.outputs.archive_commit != ''");
    expect(website).toContain("needs.publish-update.outputs.archive_commit != ''");
    expect(website).toContain("Mint lax-website dispatch token");
    expect(website).toContain("environment: lax-website-dispatch");
    expect(website).toContain("vars.LAX_WEBSITE_APP_ID");
    expect(website).toContain("secrets.LAX_WEBSITE_APP_PRIVATE_KEY");
    expect(website).not.toContain("LAX_DATABASE_APP_PRIVATE_KEY");
    expect(workflow).not.toContain("secrets.LAX_APP_ID");
    expect(workflow).not.toContain("secrets.LAX_APP_PRIVATE_KEY");
  });

  it("declares the validation branch before the shorter publish branch", () => {
    expect(workflow.indexOf("  validate:")).toBeLessThan(workflow.indexOf("  publish:"));
    expect(workflow.indexOf("  publish-update:")).toBeLessThan(workflow.indexOf("  publish:"));
    expect(workflow.indexOf("  publish:")).toBeLessThan(workflow.indexOf("  website:"));
  });

  it("checks update artifacts and fresh state before minting the database token", () => {
    const update = workflow.slice(workflow.indexOf("  publish-update:"), workflow.indexOf("  publish:"));
    const prepare = update.indexOf("Parse artifacts and revalidate current state");
    const mint = update.indexOf("Mint lax-database token");
    const publish = update.indexOf("Promote capture and publish trusted update");
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(mint);
    expect(mint).toBeLessThan(publish);
    expect(update).toContain("steps.prepare-update.outputs.should_publish == 'true'");
    expect(update).toContain("GENERATED_BUILD_OUTPUT_PATH:");
    expect(update).toContain("VALIDATION_CAPTURE_PATH:");
    expect(update).toContain("permission-administration: read");
    expect(update).toContain("permission-contents: write");
    // Only the trusted update publisher pushes captures to ghcr, with the
    // job's own GITHUB_TOKEN; no other job holds a packages grant.
    expect(jobs["publish-update"].permissions).toEqual({
      contents: "read",
      issues: "write",
      packages: "write",
    });
    expect(jobs.publish.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("has a correlated fallback for setup and action failures", () => {
    const fallback = workflow.slice(workflow.indexOf("  report-workflow-failure:"));
    expect(fallback).toContain("always()");
    expect(fallback).toContain(
      "actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b",
    );
    expect(fallback).toContain("lax-result-comment-id");
    expect(fallback).toContain("lax-workflow-run-id");
  });
});
