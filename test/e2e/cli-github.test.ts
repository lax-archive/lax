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
import { resultMarker } from "../../src/shared/workflow-comments.js";
import { GITHUB_APP_CLIENT_ID } from "../../src/cli/github-app.js";
import {
  FAKE_USER_CODE,
  refreshTokenFor,
  startFakeGitHub,
  tokenFor,
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
    env = { LAX_HOME: home, ...github.env() };
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
          resultMarker(comment.id),
        user: { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" },
      });
    };
    try {
      const result = await lax(["delete", "lax-42", "--yes"], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Command submitted:");
      expect(result.stdout).toContain("Publication failed");
      expect(result.stdout).toContain("lax-42 is registered and immutable");
      // the hidden correlation marker never reaches the author's terminal
      expect(result.stdout).not.toContain("lax-result-comment-id");
      // and the command itself was posted as the logged-in author
      const posted = github.state.issueComments.get(42)!.find((c) => c.user.login === "alice");
      expect(posted?.body).toBe("/lax delete");
    } finally {
      delete github.state.onComment;
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
