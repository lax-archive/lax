// Subprocess-level CLI tests against the fake GitHub (test/fake-github.ts):
// the real `lax` process, spawned the same way an author runs it, talking to
// a local HTTP fake through the LAX_GITHUB_API_URL/LAX_GITHUB_OAUTH_URL test
// seams. This is the executable proof that `lax login` completes the GitHub
// App device flow end to end and that later commands reach the API through
// the stored credentials.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTROL_REPOSITORY_ID,
  GITHUB_ACTIONS_BOT_ID,
  GITHUB_ACTIONS_BOT_LOGIN,
} from "../../src/shared/constants.js";
import {
  appendWorkflowRun,
  outcomeMarker,
  previewMarker,
  resultMarker,
  upsertCommandContext,
} from "../../src/shared/workflow-comments.js";
import { GITHUB_APP_CLIENT_ID } from "../../src/cli/github-app.js";
import {
  artifactZip,
  FAKE_USER_CODE,
  refreshTokenFor,
  startFakeGitHub,
  tokenFor,
  type FakeActionsRun,
  type FakeGitHub,
  type RecordedRequest,
} from "../fake-github.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Spawn the real CLI. Async (not spawnSync) so this test process's event
 * loop stays free to serve the fake-GitHub HTTP requests. */
function lax(
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const inherited = { ...process.env };
  // Never let ambient credentials or seams leak into the subprocess.
  delete inherited.LAX_GITHUB_APP_USER_TOKEN;
  delete inherited.LAX_HOME;
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "src", "cli", "main.ts"),
      ...args,
    ],
    {
      cwd: repoRoot,
      env: { ...inherited, LAX_DISABLE_UPDATE_CHECK: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe.sequential("CLI against the fake GitHub (subprocess)", () => {
  let github: FakeGitHub;
  let home: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    github = await startFakeGitHub({ pendingPolls: 1, users: "alice:1" });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-cli-github-"));
    // `lax doctor` brings the database checkout up to date, and the fake
    // GitHub does not speak git: without a remote of our own it would clone
    // the real lax-database over the network into this shared home, which the
    // later `lax delete` preflight would then read as authoritative. A remote
    // that does not exist keeps every command in this file offline.
    env = {
      LAX_HOME: home,
      LAX_DATABASE_URL: path.join(home, "no-such-remote.git"),
      ...github.env(),
    };
  });

  afterAll(async () => {
    await github.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("completes the device-flow login and stores mode-restricted App credentials", async () => {
    const result = await lax(["login"], env);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`enter code ${FAKE_USER_CODE}`);
    // the poll loop is not silent: one heartbeat per wait (spinning on a TTY),
    // ending in the bare URL so terminal linkification stays intact
    expect(result.stdout).toContain(
      `waiting for authorization — enter code ${FAKE_USER_CODE} at https://github.com/login/device\n`,
    );
    expect(result.stdout).toContain("Logged in as alice through the Lax GitHub App.");

    const credentialsFile = path.join(home, "credentials.json");
    const stored = JSON.parse(fs.readFileSync(credentialsFile, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 1,
      kind: "github-app-user",
      clientId: GITHUB_APP_CLIENT_ID,
      accessToken: tokenFor("alice"),
      refreshToken: refreshTokenFor("alice"),
    });
    expect(fs.statSync(credentialsFile).mode & 0o777).toBe(0o600);

    // The fake saw the whole flow: device code, a pending poll plus the
    // granting poll (each bound to the Lax repository id), and the identity
    // lookup with the issued ghu_ token.
    const paths = github.requests.map((request: RecordedRequest) => request.path);
    expect(paths.filter((p) => p === "/login/device/code")).toHaveLength(1);
    const polls = github.requests.filter((r) => r.path === "/login/oauth/access_token");
    expect(polls).toHaveLength(2);
    for (const poll of polls) {
      expect(poll.body).toMatchObject({
        client_id: GITHUB_APP_CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        repository_id: String(CONTROL_REPOSITORY_ID),
      });
    }
    const user = github.requests.find((r) => r.path === "/user");
    expect(user?.authorization).toBe(`Bearer ${tokenFor("alice")}`);
  });

  it("reaches the API through the stored credentials in `lax doctor`", async () => {
    const before = github.requests.length;
    const result = await lax(["doctor"], env);

    expect(result.stdout).toContain(`github auth: alice (GitHub App ${GITHUB_APP_CLIENT_ID}`);
    expect(result.stdout).toContain(path.join(home, "credentials.json"));

    const during = github.requests.slice(before);
    expect(during.find((r) => r.path === "/user")?.authorization).toBe(
      `Bearer ${tokenFor("alice")}`,
    );
    expect(during.map((r) => r.path)).toContain("/repos/lax-archive/lax/issues?per_page=1");
  });

  it("surfaces the bot's refusal comment on delete", async () => {
    // The end-to-end refusal path: `lax delete` posts the issue command, the
    // control-plane bot answers with a refusal result comment, and the CLI
    // follows the correlation marker and prints the refusal to the author.
    github.state.onComment = (issue, comment) => {
      if (!comment.body.startsWith("/lax delete")) return;
      github.state.issueComments.get(issue)!.push({
        id: comment.id + 500_000,
        body:
          "Publication failed; lax-database was not changed by this command.\n\n" +
          "- lax-42 is registered and immutable\n\n" +
          resultMarker(comment.id) +
          "\n" +
          outcomeMarker("failure"),
        user: { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" },
      });
    };
    try {
      const result = await lax(["delete", "lax-42", "--yes"], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("lax delete: command posted:");
      expect(result.stdout).toContain("Publication failed");
      expect(result.stdout).toContain("lax-42 is registered and immutable");
      expect(result.stderr).toContain("lax delete: FAILED");
      // the hidden correlation marker never reaches the author's terminal
      expect(result.stdout).not.toContain("lax-result-comment-id");
      // and the command itself was posted as the logged-in author
      const posted = github.state.issueComments.get(42)!.find((c) => c.user.login === "alice");
      expect(posted?.body).toBe("/lax delete");
    } finally {
      delete github.state.onComment;
    }
  });

  it("reattaches an interrupted submit with `lax submit --resume`", async () => {
    // The submit that died: its `/lax submit` comment is on the issue and the
    // workflow has already appended the run correlation to it. Nothing about
    // that run is stored on this machine — the CLI may have been killed before
    // it learned its own comment id — so resume must re-derive both the
    // command comment and the run from the issue's recent comments.
    const source = JSON.stringify({
      repository: "https://github.com/alice/formalization",
      commit: "0".repeat(40),
      folder: ".",
    });
    github.state.issueComments.set(77, [
      {
        id: 5001,
        body: upsertCommandContext(
          `/lax submit ${source}`,
          5001,
          appendWorkflowRun(`Parsed source preview for lax-77.\n\n${previewMarker(5001)}`, {
            id: "777",
            url: "https://github.com/lax-archive/lax/actions/runs/777",
          }),
        ),
        user: { id: 1, login: "alice", type: "User" },
      },
    ]);
    github.state.actionsRuns.set("777", {
      status: "in_progress",
      conclusion: null,
      jobs: [
        {
          name: "validate",
          status: "in_progress",
          conclusion: null,
          steps: [{ name: "Compile", status: "in_progress", conclusion: null }],
        },
      ],
    });
    // The run finishes only once the reattached CLI has polled it at least
    // once, so the test proves the live poll rather than racing it. Both
    // progress requests must have been served before the flip: the CLI fetches
    // the run status and the job list in parallel, and flipping between them
    // would hand the job/step assertion an already-emptied job list.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lax-resume-"));
    fs.writeFileSync(path.join(folder, "manifest.yaml"), "id: lax-77\n");
    const finish = setInterval(() => {
      const polled =
        github.requests.some(
          (request) => request.path === "/repos/lax-archive/lax/actions/runs/777",
        ) &&
        github.requests.some((request) =>
          request.path.startsWith("/repos/lax-archive/lax/actions/runs/777/jobs"),
        );
      if (!polled) return;
      clearInterval(finish);
      github.state.actionsRuns.set("777", { status: "completed", conclusion: "success", jobs: [] });
      github.state.issueComments.get(77)!.push({
        id: 5002,
        body: appendWorkflowRun(
          `Published **lax-77**.\n\n${resultMarker(5001)}`,
          { id: "777", url: "https://github.com/lax-archive/lax/actions/runs/777" },
          "success",
        ),
        user: { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" },
      });
    }, 20);

    try {
      const result = await lax(["submit", "--resume", folder], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(0);
      // the folder's manifest, not a stored job id, names the issue
      expect(result.stdout).toContain("resuming lax-77");
      expect(result.stdout).toContain("#issuecomment-5001");
      expect(result.stdout).toContain(
        "lax submit: workflow run #777: https://github.com/lax-archive/lax/actions/runs/777",
      );
      // submit already printed the triple it sent; the echo is not repeated
      expect(result.stdout).not.toContain("Parsed source preview for lax-77.");
      // and the result reaches the author as text, not as markdown
      expect(result.stdout).toContain("lax submit: Published lax-77.");
      expect(result.stdout).not.toContain("lax-result-comment-id");
      // resume polled the correlated run itself, and posted no new command
      expect(github.requests.map((r) => r.path)).toContain(
        "/repos/lax-archive/lax/actions/runs/777",
      );
      expect(github.state.issueComments.get(77)).toHaveLength(2);
      // and the live job/step line came from that run
      expect(result.stderr).toContain("lax submit · validating: compile, kernel replay, inspection");
    } finally {
      clearInterval(finish);
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("prints the validate job's findings from the report artifact and stops there", async () => {
    // The failing submit: the author never sees a record comment, because the
    // verdict is the report the credential-free validate job uploaded, and it
    // reaches the terminal in the same shape `lax build` prints locally.
    const folder = seedSubmit(80, "800", {
      status: "in_progress",
      conclusion: null,
      jobs: [{ name: "Validate", status: "completed", conclusion: "failure" }],
    });
    github.state.actionsArtifacts.set("800", [
      {
        id: 3080,
        name: "submission-validation-report-80",
        zip: artifactZip({
          "validation-report.json": JSON.stringify({
            reportVersion: 1,
            ok: false,
            warnings: [],
            violations: [{
              phase: "compile-proofs",
              rule: "build",
              message: "Proofs/Main.lean:9:2: error: unsolved goals\n⊢ False",
            }],
          }),
        }),
      },
    ]);

    try {
      const result = await lax(["submit", "--resume", folder], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("lax submit: found 1 error during validation");
      expect(result.stderr).toContain("      - [build] Proofs/Main.lean:9:2: error: unsolved goals");
      expect(result.stderr).toContain("        ⊢ False");
      expect(result.stderr).toContain("lax submit: validation failed; lax-database was not changed");
      expect(result.stderr).toContain("lax submit: FAILED");
      // No result comment was posted, and none was waited for.
      expect(github.state.issueComments.get(80)).toHaveLength(1);
      // The download took the redirect to the blob, and only the API leg
      // carried the author's credential.
      const blob = github.requests.find((request) => request.path === "/artifact-blobs/3080");
      expect(blob?.authorization).toBeUndefined();
      expect(
        github.requests.find((r) => r.path === "/repos/lax-archive/lax/actions/artifacts/3080/zip")
          ?.authorization,
      ).toBe(`Bearer ${tokenFor("alice")}`);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("prints validation warnings and keeps following to the outcome comment", async () => {
    // A passing validation is not the end of a submit: publication and the
    // website dispatch can still fail, so the CLI prints what the report warns
    // about and goes on waiting for the record comment.
    const folder = seedSubmit(81, "801", {
      status: "in_progress",
      conclusion: null,
      jobs: [{ name: "Validate", status: "completed", conclusion: "success" }],
    });
    github.state.actionsArtifacts.set("801", [
      {
        id: 3081,
        name: "submission-validation-report-81",
        zip: artifactZip({
          "validation-report.json": JSON.stringify({
            reportVersion: 1,
            ok: true,
            warnings: [{ phase: "inspect", rule: "abstract", message: "the abstract is very short" }],
            violations: [],
          }),
        }),
      },
    ]);
    // The record comment only appears once the report has been read, so the
    // test proves the artifact was consulted rather than racing it.
    const finish = setInterval(() => {
      if (!github.requests.some((request) => request.path === "/artifact-blobs/3081")) return;
      clearInterval(finish);
      github.state.actionsRuns.set("801", { status: "completed", conclusion: "success", jobs: [] });
      github.state.issueComments.get(81)!.push({
        id: 5081,
        body: appendWorkflowRun(
          `Published **lax-81**.\n\n${resultMarker(5001)}`,
          { id: "801", url: "https://github.com/lax-archive/lax/actions/runs/801" },
          "success",
        ),
        user: { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" },
      });
    }, 20);

    try {
      const result = await lax(["submit", "--resume", folder], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("lax submit: found 1 warning during validation");
      expect(result.stderr).toContain("      - [abstract] the abstract is very short");
      expect(result.stdout).toContain("lax submit: Published lax-81.");
    } finally {
      clearInterval(finish);
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("names the missing Actions permission when the report cannot be read", async () => {
    const folder = seedSubmit(82, "802", {
      status: "in_progress",
      conclusion: null,
      jobs: [{ name: "Validate", status: "completed", conclusion: "failure" }],
    });
    // An author whose token predates the Actions-read grant.
    github.state.artifactListStatus = 403;

    try {
      const result = await lax(["submit", "--resume", folder], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("could not read the validation report");
      expect(result.stderr).toContain("Actions read permission");
      expect(result.stderr).toContain("run `lax login`");
      // An authoritative refusal, so no "lost contact with GitHub" guess.
      expect(result.stderr).not.toContain("lost contact with GitHub");
    } finally {
      delete github.state.artifactListStatus;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  /** An issue mid-submit: alice's command comment, its run, and a folder to
   * name the submission — everything `lax submit --resume` re-derives from. */
  function seedSubmit(issue: number, runId: string, run: FakeActionsRun): string {
    const source = JSON.stringify({
      repository: "https://github.com/alice/formalization",
      commit: "0".repeat(40),
      folder: ".",
    });
    github.state.issueComments.set(issue, [
      {
        id: 5001,
        body: upsertCommandContext(
          `/lax submit ${source}`,
          5001,
          appendWorkflowRun(`Parsed source preview for lax-${issue}.\n\n${previewMarker(5001)}`, {
            id: runId,
            url: `https://github.com/lax-archive/lax/actions/runs/${runId}`,
          }),
        ),
        user: { id: 1, login: "alice", type: "User" },
      },
    ]);
    github.state.actionsRuns.set(runId, run);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lax-resume-"));
    fs.writeFileSync(path.join(folder, "manifest.yaml"), `id: lax-${issue}\n`);
    return folder;
  }

  it("refuses to resume an issue that carries no submit of yours", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lax-resume-"));
    fs.writeFileSync(path.join(folder, "manifest.yaml"), "id: lax-78\n");
    try {
      const result = await lax(["submit", "--resume", folder], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no submit command of yours is on lax-78");
      expect(result.stderr).toContain("run `lax submit` instead");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("names the exact recovery command when it loses contact with GitHub", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lax-resume-"));
    fs.writeFileSync(path.join(folder, "manifest.yaml"), "id: lax-79\n");
    try {
      // port 1 is refused: a transport failure, not an authoritative HTTP answer
      const result = await lax(["submit", "--resume", folder], {
        ...env,
        LAX_GITHUB_API_URL: "http://127.0.0.1:1",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("lost contact with GitHub; the workflow run may still be going");
      expect(result.stderr).toContain(`lax submit: reattach with: lax submit --resume ${folder}`);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("revokes both stored tokens on `lax logout`", async () => {
    const result = await lax(["logout"], env);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Revoked the GitHub App credentials and logged out.");
    expect(fs.existsSync(path.join(home, "credentials.json"))).toBe(false);
    expect(github.state.revoked).toEqual([tokenFor("alice"), refreshTokenFor("alice")]);
    const revoke = github.requests.find((r) => r.path === "/credentials/revoke");
    expect(revoke?.method).toBe("POST");
    expect(revoke?.authorization).toBeUndefined();
  });
});
