import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveLocalSource,
  deriveSubmittedSource,
  repositoryFolder,
  repositoryRoot,
} from "../../src/cli/git.js";
import {
  cleanupTemporary,
  initializeGit,
  temporary,
  writeFile,
} from "../support/submission-validation.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.LAX_TEST_GIT_CONTAINS;
  cleanupTemporary();
});

describe("CLI Git source derivation retained from main", () => {
  it("derives the commit and repository-relative folder for local builds", () => {
    const root = temporary("lax-cli-git-");
    writeFile(root, "submission/manifest.yaml", "id: lax-1\n");
    const commit = initializeGit(root);

    expect(repositoryRoot(path.join(root, "submission"))).toBe(fs.realpathSync(root));
    expect(repositoryFolder(root, path.join(root, "submission"))).toBe("submission");
    expect(deriveLocalSource(path.join(root, "submission"))).toEqual({
      repository: "https://github.com/local/local",
      commit,
      folder: "submission",
    });
    expect(() => repositoryFolder(root, path.dirname(root))).toThrow("outside the git repository");
  });

  it("rejects dirty submissions unless allow-dirty explicitly selects committed HEAD", () => {
    const root = temporary("lax-cli-dirty-");
    writeFile(root, "tracked.txt", "committed\n");
    initializeGit(root);
    writeFile(root, "tracked.txt", "changed\n");

    expect(() => deriveSubmittedSource(root)).toThrow("worktree is dirty");
    expect(() => deriveSubmittedSource(root, true)).toThrow("no usable supported `origin`");
  });

  it("requires HEAD to be present on origin and returns the immutable source triple", () => {
    const root = temporary("lax-cli-pushed-");
    writeFile(root, "submission/manifest.yaml", "id: lax-1\n");
    const commit = initializeGit(root);
    installGitRemoteFixture();

    expect(deriveSubmittedSource(path.join(root, "submission"))).toEqual({
      repository: "https://github.com/alice/formalization",
      commit,
      folder: "submission",
    });

    process.env.LAX_TEST_GIT_CONTAINS = "0";
    expect(() => deriveSubmittedSource(path.join(root, "submission"))).toThrow(
      "HEAD is not present on origin",
    );
  });
});

function installGitRemoteFixture(): void {
  const directory = temporary("lax-cli-git-bin-");
  const executable = path.join(directory, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    executable,
    `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then
  printf '%s\n' 'git@github.com:alice/formalization.git'
elif [ "$1" = "fetch" ]; then
  exit 0
elif [ "$1" = "for-each-ref" ]; then
  if [ "$LAX_TEST_GIT_CONTAINS" != "0" ]; then printf '%s\n' 'refs/remotes/origin/main'; fi
else
  exec "${realGit}" "$@"
fi
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
}
