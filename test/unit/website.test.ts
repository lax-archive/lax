import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyWebsiteWarning,
  loadWebsiteSubmissions,
  websiteDatabaseWarning,
} from "../../src/cli/website.js";
import { initialFiles } from "../../src/shared/archive-schema.js";

const issue = { repositoryId: 123456789, number: 42 };
const alice = { githubId: 10, handle: "alice" };

describe("local website Archive adapter", () => {
  it("joins owner-list.json into records and hides initialization output", () => {
    const archive = temporaryDirectory("lax-site-database-");
    writeSubmission(
      archive,
      "lax-42",
      initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z"),
    );
    fs.mkdirSync(path.join(archive, ".git"));

    expect(loadWebsiteSubmissions(archive)).toEqual([
      {
        record: {
          specVersion: "1",
          id: "lax-42",
          state: "init",
          createdAt: "2026-07-30T10:00:00Z",
          owners: [alice],
        },
        output: undefined,
      },
    ]);
  });

  it("lifts accepted inputs into the lax-website renderer contract", () => {
    const archive = temporaryDirectory("lax-site-database-");
    const files = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    files["build-output.json"] = `${JSON.stringify({
      specVersion: "1",
      id: "lax-42",
      issue,
      inputs: {
        manifest: {
          specVersion: "1",
          id: "lax-42",
          leanVersion: "v4.19.0",
          mathlibVersion: "a".repeat(40),
          title: "Example",
          authors: [],
          bibEntries: [],
        },
        abstract: "An example.",
      },
      requiredByConcepts: [],
      requiredByProofs: [],
      concepts: [],
      proofs: [],
    }, null, 2)}\n`;
    writeSubmission(archive, "lax-42", files);

    const [submission] = loadWebsiteSubmissions(archive);
    expect(submission?.output).toMatchObject({
      id: "lax-42",
      manifest: { title: "Example" },
      abstract: "An example.",
      concepts: [],
      proofs: [],
    });
  });

  it("lets a local build-output replace the matching Archive submission", () => {
    const archive = temporaryDirectory("lax-site-database-");
    writeSubmission(
      archive,
      "lax-42",
      initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z"),
    );
    const local = temporaryDirectory("lax-site-local-");
    fs.writeFileSync(
      path.join(local, "build-output.json"),
      JSON.stringify({
        specVersion: "1",
        id: "lax-42",
        manifest: {
          specVersion: "1",
          id: "lax-42",
          leanVersion: "v4.19.0",
          mathlibVersion: "a".repeat(40),
          title: "Local version",
          authors: [],
          bibEntries: [],
        },
        abstract: "",
        requiredByConcepts: [],
        requiredByProofs: [],
        concepts: [],
        proofs: [],
      }),
    );

    const submissions = loadWebsiteSubmissions(archive, local);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.record).toMatchObject({ id: "lax-42", state: "draft" });
    expect(submissions[0]?.output).toMatchObject({ manifest: { title: "Local version" } });
  });

  it("starts with local content when the database is missing", () => {
    const missing = path.join(temporaryDirectory("lax-site-missing-"), "database");
    expect(loadWebsiteSubmissions(missing)).toEqual([]);
    expect(websiteDatabaseWarning({ status: "missing" }, missing)).toContain("lax pull-db");
  });

  it("adds a visible database warning to every generated page", () => {
    const site = temporaryDirectory("lax-site-output-");
    fs.writeFileSync(
      path.join(site, "index.html"),
      "<!doctype html><html><head></head><body><main>Archive</main></body></html>",
    );
    applyWebsiteWarning(site, "The database is stale.");
    const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
    expect(html).toContain("lax-local-warning");
    expect(html).toContain("The database is stale.");
    expect(fs.existsSync(path.join(site, "lax-local-warning.css"))).toBe(true);

    applyWebsiteWarning(site);
    expect(fs.readFileSync(path.join(site, "index.html"), "utf8")).not.toContain(
      "lax-local-warning",
    );
  });
});

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSubmission(root: string, id: string, files: Record<string, string>): void {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
}
