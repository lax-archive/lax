// The admission scripts (scripts/environments/), without a network.
//
// Three things in them are worth proving here: which mathlib tags become
// candidates (a rule that decides whether a runner spends twenty minutes, and
// whether the backlog nobody asked for gets admitted by accident), the exact
// text `admit.mjs` writes into the table (a file a human is asked to merge),
// and that the table parser the CI gate reads with agrees with the compiled
// table it stands in for. Everything below the network line in discover.mjs —
// `git ls-remote`, the raw `lean-toolchain` fetch — is exercised by the
// workflow itself, not here.

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMISSION_START,
  candidateTags,
  compareVersions,
  expectedToolchain,
  parseLsRemote,
  // @ts-expect-error -- a plain .mjs script, deliberately untyped like scripts/port-db
} from "../../scripts/environments/discover.mjs";
import {
  admit,
  // @ts-expect-error -- a plain .mjs script, deliberately untyped like scripts/port-db
} from "../../scripts/environments/admit.mjs";
import {
  appendEntry,
  parseTable,
  TABLE_FILE,
  // @ts-expect-error -- a plain .mjs script, deliberately untyped like scripts/port-db
} from "../../scripts/environments/table.mjs";
import { environments } from "../../src/submission-validation/environments.js";
import { withoutTestEnvironments } from "../support/environments.js";

const TAGS = [
  "v4.29.0",
  "v4.30.0",
  "v4.30.1",
  "v4.31.0",
  "v4.32.0",
  "v4.33.0",
  "v4.34.0",
  "v4.34.0-rc1",
  "nightly-2026-09-01",
];

describe("discover.mjs: which mathlib releases are candidates", () => {
  it("keeps only vX.Y.0 releases above the start, and drops the admitted ones", () => {
    expect(candidateTags(TAGS, { known: ["v4.30.0"], floor: "v4.30.0" })).toEqual([
      "v4.33.0",
      "v4.34.0",
    ]);
  });

  it("skips the backlog the plan decided not to admit", () => {
    // v4.31.0 and v4.32.0 came out before admission existed: nobody needs
    // them and each would cost a full run (environments-plan.md, "Open
    // decisions" — forward only).
    const kept = candidateTags(TAGS, { known: ["v4.30.0"], floor: "v4.30.0" });
    expect(kept).not.toContain("v4.31.0");
    expect(kept).not.toContain("v4.32.0");
    expect(compareVersions(ADMISSION_START, "v4.32.0")).toBeGreaterThan(0);
  });

  it("never proposes a patch release, a prerelease, or a nightly", () => {
    const kept = candidateTags(TAGS, { known: [], floor: "v4.30.0", startAt: "v4.30.0" });
    expect(kept).toEqual(["v4.30.0", "v4.31.0", "v4.32.0", "v4.33.0", "v4.34.0"]);
  });

  it("never proposes anything below the floor", () => {
    // Older Lake versions have neither the package-overrides nor the
    // artifact-cache behaviour the warm store relies on.
    expect(candidateTags(["v4.29.0", "v4.28.0"], { floor: "v4.30.0", startAt: "v4.28.0" })).toEqual(
      [],
    );
  });

  it("takes the floor from the table when it is not given", () => {
    expect(candidateTags(TAGS, { known: ["v4.33.0"], startAt: "v4.30.0" })).toEqual(["v4.34.0"]);
  });

  it("orders candidates oldest first and drops duplicates", () => {
    expect(
      candidateTags(["v4.35.0", "v4.34.0", "v4.35.0"], { floor: "v4.30.0", startAt: "v4.30.0" }),
    ).toEqual(["v4.34.0", "v4.35.0"]);
  });

  it("reads a tag's commit from the peeled ref of an annotated tag", () => {
    const commits = parseLsRemote(
      [
        `${"a".repeat(40)}\trefs/tags/v4.34.0`,
        `${"b".repeat(40)}\trefs/tags/v4.34.0^{}`,
        `${"c".repeat(40)}\trefs/heads/master`,
      ].join("\n"),
    ) as Map<string, string>;
    expect(commits.get("v4.34.0")).toBe("b".repeat(40));
    expect(commits.has("master")).toBe(false);
  });

  it("knows which toolchain a tag has to declare", () => {
    // Asserted against the tag's own lean-toolchain at admission; a mismatch
    // means mathlib's release does not build with the Lean release of the same
    // name, and the environment identity would be a lie.
    expect(expectedToolchain("v4.34.0")).toBe("leanprover/lean4:v4.34.0");
  });
});

const FIXTURE = `import type { ValidationLimits } from "./config.js";

export const EPOCH = "v4.30.0";

const TABLE: readonly ArchiveEnvironment[] = [
  {
    id: "v4.30.0",
    leanToolchain: "leanprover/lean4:v4.30.0",
    mathlibCommit: "c5ea00351c28e24afc9f0f84379aa41082b1188f",
    // the go-live pin (history/go-live.md), not an admission run
    admittedAt: "2026-08-06",
    inspector: "inspector",
  },
];

export function environments(): readonly ArchiveEnvironment[] {
  return TABLE;
}
`;

const COMMIT = "db584cd6d46c92f209a44c0f1c829460d327499d";

describe("admit.mjs: the row an admission writes", () => {
  it("appends the entry after the last one, inside the table", () => {
    const updated = admit(
      FIXTURE,
      new Map([
        ["id", "v4.33.0"],
        ["commit", COMMIT],
        ["date", "2026-09-05"],
      ]),
    ) as string;
    expect(updated).toContain(`  {
    id: "v4.33.0",
    leanToolchain: "leanprover/lean4:v4.33.0",
    mathlibCommit: "${COMMIT}",
    admittedAt: "2026-09-05",
    inspector: "inspector",
  },
];`);
    // the existing row is untouched: the table only grows
    expect(updated).toContain('id: "v4.30.0"');
    expect(updated).toContain("// the go-live pin");
    expect((parseTable(updated) as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      "v4.30.0",
      "v4.33.0",
    ]);
  });

  it("records the measured limits when the run produced one, and nothing when it did not", () => {
    const measured = admit(
      FIXTURE,
      new Map([
        ["id", "v4.33.0"],
        ["commit", COMMIT],
        ["date", "2026-09-05"],
        ["memory-bytes", "12884901888"],
        ["lean-threads", "2"],
      ]),
    ) as string;
    expect(measured).toContain("limits: { leanThreads: 2, memoryBytes: 12884901888 },");
    const unmeasured = admit(
      FIXTURE,
      new Map([
        ["id", "v4.33.0"],
        ["commit", COMMIT],
        ["date", "2026-09-05"],
      ]),
    ) as string;
    // no invented budget: without a measurement the entry inherits
    // DEFAULT_LIMITS, which is the honest state
    expect(unmeasured).not.toContain("limits:");
  });

  it("refuses an id already in the table", () => {
    // An entry is never edited once written except to add `limits` or
    // `closedAt`; re-admitting would silently change a live environment.
    expect(() =>
      admit(FIXTURE, new Map([["id", "v4.30.0"], ["commit", COMMIT], ["date", "2026-09-05"]])),
    ).toThrow(/already in the environment table/u);
  });

  it("refuses anything that is not a version, a commit, and a date", () => {
    // Everything here arrives from a scheduled run's network reads or a
    // workflow_dispatch input (trust rule 2), and lands in a file a human is
    // asked to merge.
    const bad = (values: Array<[string, string]>): (() => unknown) => () =>
      admit(FIXTURE, new Map(values));
    expect(bad([["id", "../etc"], ["commit", COMMIT], ["date", "2026-09-05"]])).toThrow(/refusing/u);
    expect(bad([["id", "v4.33.0"], ["commit", "HEAD"], ["date", "2026-09-05"]])).toThrow(/refusing/u);
    expect(bad([["id", "v4.33.0"], ["commit", COMMIT], ["date", "yesterday"]])).toThrow(/refusing/u);
    expect(() =>
      appendEntry(FIXTURE, {
        id: "v4.33.0",
        mathlibCommit: COMMIT,
        admittedAt: "2026-09-05",
        limits: { memoryBytes: -1 },
      }),
    ).toThrow(/refusing to record the limit/u);
  });

  it("dates the entry in UTC by default", () => {
    const updated = admit(FIXTURE, new Map([["id", "v4.33.0"], ["commit", COMMIT]])) as string;
    expect(updated).toMatch(/admittedAt: "\d{4}-\d{2}-\d{2}"/u);
  });
});

describe("table.mjs: the parser the CI gate reads the table with", () => {
  it("agrees with the compiled table", () => {
    // matrix.mjs reads the table's *source text*, so the inspector-matrix gate
    // needs no npm install and no build — which is only safe while the two
    // readings cannot drift. The mathlib commit is excluded: the fast suite
    // substitutes the fake mathlib's rev through LAX_MATHLIB_REV.
    const parsed = (parseTable(fs.readFileSync(TABLE_FILE as string, "utf8")) as Array<{
      id: string;
      leanToolchain: string;
      inspector: string;
    }>).map(({ id, leanToolchain, inspector }) => ({ id, leanToolchain, inspector }));
    // the source text has no seam: compare against the compiled table with
    // LAX_TEST_ENVIRONMENTS cleared, which an admission run sets suite-wide
    const compiled = withoutTestEnvironments(() =>
      environments().map(({ id, leanToolchain, inspector }) => ({ id, leanToolchain, inspector })),
    );
    expect(parsed).toEqual(compiled);
  });

  it("fails loudly rather than returning a short table", () => {
    // A gate that silently guards fewer environments than the archive admits
    // is worse than a red job.
    expect(() => parseTable("const OTHER = [];")).toThrow(/no longer declares a TABLE/u);
    expect(() =>
      parseTable(FIXTURE.replace('mathlibCommit: "c5ea00351c28e24afc9f0f84379aa41082b1188f"', 'mathlibCommit: "c5ea003"')),
    ).toThrow(/records the mathlib commit/u);
    expect(() =>
      parseTable(FIXTURE.replace('leanToolchain: "leanprover/lean4:v4.30.0"', 'leanToolchain: "leanprover/lean4:v4.31.0"')),
    ).toThrow(/names the toolchain/u);
  });
});
