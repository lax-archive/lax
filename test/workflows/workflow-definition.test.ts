import fs from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(new URL("../../.github/workflows/submission.yml", import.meta.url), "utf8");
const runtimeWorkflow = fs.readFileSync(
  new URL("../../.github/workflows/validation-runtime.yml", import.meta.url),
  "utf8",
);

describe("submission workflow definition", () => {
  it("queues per-issue and global publication runs", () => {
    expect(workflow.match(/queue: max/gu)).toHaveLength(3);
    expect(workflow).not.toContain("cancel-in-progress");
    expect(workflow).toContain("group: lax-archive-publish");
  });

  it("checks the first four comment characters before checkout", () => {
    const precheck = workflow.slice(workflow.indexOf("  precheck:"), workflow.indexOf("  route:"));
    expect(precheck).toContain('event.comment.body.slice(0, 4) === "/lax"');
    expect(precheck).toContain('TextDecoder("utf-8", { fatal: true })');
    expect(precheck).not.toContain("actions/checkout");
    expect(workflow).toContain("needs: precheck");
    expect(workflow).toContain("if: needs.precheck.outputs.should_run == 'true'");
  });

  it("routes updates to an isolated warm-runtime validation job", () => {
    expect(workflow).toContain("validate-submission:");
    expect(workflow).toContain("needs.route.outputs.operation == 'validate'");
    expect(workflow).toContain("runs-on: [self-hosted, linux, x64, lax-validation]");
    expect(workflow).toContain("LAX_VALIDATION_IMAGE: ${{ vars.LAX_VALIDATION_IMAGE }}");
    expect(workflow).toContain("node dist/submission-validation/run.js");
    expect(workflow).toContain(".build/submission-validation/validation-report.json");
    expect(workflow).toContain(".build/submission-validation/generated-build-output.json");
    expect(workflow).toContain(".build/submission-validation/capture.tar");
    expect(workflow).toContain("report-validation:");
    expect(workflow).toContain("VALIDATION_REQUEST: ${{ needs.route.outputs.validation_request }}");
  });

  it("separates database publication from Website credential creation", () => {
    const publish = workflow.slice(workflow.indexOf("  publish:"), workflow.indexOf("  validate-submission:"));
    const website = workflow.slice(workflow.indexOf("  website:"), workflow.indexOf("  report-validation:"));
    expect(publish).toContain("Mint lax-database token");
    expect(publish).not.toContain("Mint lax-website dispatch token");
    expect(publish).not.toContain("LAX_WEBSITE_TOKEN");
    expect(website).toContain("needs: [route, publish, publish-update]");
    expect(website).toContain("needs.publish.outputs.archive_commit != ''");
    expect(website).toContain("needs.publish-update.outputs.archive_commit != ''");
    expect(website).toContain("Mint lax-website dispatch token");
  });

  it("checks update artifacts and fresh state before minting the database token", () => {
    const update = workflow.slice(workflow.indexOf("  publish-update:"), workflow.indexOf("  # Website"));
    const prepare = update.indexOf("Parse artifacts and revalidate current state");
    const mint = update.indexOf("Mint lax-database token");
    const publish = update.indexOf("Promote capture and publish trusted update");
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(mint);
    expect(mint).toBeLessThan(publish);
    expect(update).toContain("steps.prepare-update.outputs.should_publish == 'true'");
    expect(update).toContain("GENERATED_BUILD_OUTPUT_PATH:");
    expect(update).toContain("VALIDATION_CAPTURE_PATH:");
    expect(update).toContain("permission-contents: write");
  });

  it("reports validation directly only when validation did not succeed", () => {
    const report = workflow.slice(workflow.indexOf("  report-validation:"), workflow.indexOf("  # TypeScript reports"));
    expect(report).toContain("needs.validate-submission.result != 'success'");
  });

  it("has a correlated fallback for setup and action failures", () => {
    const fallback = workflow.slice(workflow.indexOf("  report-workflow-failure:"));
    expect(fallback).toContain("always()");
    expect(fallback).toContain("actions/github-script@v7");
    expect(fallback).toContain("lax-result-comment-id");
    expect(fallback).toContain("lax-workflow-run-id");
  });
});

describe("validation runtime workflow definition", () => {
  it("tests the built digest before publishing it as a usable runtime artifact", () => {
    expect(runtimeWorkflow).toContain("src/submission-validation/**");
    expect(runtimeWorkflow).toContain("test/smoke/**");
    expect(runtimeWorkflow).toContain(
      "LAX_VALIDATION_IMAGE: ghcr.io/${{ github.repository_owner }}/submission-validation-runtime@${{ steps.image.outputs.digest }}",
    );
    expect(runtimeWorkflow).toContain("npm run smoke:submission-validation");
    expect(runtimeWorkflow.indexOf("npm run smoke:submission-validation")).toBeLessThan(
      runtimeWorkflow.indexOf("Record the immutable image reference"),
    );
  });
});
