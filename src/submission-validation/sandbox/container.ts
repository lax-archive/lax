import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_PATHS, type ValidationLimits } from "../config.js";
import type { ValidationRuntimeIdentity } from "../contracts.js";
import { notePeakMemory, type Profiler } from "../../shared/profile.js";
import { ensureRuntimeLayout, type RuntimeLayout } from "./layout.js";
import { assertWorkspaceWithinLimit } from "./workspace-limit.js";

export interface ContainerMount {
  source: string;
  target: string;
  writable?: boolean;
}

/** A digest-pinned image the runner may start containers from. */
export interface ContainerImage {
  /** The `name@sha256:…` reference docker pulls and runs. */
  image: string;
  imageDigest: string;
}

export interface ContainerInvocation {
  label: string;
  args: string[];
  mounts?: ContainerMount[];
  workdir?: string;
  network?: boolean;
  env?: Record<string, string>;
  /**
   * Run in this image instead of the Lean runtime image. Such a container
   * gets none of the Lean runtime mounts and keeps the image's own PATH —
   * the TeX Live image compiling a paper is the one user. The image must
   * have passed verifyImage() first.
   */
  image?: ContainerImage;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ContainerResult {
  code: number;
  output: string;
  timedOut: boolean;
}

/**
 * How the validation pipeline executes its sandboxed phase commands. The
 * trusted workflow and container-backed local builds use ContainerRunner;
 * tests inject in-process fakes through ValidationOptions.runner. The
 * invocation vocabulary stays container-shaped (mounts, container-absolute
 * paths) because the trusted path is the contract every fake must mimic.
 */
export interface ValidationRunner {
  run(invocation: ContainerInvocation): Promise<ContainerResult>;
  /** The Lean runtime: the stock image plus the VM-side mounts. */
  verifyRuntime(): Promise<void>;
  /** Make one more digest-pinned image available (pull on demand) and
   * assert its identity, so an invocation may name it. */
  verifyImage(image: ContainerImage): Promise<void>;
}

/**
 * Runs one phase in a fresh container from the pinned *stock* image, with the
 * VM-installed toolchain, warm mathlib workspace, and helper scripts
 * bind-mounted read-only at the stable RUNTIME_PATHS. The caller supplies an
 * explicit mount and environment allowlist on top; no host directory,
 * credential, socket, or ambient environment is inherited.
 */
export class ContainerRunner implements ValidationRunner {
  constructor(
    private readonly runtime: ValidationRuntimeIdentity,
    private readonly limits: ValidationLimits,
    private readonly workspaceRoot: string,
    private readonly profiler?: Profiler,
    /** Tests inject a fake layout; production resolves it in verifyRuntime. */
    private layout?: RuntimeLayout,
  ) {}

  /** Digests verifyImage has asserted, so run() can refuse an unverified image. */
  private readonly verifiedImages = new Set<string>();

  /** Time one container invocation, so the profile prices container startup. */
  private timed<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (this.profiler === undefined) return operation();
    return this.profiler.span(`container ${label}`, operation, { container: true });
  }

  /**
   * Make the Lean runtime available and assert its identity: the stock image
   * must carry the pinned digest, and the VM-side mount sources must exist
   * (sandbox/layout.ts fails with a pointer at the host setup when they
   * don't).
   */
  async verifyRuntime(): Promise<void> {
    await this.verifyImage(this.runtime);
    this.layout ??= await ensureRuntimeLayout();
  }

  /**
   * Pull an image when the local store lacks it and assert the pinned
   * identity: `docker pull ref@sha256:…` verifies the content
   * cryptographically, and the follow-up inspect asserts the local store
   * really holds that digest. Every image the runner ever starts — the Lean
   * runtime and the TeX Live image alike — passes through here first.
   */
  async verifyImage(image: ContainerImage): Promise<void> {
    const inspectImage = (): Promise<ProcessResult> => runProcess(
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image.image],
      60_000,
      64 * 1024,
    );
    let inspected = await this.timed("image-inspect", inspectImage);
    if (inspected.code !== 0) {
      const pull = await this.timed("image-pull", () => runProcess(
        "docker",
        ["pull", "--quiet", image.image],
        10 * 60_000,
        256 * 1024,
      ));
      if (pull.code !== 0) {
        throw new Error(`could not pull the pinned validation image: ${pull.output.trim()}`);
      }
      inspected = await this.timed("image-inspect", inspectImage);
      if (inspected.code !== 0) {
        throw new Error(`validation image is unavailable after pull: ${inspected.output.trim()}`);
      }
    }
    let repoDigests: unknown;
    try {
      repoDigests = JSON.parse(inspected.output);
    } catch {
      throw new Error("docker image inspect did not report the image digests");
    }
    if (
      !Array.isArray(repoDigests) ||
      !repoDigests.some(
        (digest) =>
          typeof digest === "string" && digest.endsWith(`@sha256:${image.imageDigest}`),
      )
    ) {
      throw new Error("validation image does not carry the pinned digest");
    }
    this.verifiedImages.add(image.imageDigest);
  }

  /** The read-only mounts that stand in for the deleted custom image's baked
   * filesystem — added to every invocation, exactly as the image contents
   * used to be present in every container. */
  private runtimeMounts(layout: RuntimeLayout): ContainerMount[] {
    return [
      { source: layout.toolchainDir, target: RUNTIME_PATHS.toolchain },
      { source: layout.warmDir, target: RUNTIME_PATHS.warmWorkspace },
      { source: layout.toolsDir, target: RUNTIME_PATHS.tools },
      { source: path.dirname(layout.inspectorBin), target: RUNTIME_PATHS.inspectorDir },
    ];
  }

  async run(invocation: ContainerInvocation): Promise<ContainerResult> {
    const layout = this.layout;
    let runtimeMounts: ContainerMount[];
    if (invocation.image !== undefined) {
      // A foreign image stands alone: nothing of the Lean runtime is mounted
      // into it, and it must have been pulled and identity-checked first.
      if (!this.verifiedImages.has(invocation.image.imageDigest)) {
        throw new Error(`container image ${invocation.image.image} is unverified; verifyImage() must succeed first`);
      }
      runtimeMounts = [];
    } else {
      if (layout === undefined) {
        throw new Error("validation runtime layout is unavailable; verifyRuntime() must succeed first");
      }
      runtimeMounts = this.runtimeMounts(layout);
    }
    assertWorkspaceWithinLimit(this.workspaceRoot, this.limits);
    const name = `lax-validation-${safeLabel(invocation.label)}-${randomUUID().slice(0, 12)}`;
    const args = [
      "run",
      "--rm",
      `--name=${name}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--network=${invocation.network === true ? "bridge" : "none"}`,
      `--memory=${this.limits.memoryBytes}`,
      `--cpus=${this.limits.cpuCount}`,
      `--pids-limit=${this.limits.pids}`,
      "--tmpfs=/tmp:rw,nosuid,nodev,size=1073741824",
    ];
    if (process.getuid !== undefined && process.getgid !== undefined) {
      args.push(`--user=${process.getuid()}:${process.getgid()}`);
    }
    for (const mount of [...runtimeMounts, ...(invocation.mounts ?? [])]) {
      const source = path.resolve(mount.source);
      if (!fs.existsSync(source)) throw new Error(`container mount does not exist: ${source}`);
      if (!path.isAbsolute(mount.target)) throw new Error("container mount targets must be absolute");
      assertMountField(source, "source");
      assertMountField(mount.target, "target");
      args.push(
        "--mount",
        `type=bind,src=${source},dst=${mount.target}${mount.writable === true ? "" : ",readonly"}`,
      );
    }
    if (invocation.workdir !== undefined) args.push(`--workdir=${invocation.workdir}`);
    // The runner owns PATH — invocations cannot set it. In the Lean runtime
    // commands resolve through the mounted toolchain first; the stock image
    // itself only contributes node, tar, and the base system. A foreign image
    // has no mounted toolchain, so its own PATH (TeX Live's bin directory,
    // baked into the image) stands.
    if (invocation.env !== undefined && "PATH" in invocation.env) {
      throw new Error("container invocations cannot set PATH");
    }
    const environment = {
      ...invocation.env,
      ...(invocation.image === undefined
        ? { PATH: `${RUNTIME_PATHS.leanBin}:/usr/local/bin:/usr/bin:/bin` }
        : {}),
    };
    for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(`invalid container environment name: ${key}`);
      args.push("--env", `${key}=${value}`);
    }
    args.push((invocation.image ?? this.runtime).image, ...invocation.args);
    const result = await this.timed(invocation.label, async () => {
      // Peak-memory profiling of the container's cgroup, attributed to the
      // span `timed` just opened on this task. Started only when profiling
      // at all; diagnostics, never part of the sandbox boundary.
      const stopMemoryMonitor =
        this.profiler === undefined ? undefined : startContainerMemoryMonitor(name);
      try {
        return await runProcess(
          "docker",
          args,
          invocation.timeoutMs,
          invocation.maxOutputBytes,
          () => assertWorkspaceWithinLimit(this.workspaceRoot, this.limits),
        );
      } finally {
        stopMemoryMonitor?.();
      }
    });
    if (result.timedOut || result.terminationError !== undefined) {
      await runProcess("docker", ["rm", "--force", name], 10_000, 64 * 1024).catch(() => undefined);
    }
    if (result.terminationError !== undefined) throw result.terminationError;
    return result;
  }
}

const MEMORY_POLL_INTERVAL_MS = 500;

/**
 * The host-side cgroup v2 file recording the container's peak memory use,
 * derived from the container init's /proc/<pid>/cgroup ("0::<path>", the
 * unified hierarchy). Works under both the systemd and cgroupfs drivers —
 * the kernel reports the real path either way, even when the container has
 * a private cgroup namespace, because the host reads it from the root
 * namespace. A cgroup-v1-only host yields undefined and the profile simply
 * carries no memory number.
 */
export function cgroupMemoryPeakPath(procCgroup: string): string | undefined {
  for (const line of procCgroup.split("\n")) {
    const match = /^0::(\/.*)$/u.exec(line.trim());
    if (match !== null) return path.join("/sys/fs/cgroup", match[1]!, "memory.peak");
  }
  return undefined;
}

/**
 * Best-effort peak-memory monitor for one container run: resolve the
 * container's cgroup through its init pid (docker inspect), then poll the
 * cgroup's kernel-maintained `memory.peak` — a monotonic high-water mark
 * covering everything the `--memory` cap is enforced against, so the last
 * successful read before the container exits is the run's peak (modulo the
 * final poll interval). Every step may fail (container not started yet,
 * already reaped by `--rm`, cgroup v1 host); each failure just means no
 * number — profiling never fails a validation. Returns the stop function.
 */
function startContainerMemoryMonitor(containerName: string): () => void {
  let peakFile: string | undefined;
  let resolving = false;
  const timer = setInterval(() => {
    if (peakFile === undefined) {
      if (resolving) return;
      resolving = true;
      void resolveCgroupPeakFile(containerName)
        .then((file) => {
          peakFile = file;
        })
        .catch(() => undefined)
        .finally(() => {
          resolving = false;
        });
      return;
    }
    try {
      notePeakMemory(Number(fs.readFileSync(peakFile, "utf8").trim()));
    } catch {
      // The container is gone; whatever was read last stands as the peak.
    }
  }, MEMORY_POLL_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function resolveCgroupPeakFile(containerName: string): Promise<string | undefined> {
  const inspected = await runProcess(
    "docker",
    ["inspect", "--format", "{{.State.Pid}}", containerName],
    10_000,
    16 * 1024,
  );
  if (inspected.code !== 0) return undefined;
  const pid = Number(inspected.output.trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return cgroupMemoryPeakPath(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"));
}

interface ProcessResult extends ContainerResult {
  terminationError?: Error;
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  healthCheck?: () => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    if (process.env.DOCKER_HOST !== undefined) environment.DOCKER_HOST = process.env.DOCKER_HOST;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let terminationError: Error | undefined;
    const collect = (chunk: Buffer): void => {
      if (bytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - bytes;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const healthTimer = healthCheck === undefined
      ? undefined
      : setInterval(() => {
          if (timedOut || terminationError !== undefined) return;
          try {
            healthCheck();
          } catch (error) {
            terminationError = error instanceof Error ? error : new Error(String(error));
            child.kill("SIGKILL");
          }
        }, 250);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (healthTimer !== undefined) clearInterval(healthTimer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (healthTimer !== undefined) clearInterval(healthTimer);
      const suffix = truncated ? "\n[output truncated by lax]\n" : "";
      resolve({
        code: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8") + suffix,
        timedOut,
        ...(terminationError === undefined ? {} : { terminationError }),
      });
    });
  });
}

function safeLabel(value: string): string {
  const label = value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return label.slice(0, 30) || "phase";
}

/**
 * Docker parses --mount as a comma-delimited key/value string. A comma in a
 * bind path can therefore introduce another src/dst option. Control bytes are
 * forbidden as well so every field reaches Docker in one unambiguous form.
 */
function assertMountField(value: string, label: "source" | "target"): void {
  if (/[,\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`container mount ${label} contains a Docker option delimiter or control character`);
  }
}
