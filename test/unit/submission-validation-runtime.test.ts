import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturePackage } from "../../src/submission-validation/captures/seal.js";
import { configuredRuntime, DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import type { ModuleInventory } from "../../src/submission-validation/contracts.js";
import { compileConcepts } from "../../src/submission-validation/phases/compile.js";
import { provisionWorkspace } from "../../src/submission-validation/phases/provision.js";
import { replayPackage } from "../../src/submission-validation/phases/replay.js";
import { VALIDATION_IMAGE, VALIDATION_IMAGE_DIGEST } from "../../src/submission-validation/pins.js";
import {
  ContainerRunner,
  type ContainerInvocation,
  type ValidationRunner,
} from "../../src/submission-validation/sandbox/container.js";
import type { RuntimeLayout } from "../../src/submission-validation/sandbox/layout.js";
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

/** A fake VM-side runtime layout over temp dirs, for direct ContainerRunner
 * construction (production resolves the real one in verifyRuntime). */
function fakeLayout(): RuntimeLayout {
  const base = temporary("lax-layout-");
  const layout = {
    toolchainDir: path.join(base, "toolchain"),
    warmDir: path.join(base, "warm"),
    toolsDir: path.join(base, "tools"),
    inspectorBin: path.join(base, "inspector", "laxinspector"),
  };
  fs.mkdirSync(layout.toolchainDir, { recursive: true });
  fs.mkdirSync(layout.warmDir, { recursive: true });
  fs.mkdirSync(layout.toolsDir, { recursive: true });
  fs.mkdirSync(path.dirname(layout.inspectorBin), { recursive: true });
  fs.writeFileSync(layout.inspectorBin, "");
  return layout;
}

describe("validation runtime boundaries retained from main", () => {
  it("pins the stock runtime image and keeps any override digest-pinned", () => {
    // no environment requirement: the identity comes from the reviewed pins
    expect(configuredRuntime(undefined)).toMatchObject({
      image: VALIDATION_IMAGE,
      imageDigest: VALIDATION_IMAGE_DIGEST,
    });
    expect(VALIDATION_IMAGE).toMatch(/^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/u);
    // the narrow smoke/testing override must itself be digest-pinned
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
  });

  it("keeps the in-sandbox check runner fail-closed on the Lean worker bound", () => {
    // the `--clearenv` OOM lesson (history/oom.md): the check runner refuses
    // to start without an explicit LEAN_NUM_THREADS, and never invents one
    const checkRunner = fs.readFileSync(
      new URL("../../src/submission-validation/sandbox/tools/run-check.mjs", import.meta.url),
      "utf8",
    );
    expect(checkRunner).toContain("const leanNumThreads = process.env.LEAN_NUM_THREADS");
    expect(checkRunner).toContain("LEAN_NUM_THREADS: leanNumThreads");
    expect(checkRunner).not.toContain('LEAN_NUM_THREADS: "4"');
    // replay/inspect run at the measured 2-thread budget (red-team addendum)
    expect(DEFAULT_LIMITS.leanThreads).toBe(2);
  });

  it("checks a complete package inventory through one root-module replay", async () => {
    const job = temporary("lax-replay-job-");
    const captureRoot = temporary("lax-replay-capture-");
    writeFile(captureRoot, "concepts/package/lakefile.toml", "name = \"Lax9\"\n");
    writeFile(captureRoot, "concepts/lib/Lax9.olean", "root artifact");
    const calls: ContainerInvocation[] = [];
    const runner: ValidationRunner = {
      run: async (invocation: ContainerInvocation) => {
        calls.push(invocation);
        return { code: 0, output: "", timedOut: false };
      },
      verifyRuntime: async () => {},
      verifyImage: async () => {},
    };
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
      args: ["node", "/opt/lax/bin/run-check.mjs", "/out/plan.json"],
      env: { LEAN_NUM_THREADS: "2" },
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
    const runner: ValidationRunner = {
      run: async (invocation: ContainerInvocation) => {
        calls.push(invocation);
        const sourceMount = invocation.mounts!.find((mount) => mount.target === "/source")!;
        if (sourceMount.writable === true) fs.writeFileSync(source, "def archived := false\n");
        writeFile(buildRoot, "build/lib/lean/Lax9.olean", "compiled artifact");
        return { code: 0, output: "", timedOut: false };
      },
      verifyRuntime: async () => {},
      verifyImage: async () => {},
    };

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

  it("moves provisioned Lake state outside the read-only source tree", () => {
    const sourceRoot = makeSubmission("lax-9");
    const job = temporary("lax-provision-job-");
    const warm = temporary("lax-provision-warm-");
    writeFile(
      warm,
      "lake-manifest.json",
      JSON.stringify({
        version: "1.2.0",
        packages: [{ type: "git", name: "mathlib", inherited: false, scope: "" }],
      }),
    );

    const workspace = provisionWorkspace(
      "concepts",
      { repositoryRoot: sourceRoot, submissionRoot: sourceRoot },
      ".",
      staticResult("lax-9"),
      { concepts: [], proofs: [], all: [] },
      job,
      warm,
    );

    const conceptMount = workspace.buildMounts.concepts[0]!;
    expect(conceptMount).toMatchObject({ target: "/source/concepts/.lake", writable: true });
    expect(conceptMount.source.startsWith(workspace.repositoryRoot + path.sep)).toBe(false);
    expect(fs.readdirSync(path.join(workspace.repositoryRoot, "concepts", ".lake"))).toEqual([]);
    // the host-seeded overrides moved out with the build state and point the
    // warm packages at the sandbox's read-only warm mount
    const overrides = JSON.parse(
      fs.readFileSync(path.join(conceptMount.source, "package-overrides.json"), "utf8"),
    ) as { packages: Array<{ type: string; name: string; dir: string }> };
    expect(overrides.packages).toEqual([
      expect.objectContaining({
        type: "path",
        name: "mathlib",
        dir: "/opt/lax/warm/.lake/packages/mathlib",
      }),
    ]);
    // the seeded manifest keeps the warm entries verbatim and adds the proof
    // package's own concept path dependency
    const conceptManifest = JSON.parse(workspace.manifests.concepts) as { packages: unknown[] };
    expect(conceptManifest.packages).toContainEqual(expect.objectContaining({ name: "mathlib" }));
    const proofManifest = JSON.parse(workspace.manifests.proofs) as { packages: unknown[] };
    expect(proofManifest.packages).toContainEqual(
      expect.objectContaining({ type: "path", name: "Lax9", dir: "../concepts" }),
    );
    expect(workspace.buildMounts.proofs).toContainEqual(conceptMount);
    expect(workspace.buildMounts.proofs.filter(
      (mount) => mount.target.startsWith(`${conceptMount.target}/`),
    )).toEqual([]);
  });

  it("captures exactly the declared module artifacts and excludes build state from source", () => {
    const pristine = temporary("lax-capture-pristine-");
    const compiled = temporary("lax-capture-compiled-");
    const output = temporary("lax-capture-output-");
    writeFile(pristine, "concepts/lakefile.toml", "name = \"Lax9\"\n");
    writeFile(pristine, "concepts/Lax9.lean", "import Lax9.A\n");
    writeFile(pristine, "concepts/Lax9/A.lean", "def a := 1\n");
    writeFile(pristine, "concepts/README.md", "package notes\n");
    writeFile(pristine, "concepts/Lax9/data.json", "{}\n");
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
    expect(fs.existsSync(path.join(output, "concepts", "package", "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(output, "concepts", "package", "Lax9", "data.json"))).toBe(false);
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
    const compiledRoot = temporary("lax-shadow-build-");
    const compiledLibrary = path.join(compiledRoot, "concepts", ".lake", "build", "lib", "lean");
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
    const runner: ValidationRunner = {
      run: async (invocation: ContainerInvocation) => {
        calls.push(invocation);
        return { code: 0, output: "", timedOut: false };
      },
      verifyRuntime: async () => {},
      verifyImage: async () => {},
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

    const plan = JSON.parse(
      fs.readFileSync(path.join(job, "checks", "replay-concepts", "plan.json"), "utf8"),
    ) as { ownLibs: string[] };
    expect(plan.ownLibs).toEqual(["/capture/concepts/lib"]);
    expect(calls[0]!.mounts!.some((mount) => mount.source === compiledLibrary)).toBe(false);
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
      library,
      "{\"packages\":[]}",
      inventory,
      temporary("lax-link-capture-"),
    )).toThrow("compiled artifact is missing or unsafe for module Lax9");
  });

  it("names every module whose compiled artifact is missing and the likely cause", () => {
    // The container path deliberately has no self-heal, so the throw is the
    // whole diagnosis: it has to name the modules and the rule they broke.
    const pristine = temporary("lax-missing-pristine-");
    const compiled = temporary("lax-missing-build-");
    const library = path.join(compiled, "concepts", ".lake", "build", "lib", "lean");
    writeFile(pristine, "concepts/Lax9.lean", "import Lax9.A\n");
    writeFile(pristine, "concepts/Lax9/A.lean", "def a := 1\n");
    writeFile(pristine, "concepts/Lax9/B.lean", "def b := 2\n");
    writeFile(library, "Lax9.olean", "root artifact");
    const inventory: ModuleInventory = {
      packageName: "Lax9",
      packageDir: path.join(pristine, "concepts"),
      rootModule: "Lax9",
      modules: ["Lax9.A", "Lax9.B"],
      paths: new Map(),
    };
    const captureRoot = temporary("lax-missing-capture-");

    expect(() => capturePackage(
      "concepts",
      pristine,
      library,
      "{\"packages\":[]}",
      inventory,
      captureRoot,
    )).toThrow(
      "compiled artifact is missing or unsafe for modules Lax9.A, Lax9.B of package Lax9; " +
        "root module Lax9 must import exactly the other modules of its package, so a module " +
        "outside the root's import closure is never built",
    );
    // the whole inventory is diagnosed before anything is copied
    expect(fs.existsSync(path.join(captureRoot, "concepts", "lib"))).toBe(false);
  });

  it("constructs hardened, explicit container invocations", async () => {
    const source = temporary("lax-container-mount-");
    const record = path.join(temporary("lax-container-bin-"), "arguments.txt");
    installDockerRecorder(record);
    const layout = fakeLayout();
    const runner = new ContainerRunner(
      RUNTIME,
      { ...DEFAULT_LIMITS, minFreeDiskBytes: 0 },
      source,
      undefined,
      layout,
    );

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
      // the runner owns PATH: commands resolve through the mounted toolchain
      "PATH=/opt/lax/toolchain/bin:/usr/local/bin:/usr/bin:/bin",
      "ZED=last",
      RUNTIME.image,
      "tool",
      "argument",
    ]));
    // the VM-installed runtime is mounted read-only at its stable paths
    const binds = args.filter((argument) => argument.startsWith("type=bind"));
    expect(binds).toEqual(expect.arrayContaining([
      `type=bind,src=${path.resolve(layout.toolchainDir)},dst=/opt/lax/toolchain,readonly`,
      `type=bind,src=${path.resolve(layout.warmDir)},dst=/opt/lax/warm,readonly`,
      `type=bind,src=${path.resolve(layout.toolsDir)},dst=/opt/lax/bin,readonly`,
      `type=bind,src=${path.resolve(path.dirname(layout.inspectorBin))},dst=/opt/lax/inspector,readonly`,
      `type=bind,src=${path.resolve(source)},dst=/input,readonly`,
    ]));
    await expect(
      runner.run({
        label: "bad-env",
        args: [],
        env: { lowercase: "no" },
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      }),
    ).rejects.toThrow("invalid container environment name");

    const injectedSource = path.join(source, "package,src=elsewhere");
    fs.mkdirSync(injectedSource, { recursive: true });
    await expect(
      runner.run({
        label: "bad-mount-source",
        args: [],
        mounts: [{ source: injectedSource, target: "/input" }],
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      }),
    ).rejects.toThrow("container mount source contains a Docker option delimiter");
    await expect(
      runner.run({
        label: "bad-mount-target",
        args: [],
        mounts: [{ source, target: "/input,dst=/host" }],
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      }),
    ).rejects.toThrow("container mount target contains a Docker option delimiter");
  });

  it("runs a foreign image bare: verified first, no Lean mounts, the image's own PATH", async () => {
    const source = temporary("lax-container-paper-");
    const record = path.join(temporary("lax-container-bin-"), "arguments.txt");
    const texImage = { image: `texlive/texlive:TL2025-historic@sha256:${"7".repeat(64)}`, imageDigest: "7".repeat(64) };
    installDockerRecorder(record, { repoDigests: [`texlive/texlive@sha256:${"7".repeat(64)}`] });
    const runner = new ContainerRunner(RUNTIME, DEFAULT_LIMITS, source, undefined, fakeLayout());
    const invocation: ContainerInvocation = {
      label: "paper-compile",
      image: texImage,
      args: ["latexmk", "-pdf", "main.tex"],
      mounts: [{ source, target: "/paper", writable: true }],
      workdir: "/paper",
      env: { HOME: "/tmp" },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    };
    // Unverified images never start, whatever the Lean runtime's state.
    await expect(runner.run(invocation)).rejects.toThrow("verifyImage");
    // A foreign image needs no Lean runtime layout, only its own verification.
    await runner.verifyImage(texImage);
    // A wrong digest is refused even after a successful pull.
    await expect(runner.verifyImage({ ...texImage, imageDigest: "8".repeat(64) }))
      .rejects.toThrow("does not carry the pinned digest");

    expect((await runner.run(invocation)).code).toBe(0);
    const args = fs.readFileSync(record, "utf8").trim().split("\n");
    expect(args).toEqual(expect.arrayContaining([
      "run", "--read-only", "--cap-drop=ALL", "--network=none", "--workdir=/paper", "--env", "HOME=/tmp",
      texImage.image, "latexmk", "-pdf", "main.tex",
    ]));
    expect(args).not.toContain(RUNTIME.image);
    expect(args.some((argument) => argument.startsWith("PATH="))).toBe(false);
    const binds = args.filter((argument) => argument.startsWith("type=bind"));
    expect(binds).toEqual([`type=bind,src=${path.resolve(source)},dst=/paper`]);
    // The runner owns PATH in every image.
    await expect(runner.run({ ...invocation, env: { PATH: "/evil" } })).rejects.toThrow("cannot set PATH");
  });

  it("refuses to run before the runtime layout is verified", async () => {
    const runner = new ContainerRunner(RUNTIME, DEFAULT_LIMITS, temporary("lax-unverified-"));
    await expect(
      runner.run({ label: "early", args: [], timeoutMs: 1_000, maxOutputBytes: 1_000 }),
    ).rejects.toThrow("verifyRuntime");
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
      maxWorkspaceBytes: Number.MAX_SAFE_INTEGER,
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
      undefined,
      fakeLayout(),
    );

    await expect(runner.run({
      label: "workspace-growth",
      args: ["grow"],
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    })).rejects.toThrow("validation workspace exceeds");
  });
});

/** A docker that records the arguments of every `run` and, when told which
 * digests the local store holds, answers `image inspect` with them. */
function installDockerRecorder(record: string, options: { repoDigests?: string[] } = {}): void {
  const directory = path.dirname(record);
  const executable = path.join(directory, "docker");
  const inspect = options.repoDigests === undefined
    ? ""
    : `if [ "$1" = "image" ]; then printf '%s\\n' '${JSON.stringify(options.repoDigests)}'; exit 0; fi\n`;
  fs.writeFileSync(
    executable,
    `#!/bin/sh
${inspect}for argument in "$@"; do printf '%s\\n' "$argument"; done > "${record}"
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
