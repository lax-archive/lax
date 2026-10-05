// The inspector's output contract, one environment at a time.
//
// `test/fixtures/inspector-golden/` is a Lean package that imports nothing but
// `Init`, so it builds under any admitted environment in a couple of seconds
// with no mathlib anywhere. Its committed `expected.json` is the report the
// inspector must produce: module docs, the `---` frontmatter grammar, a
// matcher read back out of `Match.Extension`, private and reserved names, a
// structure's internal-detail names, an axiom closure, a pretty-printed axiom
// signature, and `conclusionFacts`. The website reads the same JSON, so this
// is the file to look at when a new Lean release changes what the archive
// reports.
//
// `test/fixtures/inspector-golden-spec2/` is its spec-2 sibling (imports
// `Lean`, still no mathlib): the four spec-2 facts read under `--spec 2` over
// a hook-less twin of LaxCore, so the tagged shapes the real hook refuses
// are in the report as facts for the validator to judge.
//
// Which environments run here is decided by which toolchains are installed:
// the epoch in a normal run, and any environment `LAX_TEST_ENVIRONMENTS`
// injects whose toolchain the machine has (the admission workflow and each
// `inspector-matrix` leg provision exactly one target environment). An
// environment whose toolchain is absent is skipped rather than provisioned —
// a Lean install is 3 GB — but a run in which *nothing* was compared fails.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ContentSpecVersion, ModuleInventory } from "../../src/submission-validation/contracts.js";
import {
  environments,
  type ArchiveEnvironment,
} from "../../src/submission-validation/environments.js";
import { inspectorBinary } from "../../src/submission-validation/host/inspector.js";
import { inspectorArguments, parseInspectorReport } from "../../src/submission-validation/phases/inspect-runner.js";
import {
  lakeBinary,
  lakePathEnv,
  toolchainDir,
} from "../../src/submission-validation/host/leanenv.js";
import { leanFacts } from "../../src/submission-validation/lean-facts.js";
import { run } from "../../src/submission-validation/host/proc.js";
import { SHARED_TOOLS, TEST_CACHE } from "../paths.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** One golden: a fixture package, the spec the inspector is run under, and
 * the modules it is asked about — the root first, as the pipeline passes a
 * package's file-derived inventory. */
interface Golden {
  fixture: string;
  spec: ContentSpecVersion;
  sources: string[];
  modules: string[];
}

const GOLDENS: Golden[] = [
  // the spec-1 contract, byte-identical since before spec 2 existed until
  // 2026-10-05, when every ranged declaration gained `startColumn` and
  // `endColumn` beside its lines (the unused-helper rule's containment test,
  // R5 of spike/axiomfree/codex-review-night-20261005.md) — nothing else moved
  {
    fixture: "inspector-golden",
    spec: 1,
    sources: ["lakefile.toml", "lake-manifest.json", "Golden.lean", "Golden/Basic.lean"],
    modules: ["Golden", "Golden.Basic"],
  },
  // the spec-2 facts over a hook-less twin of LaxCore (see the fixture's
  // LaxCore.lean): tagged declarations of every shape, telescopes over every
  // binder kind (none recorded), universe levels of every form
  {
    fixture: "inspector-golden-spec2",
    spec: 2,
    sources: ["lakefile.toml", "lake-manifest.json", "LaxCore.lean", "Spec2.lean", "Spec2/Basic.lean"],
    modules: ["Spec2", "Spec2.Basic"],
  },
];

/**
 * Build a fixture with one environment's toolchain and return its lib dir.
 * Cached under the shared test cache by toolchain and source hash, the way
 * the inspector build itself is: the fixture is tiny, but so is the cost of
 * not rebuilding it in every run.
 */
async function buildFixture(golden: Golden, environment: ArchiveEnvironment): Promise<string> {
  const fixtureDir = path.join(FIXTURES, golden.fixture);
  const hash = createHash("sha256");
  hash.update(environment.leanToolchain);
  for (const relative of golden.sources) {
    hash.update(relative);
    hash.update(fs.readFileSync(path.join(fixtureDir, relative)));
  }
  const dir = path.join(TEST_CACHE, golden.fixture, hash.digest("hex").slice(0, 16));
  const libDir = path.join(dir, ...leanFacts().lakeLibDir);
  if (fs.existsSync(path.join(libDir, `${golden.modules[0]!}.olean`))) return libDir;

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const relative of golden.sources) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(fixtureDir, relative), target);
  }
  // generated, never committed — exactly as inspectorBinary does it, so no
  // hand-maintained file in the fixture can drift from the table
  fs.writeFileSync(path.join(dir, "lean-toolchain"), `${environment.leanToolchain}\n`);
  const result = await run(lakeBinary(environment), ["build"], dir, {
    env: { LAKE_ARTIFACT_CACHE: "false", PATH: lakePathEnv(environment) },
  });
  if (result.code !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `the golden fixture failed to build under ${environment.leanToolchain}:\n${result.output}`,
    );
  }
  return libDir;
}

const table = environments();
const installed = new Set(
  table.filter((entry) => fs.existsSync(toolchainDir(entry))).map((entry) => entry.id),
);

describe("inspector golden report", () => {
  it("compares against at least one installed environment", () => {
    expect([...installed]).not.toHaveLength(0);
  });

  // One inspector source serves both specs, so every installed environment
  // runs both goldens: the spec-1 report must not move under any toolchain,
  // and the spec-2 facts must read the same from every one.
  for (const environment of table) {
    const runIt = installed.has(environment.id) ? it : it.skip;
    for (const golden of GOLDENS) {
      runIt(`${environment.id} reports the ${golden.fixture} fixture exactly under --spec ${golden.spec}`, async () => {
        const libDir = await buildFixture(golden, environment);
        // the build carries the shape guards: a drifted core type fails here
        const inspector = await inspectorBinary(environment, {}, SHARED_TOOLS);
        fs.mkdirSync(TEST_CACHE, { recursive: true });
        const outDir = fs.mkdtempSync(path.join(TEST_CACHE, "golden-run-"));
        const reportPath = path.join(outDir, "report.json");
        const inventory: ModuleInventory = {
          packageName: golden.modules[0]!,
          packageDir: ".",
          rootModule: golden.modules[0]!,
          modules: golden.modules.slice(1),
          paths: new Map(),
        };
        // LEAN_PATH over the fixture's own oleans and the environment's own bin
        // dir first, exactly as hostLeanEnv composes them for Inspect: the
        // inspector resolves its sysroot through the `lean` it finds on PATH, so
        // a bare PATH would silently check against whatever elan defaults to.
        const result = await run(inspector, inspectorArguments(golden.spec, reportPath, inventory), outDir, {
          env: { LEAN_PATH: libDir, PATH: lakePathEnv(environment) },
        });
        expect(result.output).not.toMatch(/error/iu);
        expect(result.code).toBe(0);
        const actual = fs.readFileSync(reportPath, "utf8").trim();
        const expected = fs.readFileSync(path.join(FIXTURES, golden.fixture, "expected.json"), "utf8").trim();
        // Compared as text, not as parsed JSON: key order and number formatting
        // are part of what the website consumes, and the spike measured them
        // byte-identical from v4.30.0 to v4.33.0. A legitimate difference is a
        // decision to record here, never one to normalise away in silence.
        expect(actual).toBe(expected);
        // and the report parses as what the pipeline would read for that spec
        expect(() => parseInspectorReport(JSON.parse(actual) as unknown, golden.spec)).not.toThrow();
        fs.rmSync(outDir, { recursive: true, force: true });
      });
    }
  }
});
