import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGeneratedFilesIgnored, showFindings } from "../../src/cli/build.js";
import { groupFindings } from "../../src/cli/findings.js";
import { scaffoldSubmission } from "../../src/cli/scaffold.js";
import { LAX_GENERATED_FILES } from "../../src/submission-validation/generated-files.js";
import { removeTree } from "../support/tmp.js";

/**
 * The names lax writes into an author's folder, driven end to end: the
 * scaffold's ignore file against the files a build actually produces, and the
 * diagnosis for the folders that were scaffolded before the paper layer
 * existed.
 *
 * The seam these tests cross is the one that broke: nothing before them ran a
 * build's writes past a real `git status`, so `paper.pdf` could be added to
 * the writer and to three of the four guards and still leave every existing
 * worktree permanently dirty.
 */

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) removeTree(root);
});

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-generated-files-"));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commitAll(root: string): void {
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=Lax Test",
    "-c",
    "user.email=lax@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
}

/** Everything `lax build` puts in the submission root on a full paper build. */
function writeBuildOutputs(root: string): void {
  fs.writeFileSync(path.join(root, "build-output.json"), "{}\n");
  fs.writeFileSync(path.join(root, "paper.pdf"), "%PDF-1.5\n");
  fs.writeFileSync(path.join(root, "paper-web.tar"), "tar\n");
  fs.mkdirSync(path.join(root, "concepts", ".lake"), { recursive: true });
  fs.writeFileSync(path.join(root, "concepts", ".lake", "package-overrides.json"), "{}\n");
  fs.writeFileSync(path.join(root, "concepts", "lake-manifest.json"), "{}\n");
}

/** The ignore file as it was written before the paper layer existed. */
const PRE_PAPER_GITIGNORE = "build-output.json\nlake-manifest.json\n.lake/\n";

describe("the generated files lax owns", () => {
  it("leaves a scaffolded worktree clean after a build has written every one of them", () => {
    const root = repository();
    scaffoldSubmission(root, "lax-123456", "Scaffolded");
    commitAll(root);

    writeBuildOutputs(root);

    expect(git(root, ["status", "--porcelain"])).toBe("");
    expect(checkGeneratedFilesIgnored(root, LAX_GENERATED_FILES.root)).toEqual([]);
  });

  it("names the files a pre-paper-layer ignore file never heard of", () => {
    const root = repository();
    scaffoldSubmission(root, "lax-123456", "Scaffolded");
    fs.writeFileSync(path.join(root, ".gitignore"), PRE_PAPER_GITIGNORE);
    commitAll(root);
    writeBuildOutputs(root);
    // the worktree the next `lax submit` would refuse, with no cause named
    expect(git(root, ["status", "--porcelain"])).toContain("?? paper.pdf");

    const findings = checkGeneratedFilesIgnored(root, ["build-output.json", "paper.pdf", "paper-web.tar"]);

    expect(findings).toEqual([
      {
        phase: "static",
        rule: "gitignore",
        message:
          "paper.pdf, paper-web.tar are not covered by .gitignore — `lax build` writes them " +
          "into the submission folder and `lax submit` refuses a dirty worktree, so add them " +
          "and commit the change",
      },
    ]);
  });

  it("says nothing about a name the ignore file covers another way", () => {
    const root = repository();
    scaffoldSubmission(root, "lax-123456", "Scaffolded");
    fs.writeFileSync(path.join(root, ".gitignore"), "build-output.json\n*.pdf\n*.tar\n.lake/\n");
    commitAll(root);
    writeBuildOutputs(root);

    expect(checkGeneratedFilesIgnored(root, LAX_GENERATED_FILES.root)).toEqual([]);
  });

  it("leaves a committed generated file to the validator that rejects it", () => {
    const root = repository();
    scaffoldSubmission(root, "lax-123456", "Scaffolded");
    fs.writeFileSync(path.join(root, ".gitignore"), "build-output.json\n");
    fs.writeFileSync(path.join(root, "paper.pdf"), "%PDF-1.5\n");
    commitAll(root);

    // no ignore rule stops git reporting a tracked file, so this is not the
    // rule that has anything to say — static validation and `lax doctor` name
    // the committed copy under `generated-files`
    expect(checkGeneratedFilesIgnored(root, ["paper.pdf"])).toEqual([]);
  });

  it("says nothing outside a repository, where no worktree can go dirty", () => {
    const root = repository();
    scaffoldSubmission(root, "lax-123456", "Scaffolded");
    fs.rmSync(path.join(root, ".gitignore"));

    expect(checkGeneratedFilesIgnored(root, LAX_GENERATED_FILES.root)).toEqual([]);
  });

  it("touches nothing when the build ran in the throwaway checkout `lax submit --allow-dirty` makes", () => {
    // That checkout carries the author's *committed* ignore file, so the
    // finding is as true there as in their own folder — but anything written
    // into it dies with the worktree, and a repair reported from there would
    // describe a change their repository never received.
    const author = repository();
    scaffoldSubmission(author, "lax-123456", "Scaffolded");
    fs.writeFileSync(path.join(author, ".gitignore"), PRE_PAPER_GITIGNORE);
    commitAll(author);
    const scratch = path.join(repository(), "checkout");
    git(author, ["worktree", "add", "--quiet", "--detach", scratch, "HEAD"]);
    writeBuildOutputs(scratch);

    const findings = checkGeneratedFilesIgnored(scratch, ["build-output.json", "paper.pdf"]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("paper.pdf is not covered by .gitignore");
    expect(fs.readFileSync(path.join(scratch, ".gitignore"), "utf8")).toBe(PRE_PAPER_GITIGNORE);
    expect(fs.readFileSync(path.join(author, ".gitignore"), "utf8")).toBe(PRE_PAPER_GITIGNORE);
    expect(git(author, ["status", "--porcelain"])).toBe("");
    git(author, ["worktree", "remove", "--force", scratch]);
  });

  it("reaches the author through the warnings both commands render", () => {
    // `lax build` prints its outcome's warnings itself; `lax submit` embeds the
    // build and carries the same array into its notes. One list, so the
    // finding cannot be visible in one command and lost in the other.
    const root = repository();
    scaffoldSubmission(root, "lax-123456", "Scaffolded");
    fs.writeFileSync(path.join(root, ".gitignore"), PRE_PAPER_GITIGNORE);
    commitAll(root);
    writeBuildOutputs(root);
    const warnings = checkGeneratedFilesIgnored(root, ["build-output.json", "paper.pdf"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    showFindings({ warnings, violations: [] });

    const printed = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(printed).toContain("1 warning");
    expect(printed).toContain("layout · gitignore");
    expect(printed).toContain("paper.pdf is not covered by .gitignore");
    // and the same array, rendered the way `lax submit` renders it
    expect(groupFindings(warnings, "warning")?.body[0]).toBe("layout · gitignore");
  });
});
