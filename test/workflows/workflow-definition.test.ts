import fs from "node:fs";
import { describe, expect, it } from "vitest";

const workflowsDirectory = new URL("../../.github/workflows/", import.meta.url);
const workflowFiles = fs
  .readdirSync(workflowsDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
const workflow = fs.readFileSync(new URL("../../.github/workflows/submission.yml", import.meta.url), "utf8");
const ciWorkflow = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const runtimeWorkflow = fs.readFileSync(
  new URL("../../.github/workflows/validation-runtime.yml", import.meta.url),
  "utf8",
);
const releaseWorkflow = fs.readFileSync(
  new URL("../../.github/workflows/release-cli.yml", import.meta.url),
  "utf8",
);
const codeowners = fs.readFileSync(new URL("../../.github/CODEOWNERS", import.meta.url), "utf8");

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

  it("disables dependency lifecycle scripts in every workflow install", () => {
    for (const file of workflowFiles) {
      const definition = fs.readFileSync(new URL(file, workflowsDirectory), "utf8");
      expect(definition, file).not.toMatch(/run:\s+npm ci\s*$/mu);
      for (const match of definition.matchAll(/run:\s+npm ci[^\n]*/gu)) {
        expect(match[0], file).toContain("--ignore-scripts");
      }
    }
  });
});

describe("workflow ownership", () => {
  it("requires maintainers for every workflow that can assume the trusted bot identity", () => {
    const workflowRules = codeowners
      .split("\n")
      .filter((line) => line.trimStart().startsWith("/.github/workflows/"));
    expect(workflowRules).toEqual(["/.github/workflows/ @lax-archive/maintainers"]);
  });
});

describe("submission workflow definition", () => {
  it("queues workflow and publication runs per issue", () => {
    expect(workflow.match(/queue: max/gu)).toHaveLength(3);
    expect(workflow).not.toContain("cancel-in-progress");
    expect(workflow).toContain(
      "github.event.comment.user.id || github.event.issue.user.id || github.run_id",
    );
    expect(
      workflow.match(
        /group: lax-archive-publish-\$\{\{ github\.repository_id \}\}-\$\{\{ github\.event\.issue\.number \}\}/gu,
      ),
    ).toHaveLength(2);
  });

  it("checks bounded human commands and real reservation issues before checkout", () => {
    const precheck = workflow.slice(workflow.indexOf("  precheck:"), workflow.indexOf("  route:"));
    expect(precheck).toContain('Buffer.byteLength(commentBody, "utf8") <= 16 * 1024');
    expect(precheck).toContain('/^\\/lax(?:\\s|$)/u.test(commentBody)');
    expect(precheck).toContain("lax-submission-id:lax-[1-9][0-9]{5}");
    expect(precheck).toContain('event.comment?.user?.type === "User"');
    expect(precheck).toMatch(/event\.comment\?\.user\?\.type === "User" && reservedIssue && commandComment/u);
    expect(precheck).toContain('TextDecoder("utf-8", { fatal: true })');
    expect(precheck).toContain("permissions: {}");
    expect(precheck).not.toContain("actions/checkout");
    expect(workflow).toContain("needs: precheck");
    expect(workflow).toContain("if: needs.precheck.outputs.should_run == 'true'");
  });

  it("routes updates through first-class Compile, Replay, and Inspect DAG jobs", () => {
    expect(workflow).not.toContain("validate-submission:");
    expect(workflow).toContain("compile:\n    name: Compile");
    expect(workflow).toContain("replay:\n    name: Replay\n    needs: [route, compile]");
    expect(workflow).toContain("inspect:\n    name: Inspect\n    needs: [route, replay]");
    expect(workflow).toContain("needs.compile.result == 'success'");
    expect(workflow).toContain("needs.replay.result == 'success'");
    expect(workflow).toContain("validation-result:\n    name: Validation result\n    needs: [route, inspect]");
    expect(workflow).toContain("needs.inspect.result == 'success'");
    expect(workflow).toContain("publish-update:\n    needs: [route, validation-result]");
    expect(workflow).toContain("needs.validation-result.outputs.should_publish == 'true'");
    expect(workflow).not.toMatch(/^  report-validation:/mu);
    expect(workflow.match(/runs-on: ubuntu-latest/gu)!.length).toBeGreaterThanOrEqual(3);
    expect(workflow.match(/Reclaim hosted-runner disk/gu)).toHaveLength(3);
    expect(workflow.match(/Ensure the pinned warm runtime is local/gu)).toHaveLength(3);
    expect(workflow.match(/Remove registry credentials before validation/gu)).toHaveLength(3);
    expect(workflow.match(/run: docker logout ghcr\.io/gu)).toHaveLength(3);
    expect(workflow).toContain("node dist/submission-validation/run.js compile");
    expect(workflow).toContain("node dist/submission-validation/run.js replay");
    expect(workflow).toContain("node dist/submission-validation/run.js inspect");
    expect(workflow).toContain("submission-validation-compile-${{ github.event.issue.number }}");
    expect(workflow).toContain("submission-validation-replay-${{ github.event.issue.number }}");
    expect(workflow).toContain(".build/submission-validation-compile.tar");
    expect(workflow).toContain(".build/submission-validation-replay.tar");
    expect(workflow.match(/--create/gu)).toHaveLength(2);
    expect(workflow.match(/--extract/gu)).toHaveLength(2);
    expect(workflow.match(/- name: Clean validation workspace\n        if: always\(\)/gu)).toHaveLength(3);
    expect(workflow).toContain(".build/submission-validation/validation-report.json");
    expect(workflow).toContain(".build/submission-validation/generated-build-output.json");
    expect(workflow).toContain(".build/submission-validation/capture.tar");
    expect(workflow).toContain("node dist/workflows/submission.js report-validation");
    expect(workflow).toContain("VALIDATION_REQUEST: ${{ needs.route.outputs.validation_request }}");
  });

  it("separates database publication from Website credential creation", () => {
    const publish = workflow.slice(workflow.indexOf("  publish:"), workflow.indexOf("  compile:"));
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
    expect(update).toContain("permission-administration: read");
    expect(update).toContain("permission-contents: write");
  });

  it("reports validation directly only when validation did not succeed", () => {
    const result = workflow.slice(workflow.indexOf("  validation-result:"), workflow.indexOf("  # The first step"));
    expect(result).toContain("should_publish=${{ needs.inspect.result == 'success' }}");
    expect(result).toContain("steps.outcome.outputs.should_publish != 'true'");
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

describe("core CI workflow definition", () => {
  it("checks both pushes and pull requests", () => {
    expect(ciWorkflow).toMatch(/on:\n\s+push:\n\s+pull_request:/u);
  });
});

describe("validation runtime workflow definition", () => {
  it("allows manual image publication only from main", () => {
    expect(runtimeWorkflow).toContain(
      "if: github.event_name == 'push' || github.ref == 'refs/heads/main'",
    );
  });

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

describe("CLI release workflow definition", () => {
  it("builds reviewed main history without OIDC and publishes only the transferred artifact", () => {
    const build = releaseWorkflow.slice(
      releaseWorkflow.indexOf("  build:"),
      releaseWorkflow.indexOf("  publish:"),
    );
    const publish = releaseWorkflow.slice(releaseWorkflow.indexOf("  publish:"));
    expect(build).toContain('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main');
    expect(build).toContain("persist-credentials: false");
    expect(build).not.toContain("id-token: write");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("npm ci");
    expect(publish).toContain("actions/download-artifact@");
    expect(publish).toContain("npm publish");
    expect(publish).toContain("--ignore-scripts");
  });
});
