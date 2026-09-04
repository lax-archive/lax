// The trusted workflow's per-environment host provisioning (history/environments-plan.md
// stage 2): the Actions cache identity host/setup.ts derives from an
// environment's table row, and the `setup-vm.js [--env <id>] [--cache-key]`
// argument contract the three workflows call through. The YAML side — which
// step feeds which — is asserted in test/workflows/workflow-definition.test.ts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  admittedEnvironmentList,
  environment as environmentById,
  epoch,
} from "../../src/submission-validation/environments.js";
import {
  hashInspectorSources,
  inspectorSourceHash,
} from "../../src/submission-validation/host/inspector.js";
import {
  HOST_CACHE_SALT,
  parseSetupVmArguments,
  validationHostCacheKey,
} from "../../src/submission-validation/host/setup.js";
import { appendWorkflowOutput } from "../../src/submission-validation/outputs.js";
import { withTestEnvironments } from "../support/environments.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const setupVm = path.join(repoRoot, "src", "submission-validation", "host", "setup-vm.ts");
const temporaries: string[] = [];

afterEach(() => {
  for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lax-host-setup-"));
  temporaries.push(directory);
  return directory;
}

/** A second environment sharing the installed toolchain — a different row
 * of the table that has nothing to do with the epoch's provisioning. */
const OTHER = { id: "v4.31.0", mathlibCommit: "7".repeat(40) };

describe("the host cache key", () => {
  it("is the salt, the runner OS, the row's id, its commit, and its inspector hash", () => {
    const key = validationHostCacheKey(epoch(), "Linux");
    expect(key).toBe(
      `${HOST_CACHE_SALT}-Linux-${epoch().id}-${epoch().mathlibCommit.slice(0, 12)}-${inspectorSourceHash(epoch())}`,
    );
    expect(key).toMatch(/^lax-validation-host-v2-Linux-v4\.30\.0-[0-9a-f]{12}-[0-9a-f]{16}$/u);
    // Deterministic: the same row always names the same store.
    expect(validationHostCacheKey(epoch(), "Linux")).toBe(key);
    // The OS is a token, never a path or an expression.
    expect(() => validationHostCacheKey(epoch(), "${{ runner.os }}")).toThrow("short token");
  });

  it("changes with the toolchain, the mathlib commit, and the inspector sources — and with nothing else", () => {
    const key = validationHostCacheKey(epoch(), "Linux");
    // An unrelated row added to the table (a monthly admission) leaves the
    // epoch's key alone: the key is derived from the row, not the table.
    withTestEnvironments([OTHER], () => {
      expect(environmentById(OTHER.id)).toBeDefined();
      expect(validationHostCacheKey(epoch(), "Linux")).toBe(key);
      // The other row has its own store.
      const other = validationHostCacheKey(environmentById(OTHER.id)!, "Linux");
      expect(other).not.toBe(key);
      expect(other).toContain(`-${OTHER.id}-${OTHER.mathlibCommit.slice(0, 12)}-`);
      // Same toolchain and sources: the inspector hash is the shared part.
      expect(other.split("-").at(-1)).toBe(key.split("-").at(-1));
    });
    // A different toolchain builds a different inspector: the hash moves even
    // though the sources are byte-identical.
    withTestEnvironments([{ ...OTHER, leanToolchain: "leanprover/lean4:v4.31.0" }], () => {
      const other = validationHostCacheKey(environmentById(OTHER.id)!, "Linux");
      expect(other.split("-").at(-1)).not.toBe(key.split("-").at(-1));
    });
    expect(validationHostCacheKey(epoch(), "Linux")).toBe(key);
  });

  it("folds the inspector sources into the hash, file by file", () => {
    const write = (contents: Record<string, string>): string => {
      const directory = temporary();
      for (const [name, text] of Object.entries(contents)) fs.writeFileSync(path.join(directory, name), text);
      return directory;
    };
    const sources = { "lakefile.toml": "name = \"inspector\"\n", "lake-manifest.json": "{}\n", "Main.lean": "def main := pure ()\n" };
    const toolchain = "leanprover/lean4:v4.30.0";
    const base = hashInspectorSources(toolchain, write(sources));
    expect(base).toMatch(/^[0-9a-f]{16}$/u);
    expect(hashInspectorSources(toolchain, write(sources))).toBe(base);
    expect(hashInspectorSources(toolchain, write({ ...sources, "Main.lean": "def main := pure ()\n-- changed\n" }))).not.toBe(base);
    expect(hashInspectorSources("leanprover/lean4:v4.31.0", write(sources))).not.toBe(base);
    // The shipped sources hash to what the epoch's key carries.
    expect(inspectorSourceHash(epoch())).toMatch(/^[0-9a-f]{16}$/u);
  });
});

describe("setup-vm arguments", () => {
  it("provisions the epoch with no --env, as ci.yml and release.yml call it", () => {
    expect(parseSetupVmArguments([])).toEqual({ environment: epoch(), cacheKeyOnly: false });
    expect(parseSetupVmArguments(["--cache-key"])).toEqual({ environment: epoch(), cacheKeyOnly: true });
    expect(parseSetupVmArguments(["--env", epoch().id])).toEqual({ environment: epoch(), cacheKeyOnly: false });
  });

  it("looks --env up in the table and returns the row, not the string", () => {
    withTestEnvironments([OTHER], () => {
      const parsed = parseSetupVmArguments(["--env", OTHER.id, "--cache-key"]);
      expect(parsed.environment).toEqual(environmentById(OTHER.id));
      expect(parsed.environment.mathlibCommit).toBe(OTHER.mathlibCommit);
      expect(parsed.cacheKeyOnly).toBe(true);
    });
  });

  it("refuses an id the table does not admit, naming the admitted list", () => {
    // The id is what the static gate wrote and the workflow passed through
    // env:; nothing is derived from it before this lookup.
    for (const id of ["v9.9.9", "../../etc", "v4.30.0/../x", "", "v4.30.0 (epoch)"]) {
      expect(() => parseSetupVmArguments(["--env", id]), id).toThrow(
        id === "" ? "--env needs an environment id" : `is not admitted; the admitted environments are ${admittedEnvironmentList()}`,
      );
    }
    expect(() => parseSetupVmArguments(["--env"])).toThrow("--env needs an environment id");
    expect(() => parseSetupVmArguments(["--env", "--cache-key"])).toThrow("--env needs an environment id");
    expect(() => parseSetupVmArguments(["--env", "v4.30.0", "--env", "v4.30.0"])).toThrow("given twice");
    expect(() => parseSetupVmArguments(["--environment", "v4.30.0"])).toThrow("unknown argument");
  });

  it("exits nonzero from the entry point on an unknown id, before provisioning anything", () => {
    // The real script, the way the validate job runs it: the refusal must
    // reach the job log and fail the step.
    let failure: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, [tsx, setupVm, "--env", "v9.9.9"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LAX_TEST_ENVIRONMENTS: "" },
      });
    } catch (error) {
      failure = error as { status?: number; stderr?: string };
    }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain(
      `lax setup: environment "v9.9.9" is not admitted; the admitted environments are v4.30.0 (epoch)`,
    );
  });

  it("names the epoch's key with --cache-key, as a step output and on stdout", () => {
    // ci.yml and release.yml take the key from this step's output; it must be
    // the same key the static gate computes for the same row.
    const outputFile = path.join(temporary(), "github-output");
    const stdout = execFileSync(process.execPath, [tsx, setupVm, "--cache-key"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LAX_TEST_ENVIRONMENTS: "", GITHUB_OUTPUT: outputFile, RUNNER_OS: "Linux" },
    });
    const key = validationHostCacheKey(epoch(), "Linux");
    expect(stdout.trim()).toBe(key);
    expect(fs.readFileSync(outputFile, "utf8")).toMatch(new RegExp(`^cache_key<<(lax_\\d+_\\d+)\\n${key}\\n\\1\\n$`, "u"));
  });
});

describe("workflow step outputs", () => {
  it("appends heredoc-form outputs to GITHUB_OUTPUT and refuses to run without one", () => {
    const outputFile = path.join(temporary(), "github-output");
    const previous = process.env.GITHUB_OUTPUT;
    try {
      delete process.env.GITHUB_OUTPUT;
      expect(() => appendWorkflowOutput("environment", "v4.30.0")).toThrow("GITHUB_OUTPUT is required");
      process.env.GITHUB_OUTPUT = outputFile;
      appendWorkflowOutput("environment", "v4.30.0");
      appendWorkflowOutput("cache_key", "lax-validation-host-v2-Linux-v4.30.0-000000000000-0000000000000000");
      expect(() => appendWorkflowOutput("cache-key", "x")).toThrow("invalid workflow output name");
    } finally {
      if (previous === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = previous;
    }
    const text = fs.readFileSync(outputFile, "utf8");
    expect(text).toMatch(/^environment<<(lax_\d+_\d+)\nv4\.30\.0\n\1\ncache_key<<(lax_\d+_\d+)\nlax-validation-host-v2-[^\n]+\n\2\n$/u);
  });
});
