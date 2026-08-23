import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDeleteLocally, checkRegisterLocally } from "../../src/cli/archive-preflight.js";
import { hasCurrentLocalBuild } from "../../src/cli/build.js";
import {
  databaseDirectory,
  databaseFreshnessAsync,
  syncDatabase,
} from "../../src/cli/database.js";
import { hostValidationRuntime } from "../../src/submission-validation/pins.js";

const homes: string[] = [];

afterEach(() => {
  delete process.env.LAX_HOME;
  delete process.env.LAX_DATABASE_URL;
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("local command preflights", () => {
  it("uses the repository-aligned local database directory", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    expect(databaseDirectory()).toBe(path.join(home, "lax-database"));
  });

  it("migrates the previous checkout name during a pull", async () => {
    const home = temporary("lax-home-");
    const seed = temporary("lax-database-seed-");
    const remote = path.join(temporary("lax-database-remote-"), "database.git");
    git(seed, ["init", "--quiet", "--initial-branch=main"]);
    fs.writeFileSync(path.join(seed, "README.md"), "database\n");
    git(seed, ["add", "."]);
    git(seed, ["-c", "user.name=Lax Test", "-c", "user.email=lax@example.test", "commit", "--quiet", "-m", "seed"]);
    git(path.dirname(remote), ["init", "--quiet", "--bare", remote]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "--quiet", "--set-upstream", "origin", "main"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(home, ["clone", "--quiet", remote, path.join(home, "database")]);
    process.env.LAX_HOME = home;
    process.env.LAX_DATABASE_URL = remote;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await syncDatabase();

    expect(fs.existsSync(path.join(home, "database"))).toBe(false);
    expect(fs.existsSync(path.join(home, "lax-database", ".git"))).toBe(true);
  });

  it("distinguishes a current database checkout from one behind its remote", async () => {
    const home = temporary("lax-home-");
    const seed = temporary("lax-database-seed-");
    const remote = path.join(temporary("lax-database-remote-"), "database.git");
    git(seed, ["init", "--quiet", "--initial-branch=main"]);
    fs.writeFileSync(path.join(seed, "record"), "one\n");
    git(seed, ["add", "."]);
    git(seed, ["-c", "user.name=Lax Test", "-c", "user.email=lax@example.test", "commit", "--quiet", "-m", "seed"]);
    git(path.dirname(remote), ["init", "--quiet", "--bare", remote]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "--quiet", "--set-upstream", "origin", "main"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    process.env.LAX_HOME = home;
    process.env.LAX_DATABASE_URL = remote;
    git(home, ["clone", "--quiet", remote, databaseDirectory()]);

    await expect(databaseFreshnessAsync()).resolves.toMatchObject({ status: "current" });

    fs.writeFileSync(path.join(seed, "record"), "two\n");
    git(seed, ["add", "."]);
    git(seed, ["-c", "user.name=Lax Test", "-c", "user.email=lax@example.test", "commit", "--quiet", "-m", "advance"]);
    git(seed, ["push", "--quiet", "origin", "main"]);
    await expect(databaseFreshnessAsync()).resolves.toMatchObject({ status: "stale" });
  });

  it("refuses a registered delete before creating an issue command", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-7", "registered", []);
    writeRecord(database, "lax-8", "draft", ["Lax7"]);

    expect(checkDeleteLocally("lax-7", "refreshed")).toEqual({
      refusal: "lax-7 is registered, so it can never be changed or removed",
      warnings: [],
    });
  });

  it("warns about dependents before a permitted delete", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-7", "draft", []);
    writeRecord(database, "lax-8", "draft", ["Lax7Proofs"]);

    expect(checkDeleteLocally("lax-7", "refreshed")).toEqual({
      warnings: [{ text: "lax-8 builds on lax-7 and will be left broken." }],
    });
  });

  it("refuses a registration whose dependency is not registered", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-5", "draft", []);
    writeRecord(database, "lax-7", "draft", ["Lax5", "mathlib"]);

    expect(checkRegisterLocally("lax-7", "refreshed")).toEqual({
      refusal:
        "registration admits only registered dependencies — lax-5 is draft; " +
        "a chain lands bottom-up: register lax-5 first",
      warnings: [],
    });
  });

  it("names deleted and missing dependencies without a register hint", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-5", "deleted", []);
    writeRecord(database, "lax-7", "draft", ["Lax5", "Lax9Proofs"]);

    expect(checkRegisterLocally("lax-7", "refreshed")).toEqual({
      refusal:
        "registration admits only registered dependencies — lax-5 is deleted, " +
        "lax-9 is not in your copy of the archive",
      warnings: [],
    });
  });

  it("permits registration once every dependency is registered", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-5", "registered", []);
    writeRecord(database, "lax-6", "draft", []);
    writeRecord(database, "lax-7", "draft", ["Lax5", "mathlib"]);

    expect(checkRegisterLocally("lax-7", "refreshed")).toEqual({ warnings: [] });
    expect(checkRegisterLocally("lax-6", "refreshed")).toEqual({ warnings: [] });
    expect(checkRegisterLocally("lax-5", "refreshed")).toEqual({
      refusal: "lax-5 is already registered",
      warnings: [],
    });
  });

  it("runs the supersedes admission checks before the registration is sent", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-5", "registered", [], { owners: [1, 2] });
    writeRecord(database, "lax-6", "draft", [], { owners: [1] });
    writeRecord(database, "lax-7", "draft", [], { owners: [1], supersedes: "lax-5" });
    writeRecord(database, "lax-8", "draft", [], { owners: [3], supersedes: "lax-5" });
    writeRecord(database, "lax-9", "draft", [], { owners: [1], supersedes: "lax-6" });
    writeRecord(database, "lax-10", "draft", [], { owners: [1], supersedes: "lax-99" });

    expect(checkRegisterLocally("lax-7", "refreshed")).toEqual({
      warnings: [
        { text: "Registering also makes lax-5 permanently show as superseded by lax-7." },
      ],
    });
    expect(checkRegisterLocally("lax-8", "refreshed")).toEqual({
      refusal: "no owner of lax-5 owns lax-8; a submission can be superseded only by its own owners",
      warnings: [],
    });
    expect(checkRegisterLocally("lax-9", "refreshed")).toEqual({
      refusal: "lax-6 is draft; only a registered submission can be superseded",
      warnings: [],
    });
    expect(checkRegisterLocally("lax-10", "refreshed")).toEqual({
      refusal:
        "this submission declares it supersedes lax-99, which is not in your copy of the archive",
      warnings: [],
    });
  });

  it("refuses a supersedes claim whose successor slot is already taken", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-5", "registered", [], { owners: [1] });
    writeRecord(database, "lax-6", "registered", [], { owners: [1], supersedes: "lax-5" });
    writeRecord(database, "lax-7", "draft", [], { owners: [1], supersedes: "lax-5" });

    expect(checkRegisterLocally("lax-7", "refreshed")).toEqual({
      refusal: "lax-6 already supersedes lax-5; a submission has at most one successor",
      warnings: [],
    });
  });

  it("refuses superseding a deleted target and degrades supersedes refusals when stale", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-5", "deleted", [], { owners: [1] });
    writeRecord(database, "lax-7", "draft", [], { owners: [1], supersedes: "lax-5" });

    expect(checkRegisterLocally("lax-7", "refreshed")).toEqual({
      refusal: "lax-5 is deleted and its id is retired; a deleted submission cannot be superseded",
      warnings: [],
    });
    // a stale copy never blocks: the archive itself decides
    const stale = checkRegisterLocally("lax-7", "failed");
    expect(stale.refusal).toBeUndefined();
    expect(stale.warnings.map((warning) => warning.text).join("\n")).toContain(
      "lax-5 is deleted and its id is retired",
    );
  });

  it("warns instead of judging ownership when the copy carries no owner lists", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-5", "registered", []);
    writeRecord(database, "lax-7", "draft", [], { supersedes: "lax-5" });

    expect(checkRegisterLocally("lax-7", "refreshed")).toEqual({
      warnings: [
        {
          text:
            "Whether an owner of lax-5 owns lax-7 could not be checked here; " +
            "the archive itself will decide.",
        },
        { text: "Registering also makes lax-5 permanently show as superseded by lax-7." },
      ],
    });
  });

  it("reuses only a build tied to the same source and Archive snapshot", () => {
    const root = temporary("lax-submission-");
    fs.writeFileSync(path.join(root, "manifest.yaml"), "id: lax-7\n");
    const source = {
      repository: "https://github.com/alice/example",
      commit: "a".repeat(40),
      folder: ".",
    };
    fs.writeFileSync(
      path.join(root, "build-output.json"),
      JSON.stringify({
        id: "lax-7",
        localValidation: {
          version: 1,
          source,
          archiveSha: "b".repeat(40),
          runtimeImageDigest: hostValidationRuntime().imageDigest,
        },
      }),
    );
    expect(hasCurrentLocalBuild(root, source, "b".repeat(40))).toBe(true);
    expect(hasCurrentLocalBuild(root, source, "c".repeat(40))).toBe(false);
  });

  it("rejects a build-output produced before a pin bump", () => {
    // The same sources compile to different artifacts across a toolchain pin
    // bump, so a pre-bump build-output must not let `lax submit` skip the
    // local rebuild.
    const root = temporary("lax-submission-");
    fs.writeFileSync(path.join(root, "manifest.yaml"), "id: lax-7\n");
    const source = {
      repository: "https://github.com/alice/example",
      commit: "a".repeat(40),
      folder: ".",
    };
    const write = (runtimeImageDigest: unknown): void => {
      fs.writeFileSync(
        path.join(root, "build-output.json"),
        JSON.stringify({
          id: "lax-7",
          localValidation: {
            version: 1,
            source,
            archiveSha: "b".repeat(40),
            ...(runtimeImageDigest === undefined ? {} : { runtimeImageDigest }),
          },
        }),
      );
    };

    write(hostValidationRuntime().imageDigest);
    expect(hasCurrentLocalBuild(root, source, "b".repeat(40))).toBe(true);

    write(`${hostValidationRuntime().imageDigest}-before-the-bump`);
    expect(hasCurrentLocalBuild(root, source, "b".repeat(40))).toBe(false);

    write(undefined);
    expect(hasCurrentLocalBuild(root, source, "b".repeat(40))).toBe(false);
  });
});

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  homes.push(directory);
  return directory;
}

function writeRecord(
  root: string,
  id: string,
  state: string,
  requirements: string[],
  options: { owners?: number[]; supersedes?: string } = {},
): void {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "record.json"), JSON.stringify({ id, state }));
  fs.writeFileSync(
    path.join(directory, "build-output.json"),
    JSON.stringify({
      requiredByConcepts: requirements,
      requiredByProofs: [],
      ...(options.supersedes === undefined
        ? {}
        : { inputs: { manifest: { supersedes: options.supersedes } } }),
    }),
  );
  if (options.owners !== undefined) {
    fs.writeFileSync(
      path.join(directory, "owner-list.json"),
      JSON.stringify({
        specVersion: "1",
        owners: options.owners.map((githubId) => ({ githubId, handle: `owner-${githubId}` })),
      }),
    );
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
import { execFileSync } from "node:child_process";
