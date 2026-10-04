// `lax certify --run` keeps the certificate folder's `.lake` between runs
// (src/cli/certify.ts verifyCertificateWorkspace): every pinned checkout is
// held to its revision and a clean tree before the comparator runs, and the
// record packages' build products are removed, while an environment
// library's cache stays (codex review 2 2026-10-04, finding 3).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCertificateWorkspace } from "../../src/cli/certify.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A checkout at `.lake/packages/<name>` with one commit, `.lake` ignored
 * as mathlib and the record packages ignore it, and a build product. */
function checkout(root: string, name: string): string {
  const dir = path.join(root, ".lake", "packages", name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".lake\n");
  fs.writeFileSync(path.join(dir, "Main.lean"), "def x := 1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  fs.mkdirSync(path.join(dir, ".lake", "build"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".lake", "build", "cache"), "");
  return git(dir, "rev-parse", "HEAD");
}

function workspace(): { root: string; manifest: (revs: Record<string, string>) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-certify-ws-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".lake", "build"), { recursive: true });
  fs.writeFileSync(path.join(root, ".lake", "build", "Challenge.olean"), "");
  return {
    root,
    manifest: (revs) =>
      JSON.stringify({
        version: "1.2.0",
        packages: [
          ...Object.entries(revs).map(([name, rev]) => ({ name, type: "git", rev, url: `https://github.com/example/${name}` })),
          { name: "absent", type: "git", rev: "0".repeat(40), url: "https://github.com/example/absent" },
        ],
      }),
  };
}

describe("the certificate workspace before a run", () => {
  it("verifies every present checkout and removes the record packages' build products, keeping a library's", () => {
    const { root, manifest } = workspace();
    const mathlib = checkout(root, "mathlib");
    const record = checkout(root, "Lax7");
    const proofs = checkout(root, "Lax7Proofs");
    const result = verifyCertificateWorkspace(root, manifest({ mathlib, Lax7: record, Lax7Proofs: proofs }));
    expect(result.verified.sort()).toEqual(["Lax7", "Lax7Proofs", "mathlib"]);
    expect(result.cleaned.sort()).toEqual(["Lax7", "Lax7Proofs", "LaxCertificate"]);
    expect(fs.existsSync(path.join(root, ".lake", "packages", "mathlib", ".lake", "build", "cache"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".lake", "packages", "Lax7", ".lake", "build"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".lake", "build"))).toBe(false);
    // the checkouts themselves stay
    expect(fs.existsSync(path.join(root, ".lake", "packages", "Lax7", "Main.lean"))).toBe(true);
  });

  it("ignores a checkout's own .lake build state when the checkout does not gitignore it", () => {
    const { root, manifest } = workspace();
    const record = checkout(root, "Lax7");
    fs.rmSync(path.join(root, ".lake", "packages", "Lax7", ".gitignore"));
    git(root + "/.lake/packages/Lax7", "add", ".gitignore");
    git(root + "/.lake/packages/Lax7", "commit", "-q", "-m", "no ignore");
    const head = git(root + "/.lake/packages/Lax7", "rev-parse", "HEAD");
    expect(head).not.toBe(record);
    expect(verifyCertificateWorkspace(root, manifest({ Lax7: head })).verified).toEqual(["Lax7"]);
  });

  it("refuses a checkout with local changes, naming the package", () => {
    const { root, manifest } = workspace();
    const record = checkout(root, "Lax7");
    fs.writeFileSync(path.join(root, ".lake", "packages", "Lax7", "Main.lean"), "def x := 2\n");
    expect(() => verifyCertificateWorkspace(root, manifest({ Lax7: record }))).toThrow(/\.lake\/packages\/Lax7 has local changes/u);
    // nothing was cleaned on refusal
    expect(fs.existsSync(path.join(root, ".lake", "build"))).toBe(true);
  });

  it("refuses a checkout at another revision than the bundle pins", () => {
    const { root, manifest } = workspace();
    checkout(root, "mathlib");
    expect(() => verifyCertificateWorkspace(root, manifest({ mathlib: "1".repeat(40) }))).toThrow(/\.lake\/packages\/mathlib is at [0-9a-f]+, not the revision the bundle pins/u);
  });

  it("is a no-op on a first run with no checkouts yet", () => {
    const { root, manifest } = workspace();
    fs.rmSync(path.join(root, ".lake"), { recursive: true });
    expect(verifyCertificateWorkspace(root, manifest({}))).toEqual({ verified: [], cleaned: [] });
  });
});
