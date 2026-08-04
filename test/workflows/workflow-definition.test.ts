import fs from "node:fs";
import { describe, expect, it } from "vitest";

const workflowsDirectory = new URL("../../.github/workflows/", import.meta.url);
const workflowFiles = fs
  .readdirSync(workflowsDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
const workflow = fs.readFileSync(new URL("../../.github/workflows/submission.yml", import.meta.url), "utf8");
const runtimeWorkflow = fs.readFileSync(
  new URL("../../.github/workflows/validation-runtime.yml", import.meta.url),
  "utf8",
);
const stagedValidationRunner = fs.readFileSync(
  new URL("../../src/submission-validation/run.ts", import.meta.url),
  "utf8",
);

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

  it("routes updates through first-class Compile, Replay, and Inspect DAG jobs", () => {
    expect(workflow).not.toContain("validate-submission:");
    expect(workflow).toContain("compile:\n    name: Compile");
    expect(workflow).toContain("replay:\n    name: Replay\n    needs: compile");
    expect(workflow).toContain("inspect:\n    name: Inspect\n    needs: compile");
    expect(workflow.match(/if: needs\.compile\.result == 'success'/gu)).toHaveLength(2);
    expect(workflow).toContain("validation_request: ${{ needs.route.outputs.validation_request }}");
    expect(workflow.match(/VALIDATION_REQUEST: \$\{\{ needs\.compile\.outputs\.validation_request \}\}/gu)).toHaveLength(2);
    expect(workflow).not.toContain("needs.replay.outputs.validation_request");
    expect(workflow).not.toContain("needs: [route, compile]");
    expect(workflow).not.toContain("needs: [route, replay]");
    expect(workflow).toContain("validation-result:\n    name: Validation result\n    needs: [route, replay, inspect]");
    expect(workflow).toContain("needs.replay.result == 'success'");
    expect(workflow).toContain("needs.inspect.result == 'success'");
    expect(workflow).toContain("publish-update:\n    needs: [route, validation-result]");
    expect(workflow).toContain("needs.validation-result.outputs.should_publish == 'true'");
    expect(workflow).not.toMatch(/^  report-validation:/mu);
    expect(workflow.match(/runs-on: ubuntu-latest/gu)!.length).toBeGreaterThanOrEqual(3);
    // Each validation job materializes the pinned runtime and nothing else.
    // The runner has ~88 GB free before the pull, so reclaiming disk bought
    // headroom nothing wanted; the comments explaining the absence may name
    // the old commands, but no step may run them.
    expect(workflow.match(/Fetch the pinned warm runtime/gu)).toHaveLength(3);
    expect(workflow).not.toMatch(/^\s*docker system prune/mu);
    expect(workflow).not.toMatch(/^\s*sudo rm -rf/mu);
    expect(workflow).toContain("node dist/submission-validation/run.js compile");
    expect(workflow).toContain("node dist/submission-validation/run.js replay");
    expect(workflow).toContain("node dist/submission-validation/run.js inspect");
    expect(stagedValidationRunner).toContain(
      'stage === "replay" ? ["compile"] : ["compile", "replay"]',
    );
    expect(workflow).toContain("submission-validation-compile-${{ github.event.issue.number }}");
    expect(workflow).toContain("submission-validation-replay-report-${{ github.event.issue.number }}");
    expect(workflow).toContain(".build/submission-validation-compile.tar");
    expect(workflow).not.toContain(".build/submission-validation-replay.tar");
    expect(workflow.match(/Restore Compile handoff/gu)).toHaveLength(2);
    expect(workflow.match(/Unpack Compile handoff/gu)).toHaveLength(2);
    expect(workflow.match(/--create/gu)).toHaveLength(1);
    expect(workflow.match(/--extract/gu)).toHaveLength(2);
    expect(workflow.match(/- name: Clean validation workspace\n        if: always\(\)/gu)).toHaveLength(3);
    expect(workflow).toContain(".build/submission-validation/validation-report.json");
    expect(workflow).toContain(".build/submission-validation/generated-build-output.json");
    expect(workflow).toContain(".build/submission-validation/capture.tar");
    expect(workflow).toContain("node dist/workflows/submission.js report-validation");
    expect(workflow).toContain("VALIDATION_REQUEST: ${{ needs.route.outputs.validation_request }}");
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
    expect(workflow.indexOf("  compile:")).toBeLessThan(workflow.indexOf("  publish:"));
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
  });

  it("joins Replay and Inspect before reporting or publishing", () => {
    const result = workflow.slice(workflow.indexOf("  validation-result:"), workflow.indexOf("  # The first step"));
    expect(result).toContain("needs.replay.result == 'success'");
    expect(result).toContain("needs.inspect.result == 'success'");
    expect(result).toContain("steps.outcome.outputs.should_publish != 'true'");
    expect(result).toContain("Restore Replay failure report");
    expect(result).toContain("Restore Compile or Inspect validation report");
    expect(result).toContain("node dist/workflows/submission.js report-validation");
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

describe("validation runtime workflow definition", () => {
  it("tests the built digest before publishing it as a usable runtime artifact", () => {
    expect(runtimeWorkflow).toContain("src/submission-validation/**");
    expect(runtimeWorkflow).toContain("test/smoke/**");
    expect(runtimeWorkflow).toContain("runs-on: ubuntu-latest");
    expect(runtimeWorkflow).toContain("Reclaim hosted-runner disk");
    expect(runtimeWorkflow).toContain(
      "org.opencontainers.image.source=https://github.com/${{ github.repository }}",
    );
    expect(runtimeWorkflow).toContain(
      "LAX_VALIDATION_IMAGE: ghcr.io/${{ github.repository_owner }}/submission-validation-runtime@${{ steps.image.outputs.digest }}",
    );
    expect(runtimeWorkflow).toContain("npm run smoke:submission-validation");
    expect(runtimeWorkflow.indexOf("npm run smoke:submission-validation")).toBeLessThan(
      runtimeWorkflow.indexOf("Record the immutable image reference"),
    );
    expect(runtimeWorkflow.indexOf("Record the immutable image reference")).toBeLessThan(
      runtimeWorkflow.indexOf("name: validation-image"),
    );
  });
});
