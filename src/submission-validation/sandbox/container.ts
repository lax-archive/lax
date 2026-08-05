import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type { ValidationRuntimeIdentity } from "../contracts.js";
import type { Profiler } from "../../shared/profile.js";
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
 * Runs one phase in a fresh container from the immutable warm-runtime image.
 * The caller supplies an explicit mount and environment allowlist; no host
 * directory, credential, socket, or ambient environment is inherited.
 */
export class ContainerRunner implements ValidationRunner {
  constructor(
    private readonly runtime: ValidationRuntimeIdentity,
    private readonly limits: ValidationLimits,
    private readonly workspaceRoot: string,
    private readonly profiler?: Profiler,
  ) {}

  /** Time one container invocation, so the profile prices container startup. */
  private timed<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (this.profiler === undefined) return operation();
    return this.profiler.span(`container ${label}`, operation, { container: true });
  }

  async verifyRuntime(): Promise<void> {
    const result = await this.timed("runtime-manifest", () => runProcess(
      "docker",
      [
        "run",
        "--rm",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--entrypoint=/bin/cat",
        this.runtime.image,
        "/opt/lax-runtime/runtime-manifest.json",
      ],
      60_000,
      64 * 1024,
    ));
    if (result.code !== 0) throw new Error(`validation runtime is unavailable: ${result.output.trim()}`);
    let actual: unknown;
    try {
      actual = JSON.parse(result.output);
    } catch {
      throw new Error("validation runtime manifest is not valid JSON");
    }
    const expected = {
      layoutVersion: this.runtime.layoutVersion,
      leanToolchain: this.runtime.leanToolchain,
      leanVersion: this.runtime.leanVersion,
      mathlibRepository: this.runtime.mathlibRepository,
      mathlibCommit: this.runtime.mathlibCommit,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("validation runtime manifest does not match validation-runtime.lock.json");
    }
  }

  async run(invocation: ContainerInvocation): Promise<ContainerResult> {
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
    for (const mount of invocation.mounts ?? []) {
      const source = path.resolve(mount.source);
      if (!fs.existsSync(source)) throw new Error(`container mount does not exist: ${source}`);
      if (!path.isAbsolute(mount.target)) throw new Error("container mount targets must be absolute");
      args.push(
        "--mount",
        `type=bind,src=${source},dst=${mount.target}${mount.writable === true ? "" : ",readonly"}`,
      );
    }
    if (invocation.workdir !== undefined) args.push(`--workdir=${invocation.workdir}`);
    for (const [key, value] of Object.entries(invocation.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
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
