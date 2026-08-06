import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDeleteLocally, checkRegisterLocally } from "../../src/cli/archive-preflight.js";
import { hasCurrentLocalBuild } from "../../src/cli/build.js";
import {
  databaseDirectory,
  databaseFreshness,
  updateDatabase,
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

  it("migrates the previous checkout name during an update", () => {
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

    updateDatabase();

    expect(fs.existsSync(path.join(home, "database"))).toBe(false);
    expect(fs.existsSync(path.join(home, "lax-database", ".git"))).toBe(true);
  });

  it("distinguishes a current database checkout from one behind its remote", () => {
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

    expect(databaseFreshness()).toMatchObject({ status: "current" });

    fs.writeFileSync(path.join(seed, "record"), "two\n");
    git(seed, ["add", "."]);
    git(seed, ["-c", "user.name=Lax Test", "-c", "user.email=lax@example.test", "commit", "--quiet", "-m", "advance"]);
    git(seed, ["push", "--quiet", "origin", "main"]);
    expect(databaseFreshness()).toMatchObject({ status: "stale" });
  });

  it("refuses a registered delete before creating an issue command", () => {
    const home = temporary("lax-home-");
    process.env.LAX_HOME = home;
    const database = databaseDirectory();
    writeRecord(database, "lax-7", "registered", []);
    writeRecord(database, "lax-8", "draft", ["Lax7"]);

    expect(checkDeleteLocally("lax-7", "refreshed")).toEqual({
      refusal: "lax-7 is registered and immutable",
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
      warnings: ["deleting lax-7 will strand lax-8"],
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
        "lax-9 is not in the local lax-database",
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

function writeRecord(root: string, id: string, state: string, requirements: string[]): void {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "record.json"), JSON.stringify({ id, state }));
  fs.writeFileSync(
    path.join(directory, "build-output.json"),
    JSON.stringify({ requiredByConcepts: requirements, requiredByProofs: [] }),
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
import { execFileSync } from "node:child_process";
