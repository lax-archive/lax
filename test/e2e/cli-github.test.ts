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
import { EPOCH } from "../../src/submission-validation/environments.js";
import { linkSharedDirs } from "../support/host.js";
import { removeTree } from "../support/tmp.js";
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
      env: { ...inherited, LAX_DISABLE_UPDATE_CHECK: "1", NO_COLOR: "1", ...env },
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
    // Linked to the shared warm store, not bare: `lax doctor` runs in this
    // home and now builds the store when it finds none, which would rebuild
    // the whole workspace per run and seal it read-only inside the temp home
    // (unremovable afterwards as any user but root).
    home = linkSharedDirs(fs.mkdtempSync(path.join(os.tmpdir(), "lax-cli-github-")));
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
    removeTree(home);
  });

  it("completes the device-flow login and stores mode-restricted App credentials", async () => {
    const result = await lax(["login"], env);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // The scope notice is above the code — a thing to read before authorizing
    // — and the code and URL are plain lines, not spinner text, so a redirected
    // log still carries everything the terminal showed.
    expect(result.stdout).toContain("read your public GitHub profile");
    expect(result.stdout).toContain("Open        https://github.com/login/device");
    expect(result.stdout).toContain(`Enter code  ${FAKE_USER_CODE}`);
    expect(result.stdout).toContain("✓ Signed in as alice");
    // A finished command reports what it did and stops there: the author knows
    // what they came to do, and being told it back is noise.
    expect(result.stdout).not.toContain("Next  ");

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
    const result = await lax(["doctor", "--verbose"], env);

    // The handle is the whole answer on the happy path; which App and which
    // credentials file it came from is exactly what a bug report needs, so it
    // lives behind --verbose.
    expect(result.stdout).toMatch(/Account\s+alice/u);
    expect(result.stdout).toContain(GITHUB_APP_CLIENT_ID);
    expect(result.stdout).toContain(path.join(home, "credentials.json"));
    // The shared store satisfies the check outright; a home that made doctor
    // build its own would say "built just now" and leave a sealed tree behind.
    expect(result.stdout).toMatch(/✓ Mathlib\s+ready/u);
    expect(result.stdout).not.toContain("built just now");

    const during = github.requests.slice(before);
    expect(during.find((r) => r.path === "/user")?.authorization).toBe(
      `Bearer ${tokenFor("alice")}`,
    );
    expect(during.map((r) => r.path)).toContain("/repos/lax-archive/lax/issues?per_page=1");
  });

  it("scaffolds under a local six-digit id without asking GitHub", async () => {
    // The login above is stored and valid, so anything this command sends
    // would be sent successfully — which is what makes an unchanged request
    // log evidence that init itself is loginless rather than evidence about a
    // missing credential. The hidden flag remains accepted for old scripts.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lax-offline-"));
    const folder = path.join(parent, "work");
    try {
      const before = github.requests.length;
      const result = await lax(["init", "--offline", folder, "--title", "Offline draft"], env);

      expect(result.status).toBe(0);
      expect(github.requests.length).toBe(before);
      // The rows that exist only to reach the archive are not drawn at all.
      expect(result.stdout).not.toContain("Signed in as");
      expect(result.stdout).not.toContain("Reserving");
      expect(result.stdout).toContain("✓ Created the files");
      expect(result.stdout).toMatch(/lax-[1-9][0-9]{5} · Offline draft/u);
      expect(result.stdout).toContain("Nothing was sent to GitHub and no login was needed.");
      expect(fs.readFileSync(path.join(folder, "manifest.yaml"), "utf8")).toMatch(
        /^id: lax-[1-9][0-9]{5}$/mu,
      );
    } finally {
      removeTree(parent);
    }
  });

  it("scaffolds in the environment --env names, and refuses one it does not admit", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lax-env-"));
    try {
      // Naming the epoch is the default said out loud: no block, no prompt,
      // and the same folder either way.
      const folder = path.join(parent, "epoch");
      const chosen = await lax(["init", folder, "--env", EPOCH, "--title", "Epoch draft"], env);
      expect(chosen.status).toBe(0);
      expect(chosen.stdout).not.toContain("can cite this work");
      expect(fs.readFileSync(path.join(folder, "manifest.yaml"), "utf8")).toContain(
        `leanVersion: "${EPOCH}"`,
      );

      // An environment this CLI does not know is a CLI that is behind, and the
      // message an agent reads says exactly that plus what it may choose from.
      const unknown = await lax(["init", path.join(parent, "future"), "--env", "v9.9.9"], env);
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain("v9.9.9 is not an archive environment");
      expect(unknown.stderr).toContain(`${EPOCH} (epoch)`);
      expect(unknown.stderr).toContain("Update lax if the environment is newer than this CLI.");
      expect(fs.existsSync(path.join(parent, "future"))).toBe(false);
    } finally {
      removeTree(parent);
    }
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
          "- lax-41 is registered and immutable\n\n" +
          resultMarker(comment.id) +
          "\n" +
          outcomeMarker("failure"),
        user: { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" },
      });
    };
    try {
      const result = await lax(["delete", "lax-41", "--yes"], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(1);
      // The archive's own words are the diagnosis, in the report's own column;
      // the comment URL that carried them is a --verbose internal.
      expect(result.stdout).toContain("✗ the archive refused this command");
      expect(result.stdout).toContain("Publication failed");
      expect(result.stdout).toContain("lax-41 is registered and immutable");
      expect(result.stdout).not.toContain("command posted:");
      // the exit code carries the failure, so nothing is said twice
      expect(result.stderr).toBe("");
      // the hidden correlation marker never reaches the author's terminal
      expect(result.stdout).not.toContain("lax-result-comment-id");
      // and the command itself was posted as the logged-in author
      const posted = github.state.issueComments.get(41)!.find((c) => c.user.login === "alice");
      expect(posted?.body).toBe("/lax delete lax-41");
    } finally {
      delete github.state.onComment;
    }
  });

  it("tidies the registry and closes the tracking issue after a successful delete", async () => {
    // The TODO follow-up from the paper round trip: a deleted submission
    // must not linger in ~/.lax/submissions.json for `lax doctor`, and the
    // tracking issue — which the trusted workflow leaves open — is closed
    // by the author's own CLI.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lax-delete-"));
    fs.mkdirSync(path.join(parent, "work"));
    const folder = fs.realpathSync(path.join(parent, "work"));
    writeBoundManifest(folder, 43);
    const registryFile = path.join(home, "submissions.json");
    const registered: string[] = fs.existsSync(registryFile)
      ? (JSON.parse(fs.readFileSync(registryFile, "utf8")) as string[])
      : [];
    fs.writeFileSync(registryFile, JSON.stringify([...registered, folder], null, 1));
    github.state.onComment = (issue, comment) => {
      if (!comment.body.startsWith("/lax delete")) return;
      github.state.issueComments.get(issue)!.push({
        id: comment.id + 500_000,
        body:
          "Deleted **lax-43**; the id is permanently retired.\n\n" +
          resultMarker(comment.id) +
          "\n" +
          outcomeMarker("success"),
        user: { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" },
      });
    };
    try {
      const result = await lax(["delete", folder, "--yes"], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("✓ Deleted");
      expect(result.stdout).toContain("lax-43 is gone.");
      expect(result.stderr).toBe("");
      // The folder's registry entry is dropped — the folder itself stays.
      const remaining = JSON.parse(fs.readFileSync(registryFile, "utf8")) as string[];
      expect(remaining).not.toContain(folder);
      expect(fs.existsSync(path.join(folder, "manifest.yaml"))).toBe(true);
      // The tracking issue was closed as the author, with a completed reason.
      expect(github.state.issuePatches.get(43)).toEqual({
        state: "closed",
        state_reason: "completed",
      });
      const patch = github.requests.find(
        (request) => request.method === "PATCH" && request.path === "/repos/lax-archive/lax/issues/43",
      );
      expect(patch?.authorization).toBe(`Bearer ${tokenFor("alice")}`);
    } finally {
      delete github.state.onComment;
      removeTree(parent);
    }
  });

  it("still reports a successful delete when the issue cannot be closed", async () => {
    github.state.onComment = (issue, comment) => {
      if (!comment.body.startsWith("/lax delete")) return;
      github.state.issueComments.get(issue)!.push({
        id: comment.id + 500_000,
        body:
          "Deleted **lax-46**; the id is permanently retired.\n\n" +
          resultMarker(comment.id) +
          "\n" +
          outcomeMarker("success"),
        user: { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" },
      });
    };
    github.state.issuePatchStatus = 403;
    try {
      const result = await lax(["delete", "lax-46", "--yes"], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      // The delete itself succeeded; the leftover issue is a note, not a failure.
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("lax-46 is gone.");
      expect(result.stdout).toContain("! The tracking issue could not be closed");
      expect(result.stdout).toContain("issues/46");
    } finally {
      delete github.state.onComment;
      delete github.state.issuePatchStatus;
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
          `/lax submit lax-77 ${source}`,
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
    writeBoundManifest(folder, 77);
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
      // --verbose so the correlation this test is about is on screen; without
      // it the run id, the comment it reattached to, and the record comment are
      // all internals the author cannot act on.
      const result = await lax(["submit", "--resume", folder, "--verbose"], {
        ...env,
        LAX_POLL_INTERVAL_MS: "25",
        LAX_WORKFLOW_TIMEOUT_MS: "30000",
      });

      expect(result.status).toBe(0);
      // the folder's manifest, not a stored job id, names the issue
      expect(result.stdout).toContain("Submitting lax-77");
      expect(result.stdout).toContain("Reattaching to the run already in progress.");
      expect(result.stdout).toContain("#issuecomment-5001");
      expect(result.stdout).toContain(
        "workflow run #777: https://github.com/lax-archive/lax/actions/runs/777",
      );
      // submit already printed the source it sent; the echo is not repeated
      expect(result.stdout).not.toContain("Parsed source preview for lax-77.");
      // and the author gets one verdict and one link, not the record comment
      expect(result.stdout).toContain("✓ Wrote the public record");
      expect(result.stdout).toContain("lax-77 is a draft in the archive");
      expect(result.stdout).toContain("https://laxarchive.org/lax-77/");
      expect(result.stdout).not.toContain("lax-result-comment-id");
      // resume polled the correlated run itself, and posted no new command
      expect(github.requests.map((r) => r.path)).toContain(
        "/repos/lax-archive/lax/actions/runs/777",
      );
      expect(github.state.issueComments.get(77)).toHaveLength(2);
      expect(result.stderr).toBe("");
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
      // The report is the verdict, in the author's nouns for the phase, and the
      // transcript keeps its lines.
      expect(result.stdout).toContain("✗ 1 error");
      expect(result.stdout).toContain("proofs · build");
      expect(result.stdout).toContain("Proofs/Main.lean:9:2: error: unsolved goals");
      expect(result.stdout).toContain("⊢ False");
      expect(result.stdout).toContain("lax-80 was not published");
      expect(result.stdout).not.toContain("lax-database");
      expect(result.stderr).toBe("");
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

  it("prints an infrastructure outcome without presenting a submission error", async () => {
    const folder = seedSubmit(82, "802", {
      status: "in_progress",
      conclusion: null,
      jobs: [{ name: "Validate", status: "completed", conclusion: "failure" }],
    });
    github.state.actionsArtifacts.set("802", [
      {
        id: 3082,
        name: "submission-validation-report-82",
        zip: artifactZip({
          "validation-report.json": JSON.stringify({
            reportVersion: 1,
            ok: false,
            warnings: [],
            violations: [],
            failure: {
              kind: "infrastructure",
              retryable: true,
              phase: "source",
              rule: "archive-snapshot",
              message: "GitHub returned HTTP 503",
            },
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
      expect(result.stdout).toContain("validation infrastructure failed");
      expect(result.stdout).toContain("source/archive-snapshot");
      expect(result.stdout).toContain("retrying it unchanged may succeed");
      expect(result.stdout).toContain("lax-82 could not be validated");
      expect(result.stdout).not.toContain("1 error");
      expect(result.stdout).not.toContain("was not published");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("surfaces the archive's paper facts on a successful submit", async () => {
    // The report's build output carries the paper numbers; a resume has no
    // declared paper row, so they close the report as the Paper aside.
    const folder = seedSubmit(83, "803", {
      status: "in_progress",
      conclusion: null,
      jobs: [{ name: "Validate", status: "completed", conclusion: "success" }],
    });
    github.state.actionsArtifacts.set("803", [
      {
        id: 3083,
        name: "submission-validation-report-83",
        zip: artifactZip({
          "validation-report.json": JSON.stringify({
            reportVersion: 1,
            ok: true,
            warnings: [],
            violations: [],
            buildOutput: {
              concepts: [],
              proofs: [],
              paper: {
                folder: "paper",
                main: "main.tex",
                engine: "pdflatex",
                pdf: { digest: "0".repeat(64), bytes: 4321, pages: 2 },
                pageSizes: [[612, 792]],
                marks: [{ id: "Lax83.A" }, { id: "Lax83.B" }, { id: "lax-83" }],
                web: {
                  format: { tool: "reflowtex", rev: "0".repeat(40), schema: "0".repeat(64) },
                  bundle: { digest: "1".repeat(64), bytes: 123_456 },
                },
              },
            },
          }),
        }),
      },
    ]);
    const finish = setInterval(() => {
      if (!github.requests.some((request) => request.path === "/artifact-blobs/3083")) return;
      clearInterval(finish);
      github.state.actionsRuns.set("803", { status: "completed", conclusion: "success", jobs: [] });
      github.state.issueComments.get(83)!.push({
        id: 5083,
        body: appendWorkflowRun(
          `Published **lax-83**.\n\n${resultMarker(5001)}`,
          { id: "803", url: "https://github.com/lax-archive/lax/actions/runs/803" },
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
      expect(result.stdout).toContain("lax-83 is a draft in the archive");
      expect(result.stdout).toContain("Paper  2 pages · 3 marks · web view derived (0.1 MiB)");
      expect(result.stderr).toBe("");
    } finally {
      clearInterval(finish);
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("says the web view was skipped when the report warns about the derivation", async () => {
    const folder = seedSubmit(84, "804", {
      status: "in_progress",
      conclusion: null,
      jobs: [{ name: "Validate", status: "completed", conclusion: "success" }],
    });
    github.state.actionsArtifacts.set("804", [
      {
        id: 3084,
        name: "submission-validation-report-84",
        zip: artifactZip({
          "validation-report.json": JSON.stringify({
            reportVersion: 1,
            ok: true,
            warnings: [
              {
                phase: "paper",
                rule: "web-derivation",
                message: "the reflow view was not derived: lualatex failed",
              },
            ],
            violations: [],
            buildOutput: {
              paper: {
                pdf: { digest: "0".repeat(64), bytes: 4321, pages: 5 },
                marks: [{ id: "Lax84.A" }],
              },
            },
          }),
        }),
      },
    ]);
    const finish = setInterval(() => {
      if (!github.requests.some((request) => request.path === "/artifact-blobs/3084")) return;
      clearInterval(finish);
      github.state.actionsRuns.set("804", { status: "completed", conclusion: "success", jobs: [] });
      github.state.issueComments.get(84)!.push({
        id: 5084,
        body: appendWorkflowRun(
          `Published **lax-84**.\n\n${resultMarker(5001)}`,
          { id: "804", url: "https://github.com/lax-archive/lax/actions/runs/804" },
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
      expect(result.stdout).toContain("Paper  5 pages · 1 mark · web view skipped");
      // The reason itself rides the warning notes, as every warning does.
      expect(result.stdout).toContain("the reflow view was not derived: lualatex failed");
    } finally {
      clearInterval(finish);
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
      // a warning does not block publication, so it waits for the notes block
      // after the verdict rather than interrupting the rows
      expect(result.stdout).toContain("lax-81 is a draft in the archive");
      expect(result.stdout).toContain("! 1 warning");
      expect(result.stdout).toContain("statements · abstract");
      expect(result.stdout).toContain("the abstract is very short");
      expect(result.stdout.indexOf("lax-81 is a draft"))
        .toBeLessThan(result.stdout.indexOf("! 1 warning"));
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
      expect(`${result.stdout}${result.stderr}`).not.toContain("Lost contact with GitHub");
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
          `/lax submit lax-${issue} ${source}`,
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
    writeBoundManifest(folder, issue);
    return folder;
  }

  it("refuses to resume an issue that carries no submit of yours", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lax-resume-"));
    writeBoundManifest(folder, 78);
    try {
      const result = await lax(["submit", "--resume", folder], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no submit of yours is on lax-78");
      expect(result.stderr).toContain("run `lax submit` instead");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("names the exact recovery command when it loses contact with GitHub", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lax-resume-"));
    writeBoundManifest(folder, 79);
    try {
      // port 1 is refused: a transport failure, not an authoritative HTTP answer
      const result = await lax(["submit", "--resume", folder], {
        ...env,
        LAX_GITHUB_API_URL: "http://127.0.0.1:1",
      });
      expect(result.status).toBe(1);
      // A note with its fix, in the report's own voice; the transport error
      // itself is the failure line underneath it.
      expect(result.stdout).toContain("! Lost contact with GitHub. The archive may still be working on this.");
      expect(result.stdout).toContain(`Reattach with lax submit --resume ${folder}`);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("revokes both stored tokens on `lax logout`", async () => {
    const result = await lax(["logout"], env);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ Signed out");
    expect(fs.existsSync(path.join(home, "credentials.json"))).toBe(false);
    expect(github.state.revoked).toEqual([tokenFor("alice"), refreshTokenFor("alice")]);
    const revoke = github.requests.find((r) => r.path === "/credentials/revoke");
    expect(revoke?.method).toBe("POST");
    expect(revoke?.authorization).toBeUndefined();
  });

  function writeBoundManifest(folder: string, issue: number): void {
    fs.writeFileSync(
      path.join(folder, "manifest.yaml"),
      `id: lax-${issue}\nissue:\n  repositoryId: ${CONTROL_REPOSITORY_ID}\n  number: ${issue}\n`,
    );
  }
});
