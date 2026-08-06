// Drift guard for the live-rehearsal drill (scripts/rehearsal/, recorded in
// history/live-rehearsal.md). The scratch control repository is pushed with a
// patched submission.yml that is derived at run time — there is deliberately
// no checked-in fork, because a stale one would rehearse a workflow production
// no longer runs. This test runs the real deriver against the real workflow so
// that drift in submission.yml breaks `npm test` rather than the drill.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const script = fileURLToPath(new URL("../../scripts/rehearsal/patch-workflow.mjs", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/submission.yml", import.meta.url));
const source = fs.readFileSync(workflowPath, "utf8");

const patched = execFileSync(
  process.execPath,
  [script, "--owner", "jan3er", "--prefix", "lax-scratch"],
  { encoding: "utf8" },
);

// Same loading approach as workflow-definition.test.ts: the `yaml` package the
// production code already depends on.
interface WorkflowJob {
  environment?: string;
  steps?: Array<{ name?: string; uses?: string; env?: Record<string, string> }>;
}
const parsed = YAML.parse(patched) as {
  env?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

describe("the rehearsal workflow patch", () => {
  it("deletes every App-token mint step and its key references", () => {
    // The scratch repos have no Lax GitHub App; an App-token step left behind
    // would fail the run, and a surviving key reference would be a live
    // production credential name in a disposable public repository.
    expect(source).toContain("actions/create-github-app-token");
    expect(source.match(/actions\/create-github-app-token/gu)).toHaveLength(3);
    // The header prose names the removed action; the workflow body must not.
    const body = patched.slice(patched.indexOf("name: submission control plane"));
    expect(body).not.toContain("actions/create-github-app-token");
    for (const key of [
      "LAX_DATABASE_APP_ID",
      "LAX_WEBSITE_APP_ID",
      "LAX_DATABASE_APP_PRIVATE_KEY",
      "LAX_WEBSITE_APP_PRIVATE_KEY",
    ]) {
      expect(body, key).not.toContain(key);
    }
  });

  it("switches exactly the three consuming steps to the scratch token", () => {
    // One consumer per removed mint step, each still behind its protected
    // environment: the token placement mirrors the production posture.
    const consumers = Object.entries(parsed.jobs).flatMap(([job, definition]) =>
      (definition.steps ?? [])
        .filter((step) => Object.values(step.env ?? {}).includes("${{ secrets.LAX_SCRATCH_TOKEN }}"))
        .map((step) => [job, step.name, definition.environment] as const),
    );
    expect(consumers).toEqual([
      ["publish-update", "Promote capture and publish trusted update", "lax-database-publish"],
      ["publish", "Revalidate and publish lax-database", "lax-database-publish"],
      ["website", "Dispatch Website and report the final result", "lax-website-dispatch"],
    ]);
    // No step id survives pointing at a mint step that no longer exists.
    expect(patched).not.toContain("steps.database-token.outputs.token");
    expect(patched).not.toContain("steps.website-token.outputs.token");
  });

  it("names all four scratch repositories in a workflow-level env block", () => {
    // These are the constants of src/shared/constants.ts; without all four the
    // rehearsal would write to a production repository.
    expect(parsed.env).toEqual({
      LAX_CONTROL_REPOSITORY: "jan3er/lax-scratch-control",
      LAX_DATABASE_REPOSITORY: "jan3er/lax-scratch-database",
      // The database repo also hosts the repository_dispatch receiver.
      LAX_WEBSITE_REPOSITORY: "jan3er/lax-scratch-database",
      LAX_CAPTURES_REPOSITORY: "jan3er/lax-scratch-captures",
    });
  });

  it("produces parseable YAML with the job graph intact", () => {
    expect(() => YAML.parse(patched)).not.toThrow();
    expect(Object.keys(parsed.jobs).sort()).toEqual(
      Object.keys((YAML.parse(source) as { jobs: Record<string, unknown> }).jobs).sort(),
    );
  });

  it("fails loudly instead of emitting a patch it cannot justify", () => {
    // The whole point of deriving at run time: a submission.yml that no longer
    // has the expected structure must break the drill, not be silently forked.
    const drifted = source.replace(/^\s+uses: actions\/create-github-app-token.*$/mu, "");
    const input = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lax-rehearsal-")), "submission.yml");
    fs.writeFileSync(input, drifted);
    let message = "";
    try {
      execFileSync(process.execPath, [script, "--owner", "jan3er", "--prefix", "lax-scratch", "--input", input], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      throw new Error("the patch script accepted a drifted workflow");
    } catch (error) {
      message = `${(error as { stderr?: string }).stderr ?? ""}${(error as Error).message}`;
    }
    expect(message).toMatch(/drifted: expected 3 .* steps, found 2/u);
  });
});
