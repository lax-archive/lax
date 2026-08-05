import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_PATHS, type ValidationLimits } from "../config.js";
import type { ValidationRuntimeIdentity } from "../contracts.js";
import type { Profiler } from "../../shared/profile.js";
import { ensureRuntimeLayout, type RuntimeLayout } from "./layout.js";
import { assertWorkspaceWithinLimit } from "./workspace-limit.js";

export interface ContainerMount {
  source: string;
  target: string;
  writable?: boolean;
}

export interface ContainerInvocation {
  label: string;
  args: string[];
  mounts?: ContainerMount[];
  workdir?: string;
  network?: boolean;
  env?: Record<string, string>;
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
  verifyRuntime(): Promise<void>;
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

  /** Time one container invocation, so the profile prices container startup. */
  private timed<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (this.profiler === undefined) return operation();
    return this.profiler.span(`container ${label}`, operation, { container: true });
  }

  /**
   * Make the runtime available and assert its identity: the stock image must
   * carry the pinned digest (`docker pull ref@sha256:…` verifies the content
   * cryptographically; the follow-up inspect asserts the local store really
   * holds that digest), and the VM-side mount sources must exist
   * (sandbox/layout.ts fails with a pointer at the host setup when they
   * don't).
   */
  async verifyRuntime(): Promise<void> {
    const inspectImage = (): Promise<ProcessResult> => runProcess(
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", this.runtime.image],
      60_000,
      64 * 1024,
    );
    let inspected = await this.timed("image-inspect", inspectImage);
    if (inspected.code !== 0) {
      const pull = await this.timed("image-pull", () => runProcess(
        "docker",
        ["pull", "--quiet", this.runtime.image],
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
          typeof digest === "string" && digest.endsWith(`@sha256:${this.runtime.imageDigest}`),
      )
    ) {
      throw new Error("validation image does not carry the pinned digest");
    }
    this.layout ??= await ensureRuntimeLayout();
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
    if (layout === undefined) {
      throw new Error("validation runtime layout is unavailable; verifyRuntime() must succeed first");
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
    for (const mount of [...this.runtimeMounts(layout), ...(invocation.mounts ?? [])]) {
      const source = path.resolve(mount.source);
      if (!fs.existsSync(source)) throw new Error(`container mount does not exist: ${source}`);
      if (!path.isAbsolute(mount.target)) throw new Error("container mount targets must be absolute");
      args.push(
        "--mount",
        `type=bind,src=${source},dst=${mount.target}${mount.writable === true ? "" : ",readonly"}`,
      );
    }
    if (invocation.workdir !== undefined) args.push(`--workdir=${invocation.workdir}`);
    // Commands resolve through the mounted toolchain first; the stock image
    // itself only contributes node, tar, and the base system. The runner owns
    // PATH — invocations cannot override it.
    const environment = {
      ...invocation.env,
      PATH: `${RUNTIME_PATHS.leanBin}:/usr/local/bin:/usr/bin:/bin`,
    };
    for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(`invalid container environment name: ${key}`);
      args.push("--env", `${key}=${value}`);
    }
    args.push(this.runtime.image, ...invocation.args);
    const result = await this.timed(invocation.label, () => runProcess(
      "docker",
      args,
      invocation.timeoutMs,
      invocation.maxOutputBytes,
      () => assertWorkspaceWithinLimit(this.workspaceRoot, this.limits),
    ));
    if (result.timedOut || result.terminationError !== undefined) {
      await runProcess("docker", ["rm", "--force", name], 10_000, 64 * 1024).catch(() => undefined);
    }
    if (result.terminationError !== undefined) throw result.terminationError;
    return result;
  }
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
