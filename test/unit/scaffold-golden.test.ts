// `lax init`'s scaffold, byte for byte, in both content specs
// (test/fixtures/scaffold/<spec>/): the spec-1 files are exactly what every
// release so far wrote, and the spec-2 files are the smallest example of the
// content rules — two tagged statements, a proof outright, a proof with a
// hypothesis, the `variable`/`include` recipe — over the row's library set.
// The mathlib and LaxCore seams are cleared for the length of the test so the
// goldens carry the real pins. LAX_UPDATE_GOLDEN=1 rewrites them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldSubmission } from "../../src/cli/scaffold.js";
import { environment as environmentById, epoch } from "../../src/submission-validation/environments.js";
import { withTestEnvironments } from "../support/environments.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "scaffold");
const SEAMS = ["LAX_MATHLIB_URL", "LAX_MATHLIB_REV", "LAX_LAXCORE_URL", "LAX_LAXCORE_REV", "LAX_CSLIB_URL", "LAX_CSLIB_REV"];
/** LICENSE is the asset itself and is not duplicated into the fixture. */
const UNRECORDED = new Set(["LICENSE"]);

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function withoutSeams<T>(body: () => T): T {
  const saved = SEAMS.map((name) => [name, process.env[name]] as const);
  for (const name of SEAMS) delete process.env[name];
  try {
    return body();
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
}

function files(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.set(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return result;
}

function compare(root: string, golden: string): void {
  const written = files(root);
  expect(written.get("LICENSE")).toBe(fs.readFileSync(path.resolve(FIXTURES, "..", "..", "..", "assets", "apache-2.0.txt"), "utf8"));
  if (process.env.LAX_UPDATE_GOLDEN === "1") {
    fs.rmSync(golden, { recursive: true, force: true });
    for (const [relative, content] of written) {
      if (UNRECORDED.has(relative)) continue;
      fs.mkdirSync(path.dirname(path.join(golden, relative)), { recursive: true });
      fs.writeFileSync(path.join(golden, relative), content);
    }
  }
  const expected = files(golden);
  expect([...written.keys()].filter((relative) => !UNRECORDED.has(relative))).toEqual([...expected.keys()]);
  for (const [relative, content] of expected) expect(written.get(relative), relative).toBe(content);
}

describe("the init scaffold", () => {
  it("writes the spec-1 files it always wrote", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-scaffold-"));
    temporary.push(root);
    withoutSeams(() => scaffoldSubmission(root, "lax-123456", "Golden example", epoch()));
    compare(root, path.join(FIXTURES, "spec1"));
    // the empty module directories a spec-1 author fills
    expect(fs.readdirSync(path.join(root, "concepts", "Lax123456"))).toEqual([]);
    expect(fs.readdirSync(path.join(root, "proofs", "Lax123456Proofs"))).toEqual([]);
  });

  it("writes the spec-2 shape in a spec-2 row: both libraries, an allowed one commented, the smallest edge", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-scaffold-"));
    temporary.push(root);
    withoutSeams(() =>
      withTestEnvironments(
        [
          {
            id: "v4.99.0",
            leanToolchain: "leanprover/lean4:v4.99.0",
            mathlibCommit: "a".repeat(40),
            specVersion: 2,
            libraries: [
              { name: "LaxCore", commit: "b".repeat(40) },
              { name: "cslib", commit: "c".repeat(40) },
            ],
          },
        ],
        () => scaffoldSubmission(root, "lax-123456", "Golden example", environmentById("v4.99.0")!),
      ),
    );
    compare(root, path.join(FIXTURES, "spec2"));
    const concepts = fs.readFileSync(path.join(root, "concepts", "lakefile.toml"), "utf8");
    expect(concepts).toContain('name = "LaxCore"');
    expect(concepts).toContain(`# name = "cslib"`);
    expect(fs.readFileSync(path.join(root, "manifest.yaml"), "utf8")).toContain('specVersion: "2"');
    expect(fs.readFileSync(path.join(root, "concepts", "Lax123456", "Basic.lean"), "utf8")).toContain("@[lax_statement] def AddZero : Prop :=");
    expect(fs.readFileSync(path.join(root, "proofs", "Lax123456Proofs", "Basic.lean"), "utf8")).toContain("include hAddZero in");
  });
});
