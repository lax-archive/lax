import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturePackage } from "../../src/submission-validation/captures/seal.js";
import { configuredRuntime, DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import type { ModuleInventory } from "../../src/submission-validation/contracts.js";
import { compileConcepts } from "../../src/submission-validation/phases/compile.js";
import { provisionWorkspace } from "../../src/submission-validation/phases/provision.js";
import { replayPackage } from "../../src/submission-validation/phases/replay.js";
import { ContainerRunner, type ContainerInvocation } from "../../src/submission-validation/sandbox/container.js";
import { assertWorkspaceWithinLimit } from "../../src/submission-validation/sandbox/workspace-limit.js";
import {
  cleanupTemporary,
  makeSubmission,
  RUNTIME,
  staticResult,
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
    const captureRoot = temporary("lax-replay-capture-");
    writeFile(captureRoot, "concepts/package/lakefile.toml", "name = \"Lax9\"\n");
    writeFile(captureRoot, "concepts/lib/Lax9.olean", "root artifact");
    const calls: ContainerInvocation[] = [];
    const runner = {
      run: async (invocation: ContainerInvocation) => {
        calls.push(invocation);
        return { code: 0, output: "", timedOut: false };
      },
    } as ContainerRunner;
    const inventory: ModuleInventory = {
      packageName: "Lax9",
      packageDir: "concepts",
      rootModule: "Lax9",
      modules: ["Lax9.A", "Lax9.Deep.B"],
      paths: new Map(),
    };

    await replayPackage(
      "concepts",
      captureRoot,
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
    });
    const plan = JSON.parse(
      fs.readFileSync(path.join(job, "checks", "replay-concepts", "plan.json"), "utf8"),
    ) as { args: string[]; ownLibs: string[] };
    expect(plan.args).toEqual(["Lax9"]);
    expect(plan.ownLibs).toEqual(["/capture/concepts/lib"]);
    expect(calls[0]!.mounts).toContainEqual({ source: captureRoot, target: "/capture" });
  });

  it("blocks source-mutation attacks while keeping isolated build state writable", async () => {
    const repositoryRoot = temporary("lax-compile-source-");
    const buildRoot = temporary("lax-compile-build-");
    const source = path.join(repositoryRoot, "concepts", "Lax9.lean");
    writeFile(repositoryRoot, "concepts/Lax9.lean", "def archived := true\n");
    const calls: ContainerInvocation[] = [];
    const runner = {
      run: async (invocation: ContainerInvocation) => {
        calls.push(invocation);
        const sourceMount = invocation.mounts!.find((mount) => mount.target === "/source")!;
        if (sourceMount.writable === true) fs.writeFileSync(source, "def archived := false\n");
        writeFile(buildRoot, "build/lib/lean/Lax9.olean", "compiled artifact");
        return { code: 0, output: "", timedOut: false };
      },
    } as ContainerRunner;

    await compileConcepts({
      repositoryRoot,
      submissionRoot: repositoryRoot,
      containerSubmissionRoot: "/source",
      manifests: { concepts: "{}", proofs: "{}" },
      libraries: {
        concepts: path.join(buildRoot, "build", "lib", "lean"),
        proofs: path.join(buildRoot, "proofs", "build", "lib", "lean"),
      },
      buildMounts: {
        concepts: [{ source: buildRoot, target: "/source/concepts/.lake", writable: true }],
        proofs: [],
      },
    }, path.join(repositoryRoot, "missing-dependencies"), runner, DEFAULT_LIMITS);

    expect(fs.readFileSync(source, "utf8")).toBe("def archived := true\n");
    expect(calls[0]!.mounts).toEqual(expect.arrayContaining([
      { source: repositoryRoot, target: "/source" },
      { source: buildRoot, target: "/source/concepts/.lake", writable: true },
    ]));
    expect(calls[0]!.mounts!
      .filter((mount) => mount.writable === true)
      .every((mount) => !mount.source.startsWith(repositoryRoot + path.sep))).toBe(true);
  });

  it("moves provisioned Lake state outside the read-only source tree", async () => {
    const sourceRoot = makeSubmission("lax-9");
    const job = temporary("lax-provision-job-");
    const runner = {
      run: async () => {
        const repository = path.join(job, "workspaces", "concepts", "repository");
        for (const kind of ["concepts", "proofs"] as const) {
          writeFile(repository, `${kind}/lake-manifest.json`, "{\"packages\":[]}\n");
          writeFile(repository, `${kind}/.lake/packages/warm-marker`, "trusted\n");
        }
        return { code: 0, output: "", timedOut: false };
      },
    } as ContainerRunner;

    const workspace = await provisionWorkspace(
      "concepts",
      { repositoryRoot: sourceRoot, submissionRoot: sourceRoot },
      ".",
      staticResult("lax-9"),
      { concepts: [], proofs: [], all: [] },
      { concepts: [], proofs: [], closure: new Map() },
      job,
      path.join(job, "missing-dependencies"),
      runner,
      DEFAULT_LIMITS,
    );

    const conceptMount = workspace.buildMounts.concepts[0]!;
    expect(conceptMount).toMatchObject({ target: "/source/concepts/.lake", writable: true });
    expect(conceptMount.source.startsWith(workspace.repositoryRoot + path.sep)).toBe(false);
    expect(fs.readdirSync(path.join(workspace.repositoryRoot, "concepts", ".lake"))).toEqual([]);
    expect(fs.readFileSync(path.join(conceptMount.source, "packages", "warm-marker"), "utf8"))
      .toBe("trusted\n");
    expect(workspace.buildMounts.proofs.at(-1)).toEqual({
      source: workspace.libraries.concepts,
      target: "/source/concepts/.lake/build/lib/lean",
    });
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

    capturePackage(
      "concepts",
      pristine,
      path.join(compiled, "concepts", ".lake", "build", "lib", "lean"),
      "{\"packages\":[]}",
      inventory,
      output,
    );

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

  it("excludes generated module shadows and replays only the inventoried capture", async () => {
    const pristine = temporary("lax-shadow-pristine-");
    const compiledLibrary = temporary("lax-shadow-build-");
    const captureRoot = temporary("lax-shadow-capture-");
    const job = temporary("lax-shadow-job-");
    writeFile(pristine, "concepts/Lax9.lean", "import Mathlib.Data.Nat.Basic\n");
    writeFile(compiledLibrary, "Lax9.olean", "root artifact");
    writeFile(compiledLibrary, "Lax9/Generated.olean", "generated package module");
    writeFile(compiledLibrary, "Mathlib/Data/Nat/Basic.olean", "attacker shadow");
    const inventory: ModuleInventory = {
      packageName: "Lax9",
      packageDir: path.join(pristine, "concepts"),
      rootModule: "Lax9",
      modules: [],
      paths: new Map(),
    };
    capturePackage("concepts", pristine, compiledLibrary, "{\"packages\":[]}", inventory, captureRoot);
    expect(fs.existsSync(path.join(captureRoot, "concepts", "lib", "Mathlib"))).toBe(false);
    expect(fs.existsSync(path.join(captureRoot, "concepts", "lib", "Lax9", "Generated.olean"))).toBe(false);
    const calls: ContainerInvocation[] = [];
    const runner = {
      run: async (invocation: ContainerInvocation) => {
        calls.push(invocation);
        return { code: 0, output: "", timedOut: false };
      },
    } as ContainerRunner;

    await replayPackage(
      "concepts",
      captureRoot,
      inventory,
      { concepts: [], proofs: [], all: [] },
      job,
      path.join(job, "missing-dependencies"),
      runner,
      DEFAULT_LIMITS,
    );

    const plan = JSON.parse(
      fs.readFileSync(path.join(job, "checks", "replay-concepts", "plan.json"), "utf8"),
    ) as { ownLibs: string[] };
    expect(plan.ownLibs).toEqual(["/capture/concepts/lib"]);
    expect(calls[0]!.mounts!.some((mount) => mount.source === compiledLibrary)).toBe(false);
  });

  it("constructs hardened, explicit container invocations", async () => {
    const source = temporary("lax-container-mount-");
    const record = path.join(temporary("lax-container-bin-"), "arguments.txt");
    installDockerRecorder(record);
    const runner = new ContainerRunner(RUNTIME, DEFAULT_LIMITS, source);

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

  it("bounds aggregate workspace bytes and filesystem entries", () => {
    const workspace = temporary("lax-workspace-limit-");
    writeFile(workspace, "one", "123456");
    writeFile(workspace, "nested/two", "abcdef");

    expect(() => assertWorkspaceWithinLimit(workspace, {
      maxWorkspaceBytes: 10,
      maxWorkspaceEntries: 100,
      minFreeDiskBytes: 0,
    })).toThrow("validation workspace exceeds");
    expect(() => assertWorkspaceWithinLimit(workspace, {
      maxWorkspaceBytes: 1_000,
      maxWorkspaceEntries: 2,
      minFreeDiskBytes: 0,
    })).toThrow("validation workspace contains more than 2 entries");
  });

  it("terminates a running container when it exhausts the workspace budget", async () => {
    const workspace = temporary("lax-workspace-watch-");
    const executableRoot = temporary("lax-container-growth-bin-");
    installWorkspaceGrowingDocker(executableRoot, workspace);
    const runner = new ContainerRunner(
      RUNTIME,
      { ...DEFAULT_LIMITS, maxWorkspaceBytes: 1_024, maxWorkspaceEntries: 100 },
      workspace,
    );

    await expect(runner.run({
      label: "workspace-growth",
      args: ["grow"],
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    })).rejects.toThrow("validation workspace exceeds");
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

function installWorkspaceGrowingDocker(directory: string, workspace: string): void {
  const executable = path.join(directory, "docker");
  fs.writeFileSync(
    executable,
    `#!/bin/sh
if [ "$1" = "run" ]; then
  dd if=/dev/zero of="${path.join(workspace, "growth.bin")}" bs=2048 count=1 2>/dev/null
  while :; do :; done
fi
exit 0
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
}
