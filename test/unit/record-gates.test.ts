import { describe, expect, it } from "vitest";
import type { LoadedSubmission } from "../../src/shared/archive.js";
import {
  deletedFiles,
  fileDigests,
  initialFiles,
  jsonFile,
  parseArchiveFiles,
  registeredFiles,
  replaceOwnerList,
} from "../../src/shared/archive-schema.js";
import {
  AUTHOR_MUTABLE_STATES,
  recordGateProblems,
  requireCurrentRecord,
  type RecordGateOptions,
} from "../../src/shared/record-gates.js";
import type { PublishRequest, SubmissionState } from "../../src/shared/types.js";

const alice = { githubId: 10, handle: "alice" };
const bob = { githubId: 20, handle: "bob" };
const issue = { repositoryId: 123456789, number: 42 };
const maintainers = new Set([alice.githubId]);

describe("record gates", () => {
  const options: RecordGateOptions = {
    authorStates: AUTHOR_MUTABLE_STATES,
    relevantPreconditions: ["record", "buildOutput", "ownerList"],
    admins: maintainers,
  };

  it("admits an author mutation of an unchanged init or draft record they own", () => {
    const init = loaded();
    expect(recordGateProblems(authorRequest(init), init, options)).toEqual([]);
    const draft = loaded(withState(init.texts, "draft"));
    expect(recordGateProblems(authorRequest(draft), draft, options)).toEqual([]);
  });

  it("refuses each way the record can have moved since route, in one aggregated list", () => {
    const routed = loaded();
    const moved = loaded(
      registeredFiles("lax-42", initialFiles("lax-42", { repositoryId: 999, number: 99 }, bob, "2026-07-30T10:00:00Z")),
    );
    expect(recordGateProblems(authorRequest(routed), moved, options)).toEqual([
      "lax-42 no longer has the expected issue binding",
      "alice is no longer an owner of lax-42",
      "lax-42 is now registered",
      "lax-42 changed after validation; submit a new command comment",
    ]);
  });

  it("checks only the digests the verb reads", () => {
    const routed = loaded();
    const ownersChanged = loaded(replaceOwnerList("lax-42", routed.texts, [alice, bob]));
    expect(
      recordGateProblems(authorRequest(routed), ownersChanged, {
        ...options,
        relevantPreconditions: ["record", "buildOutput"],
      }),
    ).toEqual([]);
    expect(recordGateProblems(authorRequest(routed), ownersChanged, options)).toEqual([
      "lax-42 changed after validation; submit a new command comment",
    ]);
    expect(
      recordGateProblems({ ...authorRequest(routed), preconditions: undefined }, routed, options),
    ).toEqual(["lax-42 changed after validation; submit a new command comment"]);
  });

  it("holds the author form to the states it is given", () => {
    const registered = loaded(registeredFiles("lax-42", loaded().texts));
    expect(recordGateProblems(authorRequest(registered), registered, options)).toEqual([
      "lax-42 is now registered",
    ]);
    expect(
      recordGateProblems(authorRequest(registered), registered, {
        ...options,
        authorStates: ["registered"],
      }),
    ).toEqual([]);
  });

  it("replaces the owner gate with the maintainer gate on the admin form, keeping the lifecycle rule", () => {
    const registered = loaded(withState(replaceOwnerList("lax-42", loaded().texts, [bob]), "registered"));
    const admin: PublishRequest = {
      ...authorRequest(registered),
      action: "delete",
      command: { action: "delete", admin: true },
    };
    // alice owns nothing here and is a maintainer: admitted
    expect(recordGateProblems(admin, registered, options)).toEqual([]);
    // a stranger to the allowlist is refused, ownership notwithstanding
    expect(recordGateProblems(admin, registered, { ...options, admins: new Set([99]) })).toEqual([
      "alice is not an archive maintainer",
    ]);
    // the verb's own lifecycle rule still applies
    const deleted = loaded(deletedFiles("lax-42", registered.texts, "2026-07-30T12:00:00Z", { byMaintainer: true }));
    expect(
      recordGateProblems({ ...admin, preconditions: deleted.preconditions }, deleted, options),
    ).toEqual(["lax-42 is already deleted"]);
    // and a verb without a maintainer form cannot borrow the flag
    expect(
      recordGateProblems(
        { ...admin, action: "register", command: { action: "register", admin: true } as never },
        registered,
        options,
      ),
    ).toEqual(["register has no maintainer form"]);
  });

  it("names the missing record the way every verb does", () => {
    const current = loaded();
    expect(requireCurrentRecord("lax-42", current)).toBe(current);
    expect(() => requireCurrentRecord("lax-42", undefined)).toThrow("lax-42 no longer exists in lax-database");
  });
});

function loaded(
  texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z"),
): LoadedSubmission {
  return {
    snapshot: { branch: "main", sha: "a".repeat(40) },
    texts,
    files: parseArchiveFiles("lax-42", texts),
    preconditions: fileDigests(texts),
  };
}

/** The record in a live state with a recorded source (tombstones come from deletedFiles). */
function withState(texts: Record<string, string>, state: Exclude<SubmissionState, "deleted">): Record<string, string> {
  const record = JSON.parse(texts["record.json"]!) as Record<string, unknown>;
  const source = { repository: "https://github.com/alice/repo", commit: "b".repeat(40), folder: "." };
  return {
    ...texts,
    "record.json": jsonFile({ ...record, state, ...(state === "init" ? {} : { source }) }),
  };
}

function authorRequest(current: LoadedSubmission): PublishRequest {
  return {
    action: "register",
    id: "lax-42",
    issue,
    actor: alice,
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T10:00:00Z",
    archiveSha: "a".repeat(40),
    commentId: 79,
    command: { action: "register" },
    preconditions: current.preconditions,
  };
}
