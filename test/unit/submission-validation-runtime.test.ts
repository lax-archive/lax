import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturePackage } from "../../src/submission-validation/captures/seal.js";
import { configuredRuntime, DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import type { ModuleInventory } from "../../src/submission-validation/contracts.js";
import { replayPackage } from "../../src/submission-validation/phases/replay.js";
import { ContainerRunner, type ContainerInvocation } from "../../src/submission-validation/sandbox/container.js";
import {
  cleanupTemporary,
  RUNTIME,
  temporary,
  writeFile,
} from "../support/submission-validation.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  cleanupTemporary();
});

describe("validation runtime boundaries retained from main", () => {
  it("requires an immutable runtime digest", () => {
    expect(configuredRuntime(RUNTIME.image)).toMatchObject({
      image: RUNTIME.image,
      imageDigest: RUNTIME.imageDigest,
      leanToolchain: RUNTIME.leanToolchain,
    });
    expect(() => configuredRuntime("ghcr.io/lax-archive/validation:latest")).toThrow(
      "immutable @sha256 digest",
    );
    expect(() => configuredRuntime("sha256:" + "1".repeat(64))).toThrow(
      "immutable @sha256 digest",
    );
    expect(
      configuredRuntime("sha256:" + "1".repeat(64), { allowLocalImageId: true }).imageDigest,
    ).toBe("1".repeat(64));
  });

  it("checks a complete package inventory through one root-module replay", async () => {
    const job = temporary("lax-replay-job-");
    const workspaceBase = temporary("lax-replay-workspace-");
    const repositoryRoot = path.join(workspaceBase, "repository");
    const submissionRoot = path.join(repositoryRoot, "submission");
    fs.mkdirSync(submissionRoot, { recursive: true });
    const calls: ContainerInvocation[] = [];
    const runner = {
      run: async (invocation: ContainerInvocation) => {
        calls.push(invocation);
        return { code: 0, output: "", timedOut: false };
      },
    } as ContainerRunner;
    const inventory: ModuleInventory = {
      packageName: "Lax9",
      packageDir: path.join(submissionRoot, "concepts"),
      rootModule: "Lax9",
      modules: ["Lax9.A", "Lax9.Deep.B"],
      paths: new Map(),
    };

    await replayPackage(
      "concepts",
      { repositoryRoot, submissionRoot, manifests: { concepts: "{}", proofs: "{}" } },
      inventory,
      { concepts: [], proofs: [], all: [] },
      job,
      path.join(job, "missing-dependencies"),
      runner,
      DEFAULT_LIMITS,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      label: "replay-concepts",
      args: ["node", "/opt/lax-runtime/bin/run-check.mjs", "/out/plan.json"],
      env: { LEAN_NUM_THREADS: "2" },
    });
    const plan = JSON.parse(
      fs.readFileSync(path.join(job, "checks", "replay-concepts", "plan.json"), "utf8"),
    ) as { args: string[]; ownLibs: string[] };
    expect(plan.args).toEqual(["Lax9"]);
    expect(plan.ownLibs).toEqual([
      "/work/repository/submission/concepts/.lake/build/lib/lean",
    ]);
  });

  it("captures exactly the declared module artifacts and excludes build state from source", () => {
    const pristine = temporary("lax-capture-pristine-");
    const compiled = temporary("lax-capture-compiled-");
    const output = temporary("lax-capture-output-");
    writeFile(pristine, "concepts/lakefile.toml", "name = \"Lax9\"\n");
    writeFile(pristine, "concepts/Lax9.lean", "import Lax9.A\n");
    writeFile(pristine, "concepts/Lax9/A.lean", "def a := 1\n");
    writeFile(pristine, "concepts/.lake/ignored", "generated\n");
    writeFile(compiled, "concepts/.lake/build/lib/lean/Lax9.olean", "root artifact");
    writeFile(compiled, "concepts/.lake/build/lib/lean/Lax9/A.olean", "module artifact");
    const inventory: ModuleInventory = {
      packageName: "Lax9",
      packageDir: path.join(pristine, "concepts"),
      rootModule: "Lax9",
      modules: ["Lax9.A"],
      paths: new Map(),
    };

    capturePackage("concepts", pristine, compiled, "{\"packages\":[]}", inventory, output);

    expect(fs.existsSync(path.join(output, "concepts", "package", ".lake", "ignored"))).toBe(false);
    expect(fs.readFileSync(path.join(output, "concepts", "package", "Lax9", "A.lean"), "utf8")).toBe(
      "def a := 1\n",
    );
    expect(fs.readFileSync(path.join(output, "concepts", "lib", "Lax9.olean"), "utf8")).toBe(
      "root artifact",
    );
    expect(fs.readFileSync(path.join(output, "concepts", "lib", "Lax9", "A.olean"), "utf8")).toBe(
      "module artifact",
    );
  });

  it("refuses artifact links that could make host capture follow attacker paths", () => {
    const pristine = temporary("lax-link-pristine-");
    const compiled = temporary("lax-link-build-");
    const outside = temporary("lax-link-outside-");
    const library = path.join(compiled, "concepts", ".lake", "build", "lib", "lean");
    writeFile(pristine, "concepts/Lax9.lean", "");
    writeFile(outside, "secret", "host bytes");
    fs.mkdirSync(library, { recursive: true });
    fs.symlinkSync(path.join(outside, "secret"), path.join(library, "Lax9.olean"));
    const inventory: ModuleInventory = {
      packageName: "Lax9",
      packageDir: path.join(pristine, "concepts"),
      rootModule: "Lax9",
      modules: [],
      paths: new Map(),
    };

    expect(() => capturePackage(
      "concepts",
      pristine,
      compiled,
      "{\"packages\":[]}",
      inventory,
      temporary("lax-link-capture-"),
    )).toThrow("compiled artifact is missing or unsafe for module Lax9");
  });

  it("constructs hardened, explicit container invocations", async () => {
    const source = temporary("lax-container-mount-");
    const record = path.join(temporary("lax-container-bin-"), "arguments.txt");
    installDockerRecorder(record);
    const runner = new ContainerRunner(RUNTIME, DEFAULT_LIMITS);

    const result = await runner.run({
      label: "Static Check!",
      args: ["tool", "argument"],
      mounts: [{ source, target: "/input" }],
      workdir: "/input",
      env: { ZED: "last", ALPHA: "first" },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    expect(result.code).toBe(0);
    const args = fs.readFileSync(record, "utf8").trim().split("\n");
    expect(args).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--network=none",
      `--memory=${16 * 1024 * 1024 * 1024}`,
      "--workdir=/input",
      "--env",
      "ALPHA=first",
      "ZED=last",
      RUNTIME.image,
      "tool",
      "argument",
    ]));
    expect(args.find((argument) => argument.startsWith("type=bind"))).toContain(
      `src=${path.resolve(source)},dst=/input,readonly`,
    );
    await expect(
      runner.run({
        label: "bad-env",
        args: [],
        env: { lowercase: "no" },
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      }),
    ).rejects.toThrow("invalid container environment name");
  });
});

function installDockerRecorder(record: string): void {
  const directory = path.dirname(record);
  const executable = path.join(directory, "docker");
  fs.writeFileSync(
    executable,
    `#!/bin/sh
for argument in "$@"; do printf '%s\\n' "$argument"; done > "${record}"
exit 0
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
}
