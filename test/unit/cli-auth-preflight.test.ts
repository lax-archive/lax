import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "../../src/cli/github-app.js";

// `lax submit` used to touch the login only in its very last step, after the
// local Lean build and — for delete/register — after the typed confirmation.
// These tests pin the ordering and the two reports that ordering produced:
// a bare `HTTP 500` from the token endpoint, and a "the workflow run may still
// be going" hint for a run that was never started.

const stub = vi.hoisted(() => ({
  databaseDirectory: "",
  buildSubmission: vi.fn(async () => 0),
  hasCurrentLocalBuild: vi.fn(() => false),
  ensureLoggedIn: vi.fn(async () => "author"),
  githubAppUserToken: vi.fn(async () => "ghu_test-token"),
}));

vi.mock("../../src/cli/build.js", () => ({
  buildSubmission: stub.buildSubmission,
  hasCurrentLocalBuild: stub.hasCurrentLocalBuild,
}));
vi.mock("../../src/cli/manifest.js", () => ({
  issueNumberFromFolder: () => 14,
  submissionIdFromFolder: () => "lax-14",
}));
vi.mock("../../src/cli/git.js", () => ({
  repositoryRoot: (folder: string) => folder,
  deriveSubmittedSource: () => ({
    repository: "https://github.com/lax-archive/lax-submissions",
    commit: "590ca0d1d9f9a690edbfe86b165b47830504c91a",
    folder: "finite-ramsey",
  }),
}));
vi.mock("../../src/cli/database.js", () => ({
  databaseDirectory: () => stub.databaseDirectory,
  tryRefreshDatabase: () => "refreshed",
}));
vi.mock("../../src/cli/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureLoggedIn: stub.ensureLoggedIn,
  githubAppUserToken: stub.githubAppUserToken,
}));

const { submitFolder } = await import("../../src/cli/commands.js");

describe("CLI authentication preflight", () => {
  let home: string;
  let logged: string[];
  let errors: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-auth-preflight-"));
    stub.databaseDirectory = path.join(home, "lax-database");
    seedRepository(stub.databaseDirectory);
    logged = [];
    errors = [];
    stub.buildSubmission.mockClear().mockResolvedValue(0);
    stub.hasCurrentLocalBuild.mockClear().mockReturnValue(false);
    stub.ensureLoggedIn.mockClear().mockResolvedValue("author");
    stub.githubAppUserToken.mockClear().mockResolvedValue("ghu_test-token");
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("fails before the local build when the login is unusable", async () => {
    stub.ensureLoggedIn.mockRejectedValue(
      new AuthenticationError("no GitHub App login found; run `lax login`"),
    );

    await expect(submitFolder(home)).rejects.toThrow("run `lax login`");

    expect(stub.buildSubmission).not.toHaveBeenCalled();
    expect(stub.hasCurrentLocalBuild).not.toHaveBeenCalled();
  });

  it("names the authenticated account before spending the build", async () => {
    stub.githubAppUserToken.mockRejectedValue(new AuthenticationError("stop before posting"));

    await expect(submitFolder(home)).rejects.toThrow("stop before posting");

    expect(logged.indexOf("lax submit: authenticated as author.")).toBeLessThan(
      logged.findIndex((line) => line.includes("running lax build first")),
    );
  });

  it("does not offer a resume hint for a submit that never reached GitHub", async () => {
    // The login can still lapse between the preflight and the post: the build
    // in between is minutes long. That is an authentication failure, not a lost
    // connection, and it leaves no Actions run to reattach to.
    stub.githubAppUserToken.mockRejectedValue(
      new AuthenticationError("GitHub rejected the stored login (HTTP 401); run `lax login` again"),
    );

    await expect(submitFolder(home)).rejects.toThrow("run `lax login` again");

    expect(stub.buildSubmission).toHaveBeenCalledOnce();
    expect(errors.join("\n")).not.toContain("lost contact");
    expect(errors.join("\n")).not.toContain("--resume");
  });
});

function seedRepository(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  };
  git("init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(path.join(directory, "README.md"), "database\n");
  git("add", ".");
  git("-c", "user.name=Lax Test", "-c", "user.email=lax@example.test", "commit", "--quiet", "-m", "seed");
}
