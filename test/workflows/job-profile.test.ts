import { describe, expect, it } from "vitest";
import { collectJobProfile } from "../../src/workflows/job-profile.js";

interface StepFixture {
  name: string;
  started_at: string | null;
  completed_at: string | null;
  conclusion?: string | null;
}

function job(overrides: {
  name: string;
  runner_name?: string | null;
  status?: string;
  started_at?: string | null;
  steps?: StepFixture[];
}): unknown {
  return {
    id: 1,
    name: overrides.name,
    runner_name: overrides.runner_name ?? null,
    status: overrides.status ?? "in_progress",
    started_at: overrides.started_at ?? null,
    completed_at: null,
    steps: (overrides.steps ?? []).map((step, index) => ({
      number: index + 1,
      status: "completed",
      conclusion: step.conclusion ?? "success",
      ...step,
    })),
  };
}

function client(jobs: unknown[], seen: string[] = []): { request<T>(method: string, path: string): Promise<T> } {
  return {
    async request<T>(_method: string, path: string): Promise<T> {
      seen.push(path);
      return { jobs } as T;
    },
  };
}

const environment = {
  GITHUB_REPOSITORY: "lax-archive/lax",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "2",
  RUNNER_NAME: "GitHub Actions 7",
  GITHUB_JOB: "compile",
};

describe("job cost profile", () => {
  it("turns the running job's step timings into a span tree", async () => {
    const seen: string[] = [];
    const span = await collectJobProfile(
      client(
        [
          job({ name: "Compile", runner_name: "GitHub Actions 7", started_at: "2026-08-04T10:00:00Z", steps: [
            { name: "Set up job", started_at: "2026-08-04T10:00:00Z", completed_at: "2026-08-04T10:00:03Z" },
            { name: "Run npm ci", started_at: "2026-08-04T10:00:03Z", completed_at: "2026-08-04T10:00:33Z" },
            { name: "Ensure the pinned warm runtime is local", started_at: "2026-08-04T10:00:33Z", completed_at: "2026-08-04T10:02:33Z" },
            { name: "Compile", started_at: "2026-08-04T10:02:33Z", completed_at: "2026-08-04T10:07:33Z" },
          ] }),
          job({ name: "Inspect", runner_name: "GitHub Actions 9" }),
        ],
        seen,
      ),
      environment,
    );

    expect(seen).toEqual(["/repos/lax-archive/lax/actions/runs/42/attempts/2/jobs?per_page=100"]);
    expect(span?.name).toBe("job Compile");
    expect(span?.ms).toBe(7 * 60_000 + 33_000);
    expect(span?.children.map((child) => child.name)).toEqual([
      "Set up job",
      "Run npm ci",
      "Ensure the pinned warm runtime is local",
      "Compile",
    ]);
    expect(span?.children[1]!.ms).toBe(30_000);
    expect(span?.children[2]!.ms).toBe(120_000);
  });

  it("reports the still-running collector step instead of dropping it", async () => {
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const span = await collectJobProfile(
      client([
        job({ name: "Inspect", runner_name: "GitHub Actions 7", started_at: startedAt, steps: [
          { name: "Record job cost", started_at: startedAt, completed_at: null },
        ] }),
      ]),
      environment,
    );
    expect(span?.children).toHaveLength(1);
    expect(span?.children[0]!.ms).toBeGreaterThanOrEqual(4_000);
  });

  it("marks skipped steps and falls back to the job key when no runner matches", async () => {
    const span = await collectJobProfile(
      client([
        job({ name: "compile", started_at: "2026-08-04T10:00:00Z", steps: [
          { name: "Preserve failed validation report", started_at: "2026-08-04T10:00:00Z", completed_at: "2026-08-04T10:00:00Z", conclusion: "skipped" },
        ] }),
      ]),
      { ...environment, RUNNER_NAME: "" },
    );
    expect(span?.children[0]!.name).toBe("Preserve failed validation report (skipped)");
  });

  it("stays silent outside Actions and when the job cannot be identified", async () => {
    expect(await collectJobProfile(client([]), {})).toBeUndefined();
    expect(
      await collectJobProfile(client([]), { ...environment, GITHUB_REPOSITORY: "not a repo" }),
    ).toBeUndefined();
    expect(
      await collectJobProfile(
        client([job({ name: "a" }), job({ name: "b" })]),
        { ...environment, RUNNER_NAME: "", GITHUB_JOB: "c" },
      ),
    ).toBeUndefined();
  });
});
