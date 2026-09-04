// `lax port lax-N`: the scaffolding half of moving a submission into another
// archive environment. Everything mechanical about the successor is derived —
// the source at its published commit, a fresh id, the target environment's
// pins, the `supersedes` claim, and each cross-submission require repointed at
// the dependency's own port — and nothing else is.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portSubmission } from "../../src/cli/port.js";
import { scaffoldSubmission } from "../../src/cli/scaffold.js";
import * as ui from "../../src/cli/ui.js";
import { epoch } from "../../src/submission-validation/environments.js";
import { withTestEnvironmentsAsync } from "../support/environments.js";
import { removeTree } from "../support/tmp.js";

/** The environment ported into: a Lean and a mathlib the epoch does not share,
 * so every rewritten pin is visibly the target's rather than the source's. */
const TARGET = {
  id: "v4.99.0",
  leanToolchain: "leanprover/lean4:v4.99.0",
  mathlibCommit: "b".repeat(40),
};

const previous = { home: process.env.LAX_HOME };
let home: string;
let repositories: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-port-"));
  process.env.LAX_HOME = home;
  repositories = path.join(home, "repos");
  fs.mkdirSync(repositories, { recursive: true });
  // A `.git` that is not a clone: `lax port` refreshes the copy best-effort and
  // must carry on with what is on disk when the refresh fails.
  fs.mkdirSync(path.join(home, "lax-database", ".git"), { recursive: true });
  ui.configure({ color: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTree(home);
  if (previous.home === undefined) delete process.env.LAX_HOME;
  else process.env.LAX_HOME = previous.home;
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.name=Lax Test", "-c", "user.email=lax@example.test", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** A published submission: a git repository holding the scaffolded folder at
 * its root, committed, plus the two database files that record it. */
function publish(
  id: string,
  options: {
    environment?: string;
    supersedes?: string;
    /** Cross-submission git requires to add to the proofs lakefile. */
    requires?: Array<{ name: string; git: string; rev: string; subDir: string }>;
  } = {},
): { repository: string; commit: string } {
  const repository = path.join(repositories, id);
  fs.mkdirSync(repository, { recursive: true });
  scaffoldSubmission(repository, id, `Submission ${id}`, epoch());
  for (const requirement of options.requires ?? []) {
    fs.appendFileSync(
      path.join(repository, "proofs", "lakefile.toml"),
      `\n[[require]]\nname = "${requirement.name}"\ngit = "${requirement.git}"\n` +
        `rev = "${requirement.rev}"\nsubDir = "${requirement.subDir}"\n`,
    );
  }
  git(["init", "--quiet", "--initial-branch=main"], repository);
  git(["add", "-A"], repository);
  git(["commit", "--quiet", "-m", id], repository);
  const commit = git(["rev-parse", "HEAD"], repository);
  const directory = path.join(home, "lax-database", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "record.json"),
    JSON.stringify({
      specVersion: "1",
      id,
      state: "registered",
      createdAt: "2026-01-01T00:00:00Z",
      source: { repository, commit, folder: "." },
    }),
  );
  fs.writeFileSync(
    path.join(directory, "build-output.json"),
    JSON.stringify({
      id,
      inputs: {
        manifest: {
          leanVersion: options.environment ?? epoch().id,
          ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
        },
      },
    }),
  );
  return { repository, commit };
}

function quiet(): Array<{ mock: { calls: unknown[][] } }> {
  return [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  ];
}

function printed(log: Array<{ mock: { calls: unknown[][] } }>): string {
  return log.flatMap((spy) => spy.mock.calls.map(([line]) => String(line))).join("\n");
}

describe("lax port", () => {
  it("repins, renumbers, claims the old version, and follows the ported chain", async () => {
    // lax-100001 has been ported already (lax-100002 supersedes it and lives in
    // the target environment); lax-100004 has not.
    const ported = publish("lax-100001");
    const successor = publish("lax-100002", {
      environment: TARGET.id,
      supersedes: "lax-100001",
    });
    const stranded = publish("lax-100004");
    publish("lax-100003", {
      requires: [
        { name: "Lax100001", git: ported.repository, rev: ported.commit, subDir: "concepts" },
        { name: "Lax100004", git: stranded.repository, rev: stranded.commit, subDir: "concepts" },
      ],
    });
    const destination = path.join(home, "ported");
    const log = quiet();

    const code = await withTestEnvironmentsAsync([TARGET], () =>
      portSubmission("lax-100003", destination, { env: TARGET.id }),
    );

    expect(code).toBe(0);
    const manifest = fs.readFileSync(path.join(destination, "manifest.yaml"), "utf8");
    // A fresh id, because package names derive from it and both versions have
    // to coexist in one dependency graph.
    const id = /^id: (lax-[1-9][0-9]{5})$/mu.exec(manifest)?.[1];
    expect(id).toBeDefined();
    expect(id).not.toBe("lax-100003");
    expect(manifest).toContain(`leanVersion: "${TARGET.id}"`);
    expect(manifest).toContain(`mathlibVersion: "${TARGET.mathlibCommit}"`);
    expect(manifest).toContain("supersedes: lax-100003");
    // The package layout followed the id, and the old one is gone.
    const packageName = `Lax${id!.slice("lax-".length)}`;
    expect(fs.existsSync(path.join(destination, "concepts", `${packageName}.lean`))).toBe(true);
    expect(fs.existsSync(path.join(destination, "concepts", "Lax100003.lean"))).toBe(false);
    // Both toolchain files and both lakefiles carry the target's pins.
    for (const kind of ["concepts", "proofs"]) {
      expect(fs.readFileSync(path.join(destination, kind, "lean-toolchain"), "utf8").trim()).toBe(
        TARGET.leanToolchain,
      );
      const lakefile = fs.readFileSync(path.join(destination, kind, "lakefile.toml"), "utf8");
      expect(lakefile).toContain(`rev = "${TARGET.mathlibCommit}"`);
      expect(lakefile).not.toContain(epoch().mathlibCommit);
    }
    // The dependency that has a port is followed to it; the one that has none
    // is left pinned exactly where it was, and named.
    const proofs = fs.readFileSync(path.join(destination, "proofs", "lakefile.toml"), "utf8");
    expect(proofs).toContain('name = "Lax100002"');
    expect(proofs).toContain(`rev = "${successor.commit}"`);
    expect(proofs).toContain(`git = "${successor.repository}"`);
    expect(proofs).not.toContain('name = "Lax100001"');
    expect(proofs).toContain('name = "Lax100004"');
    expect(proofs).toContain(`rev = "${stranded.commit}"`);
    const output = printed(log);
    expect(output).toContain("Lax100004 has no v4.99.0 version yet, so its require is unchanged.");
    expect(output).toContain(
      "Port lax-100004 first — then rerun this port into a fresh folder, or repoint it by hand.",
    );
    expect(output).toContain("The Lean is not ported: only the pins, the id, and the requires are.");
    // The git history of the source repository is not the new submission's.
    expect(fs.existsSync(path.join(destination, ".git"))).toBe(false);
  });

  it("refuses a record that is already in the target environment", async () => {
    publish("lax-100005", { environment: TARGET.id });

    await expect(
      withTestEnvironmentsAsync([TARGET], () =>
        portSubmission("lax-100005", path.join(home, "nope"), { env: TARGET.id }),
      ),
    ).rejects.toThrow(/lax-100005 is already in environment v4\.99\.0/u);
  });

  it("refuses an id the environment table does not admit", async () => {
    publish("lax-100006");

    await expect(portSubmission("lax-100006", path.join(home, "nope"), { env: "v9.9.9" })).rejects.toThrow(
      /v9\.9\.9 is not an archive environment/u,
    );
  });

  it("says to sync when this machine has no copy of the archive", async () => {
    removeTree(path.join(home, "lax-database"));

    await expect(portSubmission("lax-100007", undefined, {})).rejects.toThrow(/run lax sync first/u);
  });
});
