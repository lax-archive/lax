import { describe, expect, it, vi } from "vitest";
import { synchronizeSubmissionTitle } from "../../src/shared/submission-title.js";
import { fileDigests, initialFiles, jsonFile, parseArchiveFiles } from "../../src/shared/archive-schema.js";
import type { LoadedSubmission } from "../../src/shared/archive.js";

const issue = { repositoryId: 123, number: 42 };
function loaded(title: string): LoadedSubmission {
  const texts = initialFiles("lax-42", issue, { githubId: 10, handle: "alice" }, "2026-10-12T10:00:00Z");
  texts["build-output.json"] = jsonFile({ specVersion: "1", id: "lax-42", issue, inputs: { manifest: { title } } });
  return { snapshot: { branch: "main", sha: "a".repeat(40) }, texts,
    files: parseArchiveFiles("lax-42", texts), preconditions: fileDigests(texts) };
}
const request = { id: "lax-42", issue };

describe("submission title synchronization", () => {
  it("reads the latest published title instead of using the older job's accepted title", async () => {
    const current = loaded("New title");
    const archive = { load: vi.fn(async () => current) };
    const github = { request: vi.fn() };
    await synchronizeSubmissionTitle(archive, github, request);
    expect(github.request).toHaveBeenCalledExactlyOnceWith("PATCH", "/repos/lax-archive/lax/issues/42", { title: "New title" });
  });

  it("repairs a stale PATCH when a newer revision lands during the update", async () => {
    let current = loaded("Old title");
    const archive = { load: vi.fn(async () => current) };
    const github = { request: vi.fn(async (_method: string, _path: string, _body: { title: string }) => { current = loaded("New title"); }) };
    await synchronizeSubmissionTitle(archive, github, request);
    expect(github.request.mock.calls.map((call) => call[2])).toEqual([{ title: "Old title" }, { title: "New title" }]);
  });

  it("does not PATCH an issue whose archive binding has changed", async () => {
    const current = loaded("New title");
    current.files.buildOutput.issue = { repositoryId: 999, number: 99 };
    const github = { request: vi.fn() };
    await expect(synchronizeSubmissionTitle({ load: vi.fn(async () => current) }, github, request))
      .rejects.toThrow("issue binding changed");
    expect(github.request).not.toHaveBeenCalled();
  });
});
