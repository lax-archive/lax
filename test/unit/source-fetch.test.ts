import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  checkoutRemoteCommit,
  fetchGitCheckout,
  type GitRunner,
} from "../../src/submission-validation/source/fetch.js";
import { cleanupTemporary, temporary } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

// Mirrors the production fetch environment (isolated HOME, no system or user
// config, no prompts) but admits the file transport so the tests can serve
// fixture remotes from the local disk instead of the network.
function isolatedEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function fixtureGit(cwd: string, env: Record<string, string>, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Lax Test", "-c", "user.email=lax@example.test", ...args],
    { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

interface Workspace {
  destination: string;
  git: GitRunner;
  calls: string[][];
}

function workspace(): Workspace {
  const root = temporary("lax-fetch-test-");
  const destination = path.join(root, "checkout");
  fs.mkdirSync(destination, { recursive: true });
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME, { recursive: true });
  // Wire protocol v2 implicitly allows any-SHA-in-want, which would let the
  // exact-commit fast path succeed against the local fixture and leave the
  // fallback untested. Pin the client to v0, where the fixture's upload-pack
  // enforces its allow*SHA1InWant=false configuration, mirroring a host that
  // refuses unadvertised-SHA fetches. Production reads an equally isolated
  // HOME, so this configures only the fixture transport, not the code paths.
  fs.writeFileSync(path.join(env.HOME, ".gitconfig"), "[protocol]\n\tversion = 0\n", "utf8");
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const result = spawnSync("git", args, {
      cwd: destination,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: result.status ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") };
  };
  return { destination, git, calls };
}

// A remote whose branch tip is `depth` commits ahead of the first commit and
// which, like github.com for most repositories, refuses fetches of
// unadvertised SHAs — so the exact-commit fast path fails and the fallback
// has to find historical commits on its own.
let fixtureRoot: string;
let origin: string;
let commits: string[] = [];
const ORIGIN_DEPTH = 40;

// The origin outlives the per-test afterEach cleanup, so it manages its own
// temporary directory.
beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lax-fetch-origin-"));
  origin = path.join(fixtureRoot, "origin");
  const env = isolatedEnv(path.join(fixtureRoot, "home"));
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(env.HOME, { recursive: true });
  fixtureGit(origin, env, ["init", "--quiet", "--initial-branch=main"]);
  fixtureGit(origin, env, ["config", "uploadpack.allowAnySHA1InWant", "false"]);
  fixtureGit(origin, env, ["config", "uploadpack.allowReachableSHA1InWant", "false"]);
  fixtureGit(origin, env, ["config", "uploadpack.allowTipSHA1InWant", "false"]);
  fs.writeFileSync(path.join(origin, "file.txt"), "0\n", "utf8");
  fixtureGit(origin, env, ["add", "file.txt"]);
  fixtureGit(origin, env, ["commit", "--quiet", "-m", "commit 0"]);
  for (let index = 1; index < ORIGIN_DEPTH; index += 1) {
    fixtureGit(origin, env, ["commit", "--quiet", "--allow-empty", "-m", `commit ${index}`]);
  }
  commits = fixtureGit(origin, env, ["rev-list", "main"]).split("\n");
  expect(commits).toHaveLength(ORIGIN_DEPTH);
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("source fetch fallback", () => {
  it("finds a commit buried behind the branch tip through bounded deepening", async () => {
    const { destination, git, calls } = workspace();
    const target = commits[30]; // 30 commits behind the tip of main
    await checkoutRemoteCommit(git, origin, target);

    const head = (await git(["rev-parse", "HEAD"])).output.trim();
    expect(head).toBe(target);
    expect(fs.readFileSync(path.join(destination, "file.txt"), "utf8")).toBe("0\n");
    // The remote refused the unadvertised-SHA fast path, so the commit must
    // have arrived through the tip fetch plus progressive deepening.
    expect(calls).toContainEqual(["fetch", "--quiet", "--depth", "1", "origin", target]);
    expect(calls.some((args) => args.some((arg) => arg.startsWith("--deepen=")))).toBe(true);
  });

  it("stops at the depth cap and reports the existing absence violation", async () => {
    const { git, calls } = workspace();
    const target = commits[30];
    await expect(checkoutRemoteCommit(git, origin, target, 8)).rejects.toThrow(
      "requested commit is not present in the fetched repository",
    );
    // depth 1 from the tip fetch, then a single capped deepen to 8 — the cap
    // must stop the loop, not the exhaustion of the remote's history.
    const deepens = calls.filter((args) => args.some((arg) => arg.startsWith("--deepen=")));
    expect(deepens).toEqual([["fetch", "--quiet", "--deepen=7", "origin"]]);
  });

  it("terminates once history is complete when the commit does not exist at all", async () => {
    const { git, calls } = workspace();
    const absent = "f".repeat(40);
    await expect(checkoutRemoteCommit(git, origin, absent)).rejects.toThrow(
      "requested commit is not present in the fetched repository",
    );
    // Deepening must stop as soon as the clone is complete instead of
    // retrying against a remote that has nothing more to give.
    const deepens = calls.filter((args) => args.some((arg) => arg.startsWith("--deepen=")));
    expect(deepens.length).toBeLessThanOrEqual(2);
  });

  it("still refuses non-canonical repositories, short commits, and vague destinations", async () => {
    const destination = path.join(temporary("lax-fetch-guard-"), "checkout");
    await expect(
      fetchGitCheckout("https://example.com/owner/repo", "a".repeat(40), destination, 1000),
    ).rejects.toThrow("repository host must be one of");
    await expect(
      fetchGitCheckout("https://github.com/owner/repo", "abc", destination, 1000),
    ).rejects.toThrow("commit must be a full lowercase 40-character SHA");
    await expect(
      fetchGitCheckout("https://github.com/owner/repo", "a".repeat(40), "relative/path", 1000),
    ).rejects.toThrow("destination must be a specific absolute path");
    for (const repository of [
      "https://github.com/owner/repo",
      "https://gitlab.com/group/team/repo",
      "https://codeberg.org/owner/repo",
      "https://bitbucket.org/owner/repo",
    ]) {
      await expect(fetchGitCheckout(repository, "a".repeat(40), "relative/path", 1000)).rejects.toThrow(
        "destination must be a specific absolute path",
      );
    }
  });
});
