// The database port driver (scripts/port-db/) replays every existing record
// through the issue control plane. Two things in it are worth proving without
// a network: the order it picks (a dependent ported before its dependency
// fails Resolution, because archive/snapshot.ts sees no capture yet) and the
// exact bytes it posts (a malformed /lax update comment is rejected, and a
// well-formed one against the wrong triple would rewrite the record).
//
// The format tests are drift guards, not copies: they check the driver's
// output against the real parseCommand and the real workflow-comment markers.
import { describe, expect, it } from "vitest";
import {
  compareIds,
  dependencyIds,
  formatMarkdown,
  formatTable,
  hasResultMarker,
  heaviestPhase,
  isActionsBot,
  issueNumberForId,
  parseRunId,
  peakMemoryBytes,
  planOrder,
  resultMarker,
  skipReason,
  submissionIdForPackage,
  updateCommandBody,
  visibleComment,
  // @ts-expect-error -- a plain .mjs script, deliberately untyped like scripts/rehearsal
} from "../../scripts/port-db/plan.mjs";
import { parseCommand } from "../../src/shared/commands.js";
import { GITHUB_ACTIONS_BOT_ID, GITHUB_ACTIONS_BOT_LOGIN } from "../../src/shared/constants.js";
import { submissionIdForPackage as realSubmissionIdForPackage } from "../../src/submission-validation/contracts.js";
import { resultMarker as realResultMarker } from "../../src/shared/workflow-comments.js";

interface Record_ {
  id: string;
  state: string;
  source?: { repository: string; commit: string; folder: string };
  buildOutput?: { requiredByConcepts?: string[]; requiredByProofs?: string[] };
}

const triple = (folder: string) => ({
  repository: "https://github.com/lax-archive/lax-submissions",
  commit: "311ae7cf15e1bde644721958e05203bb6791d04b",
  folder,
});

function draft(id: string, concepts: string[] = [], proofs: string[] = []): Record_ {
  return {
    id,
    state: "draft",
    source: triple(id),
    buildOutput: { requiredByConcepts: concepts, requiredByProofs: proofs },
  };
}

describe("the port plan", () => {
  it("reads forward dependency edges out of the requiredBy* package names", () => {
    // Despite the name, requiredByConcepts/requiredByProofs are the packages
    // this record requires — phases/resolution.ts recurses into them exactly
    // that way. Non-Lax packages (mathlib) and the record's own package drop.
    expect(
      dependencyIds({
        id: "lax-3",
        buildOutput: {
          requiredByConcepts: ["Lax11", "Lax12", "mathlib"],
          requiredByProofs: ["Lax12Proofs", "Lax13", "Lax13Proofs", "Lax3"],
        },
      }),
    ).toEqual(["lax-11", "lax-12", "lax-13"]);
  });

  it("derives submission ids from package names the way contracts.ts does", () => {
    for (const name of ["Lax1", "Lax13", "Lax13Proofs", "Lax200Proofs", "mathlib", "Proofs", "Lax0"]) {
      expect(submissionIdForPackage(name), name).toBe(realSubmissionIdForPackage(name));
    }
  });

  it("orders dependencies before dependents", () => {
    // The whole point of the driver: while lax-13 still carries a
    // Releases-format capture, lax-11's Resolution reports "no capture".
    const plan = planOrder([
      draft("lax-3", ["Lax11", "Lax12"], ["Lax13"]),
      draft("lax-11", ["Lax13"]),
      draft("lax-12", [], ["Lax14"]),
      draft("lax-13"),
      draft("lax-14"),
    ]);
    for (const [id, dependencies] of plan.dependencies as Map<string, string[]>) {
      for (const dependency of dependencies) {
        expect(plan.order.indexOf(dependency), `${dependency} before ${id}`).toBeLessThan(
          plan.order.indexOf(id),
        );
      }
    }
  });

  it("is deterministic and independent of input order", () => {
    const records = [draft("lax-3", ["Lax11"]), draft("lax-11", ["Lax13"]), draft("lax-13"), draft("lax-9")];
    const forward = planOrder(records).order;
    const reversed = planOrder([...records].reverse()).order;
    expect(forward).toEqual(reversed);
    // Ties break on the numeric id, so lax-9 sorts before lax-13.
    expect(forward).toEqual(["lax-9", "lax-13", "lax-11", "lax-3"]);
  });

  it("sorts submission ids numerically, not lexically", () => {
    expect(["lax-13", "lax-9", "lax-41", "lax-3"].sort(compareIds)).toEqual([
      "lax-3",
      "lax-9",
      "lax-13",
      "lax-41",
    ]);
    expect(issueNumberForId("lax-41")).toBe(41);
  });

  it("treats a cycle as a hard error", () => {
    // The archive cannot contain one (resolution.ts rejects it); a cycle here
    // means the data is corrupt, and no order would be correct.
    expect(() => planOrder([draft("lax-1", ["Lax2"]), draft("lax-2", ["Lax1"])])).toThrow(
      /dependency cycle in the database: lax-1 -> lax-2 -> lax-1/u,
    );
  });

  it("skips stubs and refuses registered records loudly", () => {
    expect(skipReason({ id: "lax-4", state: "init" })).toMatch(/init stub/u);
    expect(skipReason({ id: "lax-7", state: "registered", source: triple(".") })).toMatch(/REGISTERED/u);
    expect(skipReason({ id: "lax-8", state: "deleted" })).toMatch(/retired/u);
    expect(skipReason(draft("lax-9"))).toBeUndefined();
    const plan = planOrder([draft("lax-3", ["Lax4"]), { id: "lax-4", state: "init" }]);
    expect(plan.order).toEqual(["lax-3"]);
    expect(plan.skipped).toEqual([{ id: "lax-4", state: "init", reason: expect.stringMatching(/init stub/u) }]);
    // A dependency that is out of scope is reported, never silently dropped.
    expect(plan.unportableDependencies.get("lax-3")).toEqual(["lax-4 (init stub: no source triple to re-validate)"]);
  });
});

describe("the /lax update comment", () => {
  const source = triple("word-ram");

  it("is accepted by the real command parser and carries the record's own triple", () => {
    const body = updateCommandBody(source);
    expect(body).toBe(
      '/lax update {"repository":"https://github.com/lax-archive/lax-submissions",' +
        '"commit":"311ae7cf15e1bde644721958e05203bb6791d04b","folder":"word-ram"}',
    );
    // The drift guard: whatever the driver emits must parse, and must parse
    // back into exactly the triple that was already recorded. Porting must not
    // change what a record points at.
    expect(parseCommand(body)).toEqual({ action: "update", ...source });
  });

  it("refuses to build a command from an incomplete triple", () => {
    expect(() => updateCommandBody({ repository: source.repository, commit: source.commit })).toThrow(
      /missing folder/u,
    );
  });
});

describe("workflow correlation", () => {
  it("uses the same result marker the control plane emits", () => {
    expect(resultMarker(123)).toBe(realResultMarker(123));
    expect(hasResultMarker(`ok\n\n${realResultMarker(456)}`, 456)).toBe(true);
    // Another command's result on the same issue must not be mistaken for ours.
    expect(hasResultMarker(`ok\n\n${realResultMarker(457)}`, 456)).toBe(false);
  });

  it("trusts a result marker only from the Actions bot", () => {
    // Anyone who can comment on the issue can paste our result marker; the
    // driver would then report a fabricated outcome as the port's verdict.
    const bot = { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" };
    expect(isActionsBot(bot)).toBe(true);
    expect(isActionsBot({ ...bot, id: 1 })).toBe(false);
    expect(isActionsBot({ ...bot, login: "github-actions" })).toBe(false);
    expect(isActionsBot({ ...bot, type: "User" })).toBe(false);
    expect(isActionsBot(null)).toBe(false);
  });

  it("reads the workflow run id out of the run marker", () => {
    expect(parseRunId("Workflow run: [#77](https://x)\n<!-- lax-workflow-run-id:77 -->")).toBe("77");
    expect(parseRunId("no marker here")).toBeUndefined();
  });

  it("hides the correlation markers when printing a comment", () => {
    expect(visibleComment(`Published **lax-13**.\n\n${realResultMarker(9)}`)).toBe("Published **lax-13**.");
  });
});

describe("profile extraction", () => {
  it("names the heaviest phase", () => {
    expect(
      heaviestPhase({ children: [{ name: "compile", ms: 900 }, { name: "inspect", ms: 120 }] }),
    ).toEqual({ name: "compile", ms: 900 });
    expect(heaviestPhase({ children: [] })).toBeUndefined();
  });

  it("tolerates a profile without a peak-memory field", () => {
    // The field is optional and being added concurrently; its absence is
    // normal and must never look like a failure.
    expect(peakMemoryBytes({ profileVersion: 1, stages: [{ span: { name: "total", ms: 1, children: [] } }] })).toBeUndefined();
    expect(
      peakMemoryBytes({ stages: [{ span: { peakMemoryBytes: 1024 } }, { span: { peakMemoryBytes: 4096 } }] }),
    ).toBe(4096);
  });
});

describe("the summary report", () => {
  const rows = [
    {
      id: "lax-13",
      priorState: "draft",
      result: "ok",
      wallMs: 320_000,
      heaviestPhase: { name: "validate/compile", ms: 240_000 },
      peakMemoryBytes: 6 * 1024 ** 3,
      captureDigest: "a".repeat(64),
    },
    { id: "lax-11", priorState: "draft", result: "failed", detail: "resolution: no capture", runUrl: "https://x" },
  ];

  it("prints one line per record with the columns the maintainer needs", () => {
    const table = formatTable(rows);
    expect(table.split("\n")).toHaveLength(4);
    expect(table).toContain("validate/compile 4.0m");
    expect(table).toContain("6.00 GiB");
    expect(table).toContain("aaaaaaaaaaaaaaaa");
  });

  it("writes the same summary as markdown, with the failures spelled out", () => {
    const markdown = formatMarkdown({
      startedAt: "2026-08-06T10:00:00.000Z",
      databaseRepository: "lax-archive/lax-database",
      controlRepository: "lax-archive/lax",
      mode: "full run",
      rows,
      skipped: [{ id: "lax-4", state: "init", reason: "init stub" }],
    });
    expect(markdown).toContain("| lax-13 | draft | ok |");
    expect(markdown).toContain("ported: 1/2");
    expect(markdown).toContain("- `lax-4` (init) — init stub");
    expect(markdown).toContain("resolution: no capture");
  });
});
