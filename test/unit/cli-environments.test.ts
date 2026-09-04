// `lax init --env`: choosing an archive environment other than the epoch, the
// typed confirmation that choice needs, and the sharing counts the block shows.
//
// Straying is allowed and nudged, never refused — so what is asserted here is
// that the nudge cannot be walked past by accident (a terminal types the id, a
// script passes --yes, and neither happens by default), and that an id this
// CLI does not admit is refused before a single file is written.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeSubmission } from "../../src/cli/commands.js";
import { registeredByEnvironment } from "../../src/cli/environments.js";
import * as ui from "../../src/cli/ui.js";
import { epoch } from "../../src/submission-validation/environments.js";
import { markWarmReady, warmDir } from "../../src/submission-validation/host/warmstore.js";
import { mathlibUrl } from "../../src/submission-validation/pins.js";
import { withTestEnvironmentsAsync } from "../support/environments.js";
import { removeTree } from "../support/tmp.js";

/** The second environment every test here strays to. It borrows the installed
 * toolchain and the active mathlib commit, which is what makes a second
 * environment testable on a machine with one Lean install. */
const STRAY = "v4.99.0";

const previous = { home: process.env.LAX_HOME, elan: process.env.ELAN_HOME };
let home: string;
let answers: string[];
let asked: string[];

vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: () => ({
      question: (prompt: string) => {
        asked.push(prompt);
        return Promise.resolve(answers.shift() ?? "");
      },
      close: () => undefined,
    }),
  },
}));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-env-"));
  process.env.LAX_HOME = home;
  process.env.ELAN_HOME = path.join(home, "elan");
  answers = [];
  asked = [];
  ui.configure({ color: false });
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeTree(home);
  restoreTty();
  if (previous.home === undefined) delete process.env.LAX_HOME;
  else process.env.LAX_HOME = previous.home;
  if (previous.elan === undefined) delete process.env.ELAN_HOME;
  else process.env.ELAN_HOME = previous.elan;
});

let ttyPatched = false;
function setTty(value: boolean): void {
  ttyPatched = true;
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}
function restoreTty(): void {
  if (!ttyPatched) return;
  ttyPatched = false;
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
}

/** A warm store the scaffold's provisioning finds ready, so no test here
 * downloads mathlib. Keyed by environment, which is the point: the stray
 * environment has a store of its own. */
function seedWarmStore(id: string, mathlibCommit: string): void {
  const warm = warmDir({
    id,
    leanToolchain: epoch().leanToolchain,
    mathlibCommit,
    admittedAt: epoch().admittedAt,
    inspector: "inspector",
  });
  fs.mkdirSync(path.join(warm, ".lake", "packages", "mathlib"), { recursive: true });
  fs.writeFileSync(
    path.join(warm, "lake-manifest.json"),
    JSON.stringify({
      version: "1.2.0",
      packagesDir: ".lake/packages",
      packages: [
        {
          url: mathlibUrl(),
          type: "git",
          subDir: null,
          scope: "",
          rev: mathlibCommit,
          name: "mathlib",
          manifestFile: "lake-manifest.json",
          inputRev: mathlibCommit,
          inherited: false,
          configFile: "lakefile.toml",
        },
      ],
    }),
  );
  markWarmReady(warm);
}

function target(): string {
  return path.join(home, "work");
}

/** Everything the command wrote, both streams: a refusal is written straight
 * to stderr and the report to stdout, and an author reads one screen. */
function quiet(): Array<{ mock: { calls: unknown[][] } }> {
  return [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  ];
}

function printed(log: Array<{ mock: { calls: unknown[][] } }>): string {
  return log.flatMap((spy) => spy.mock.calls.map(([line]) => String(line))).join("\n");
}

/** A registered record of the local archive copy, in the two files the count
 * reads: the state comes from record.json, the environment from the manifest
 * echoed into build-output.json. */
function seedRecord(id: string, state: string, leanVersion: string): void {
  const directory = path.join(home, "lax-database", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "record.json"), JSON.stringify({ id, state }));
  fs.writeFileSync(
    path.join(directory, "build-output.json"),
    JSON.stringify({ id, inputs: { manifest: { leanVersion } } }),
  );
}

describe("lax init --env", () => {
  it("accepts the environment id typed back, and scaffolds against its pins", async () => {
    seedWarmStore(STRAY, epoch().mathlibCommit);
    setTty(true);
    answers.push(STRAY);
    const log = quiet();

    const code = await withTestEnvironmentsAsync([{ id: STRAY }], () =>
      initializeSubmission(target(), { title: "Strayed", env: STRAY }),
    );

    expect(code).toBe(0);
    const output = printed(log);
    expect(output).toContain(`Environment ${STRAY}`);
    expect(output).toContain(`Only submissions in ${STRAY} can cite this work.`);
    expect(asked.join("")).toContain(`Type ${STRAY} to confirm`);
    // Every pin-bearing file of the scaffold says the same environment.
    const manifest = fs.readFileSync(path.join(target(), "manifest.yaml"), "utf8");
    expect(manifest).toContain(`leanVersion: "${STRAY}"`);
    expect(manifest).toContain(`mathlibVersion: "${epoch().mathlibCommit}"`);
    for (const kind of ["concepts", "proofs"]) {
      expect(fs.readFileSync(path.join(target(), kind, "lean-toolchain"), "utf8").trim()).toBe(
        epoch().leanToolchain,
      );
      expect(fs.readFileSync(path.join(target(), kind, "lakefile.toml"), "utf8")).toContain(
        epoch().mathlibCommit,
      );
    }
  });

  it("writes nothing when the answer is not the environment id", async () => {
    setTty(true);
    answers.push("yes");
    const log = quiet();

    const code = await withTestEnvironmentsAsync([{ id: STRAY }], () =>
      initializeSubmission(target(), { env: STRAY }),
    );

    expect(code).toBe(1);
    expect(fs.existsSync(target())).toBe(false);
    expect(printed(log)).toContain(`That is not ${STRAY}`);
  });

  it("refuses without a terminal and names the flag that stands in for one", async () => {
    setTty(false);
    const log = quiet();

    const code = await withTestEnvironmentsAsync([{ id: STRAY }], () =>
      initializeSubmission(target(), { env: STRAY }),
    );

    expect(code).toBe(1);
    expect(fs.existsSync(target())).toBe(false);
    const output = printed(log);
    expect(output).toContain(`creating a submission in ${STRAY}`);
    expect(output).toContain("Rerun with --yes if you mean it.");
  });

  it("--yes stands in for the typed answer, and still says what it means", async () => {
    seedWarmStore(STRAY, epoch().mathlibCommit);
    setTty(false);
    const log = quiet();

    const code = await withTestEnvironmentsAsync([{ id: STRAY }], () =>
      initializeSubmission(target(), { env: STRAY, yes: true }),
    );

    expect(code).toBe(0);
    expect(asked).toEqual([]);
    // The block is not skipped with the prompt: an agent reading the log still
    // learns which island the work landed on.
    expect(printed(log)).toContain(`Only submissions in ${STRAY} can cite this work.`);
    expect(fs.readFileSync(path.join(target(), "manifest.yaml"), "utf8")).toContain(
      `leanVersion: "${STRAY}"`,
    );
  });

  it("asks nothing when --env names the epoch, as the default does not", async () => {
    seedWarmStore(epoch().id, epoch().mathlibCommit);
    setTty(true);
    const log = quiet();

    const code = await initializeSubmission(target(), { env: epoch().id });

    expect(code).toBe(0);
    expect(asked).toEqual([]);
    expect(printed(log)).not.toContain("Environment ");
  });

  it("refuses an id the table does not admit, with the list and the reason", async () => {
    await expect(initializeSubmission(target(), { env: "v9.9.9" })).rejects.toThrow(
      /v9\.9\.9 is not an archive environment\. Admitted: v4\.30\.0 \(epoch\).*Update lax if the environment is newer than this CLI\./su,
    );
    expect(fs.existsSync(target())).toBe(false);
  });

  it("counts the registered submissions of each environment from the local copy", async () => {
    // No clone at all is a different answer from none registered: the block
    // says `lax sync` rather than printing a zero it cannot stand behind.
    expect(registeredByEnvironment()).toBeUndefined();

    fs.mkdirSync(path.join(home, "lax-database", ".git"), { recursive: true });
    seedRecord("lax-1", "registered", epoch().id);
    seedRecord("lax-2", "registered", epoch().id);
    seedRecord("lax-3", "registered", STRAY);
    seedRecord("lax-4", "draft", STRAY);
    seedRecord("lax-5", "deleted", epoch().id);

    const counts = registeredByEnvironment();

    expect(counts?.get(epoch().id)).toBe(2);
    expect(counts?.get(STRAY)).toBe(1);
  });

  it("shows both populations, and says to sync when there is nothing to count", async () => {
    seedWarmStore(STRAY, epoch().mathlibCommit);
    fs.mkdirSync(path.join(home, "lax-database", ".git"), { recursive: true });
    seedRecord("lax-1", "registered", epoch().id);
    seedRecord("lax-2", "registered", epoch().id);
    seedRecord("lax-3", "registered", STRAY);
    setTty(false);
    const log = quiet();

    await withTestEnvironmentsAsync([{ id: STRAY }], () =>
      initializeSubmission(target(), { env: STRAY, yes: true }),
    );

    const output = printed(log);
    expect(output).toContain(`${epoch().id} is the archive's epoch, with 2 registered submissions;`);
    expect(output).toContain(`${STRAY} has 1.`);

    // …and with no copy on the machine, the count is replaced by the command
    // that would produce one.
    removeTree(path.join(home, "lax-database"));
    const second = quiet();
    await withTestEnvironmentsAsync([{ id: STRAY }], () =>
      initializeSubmission(path.join(home, "again"), { env: STRAY, yes: true }),
    );
    expect(printed(second)).toContain("run lax sync to");
  });
});
