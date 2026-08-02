import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredRuntime } from "../submission-validation/config.js";
import type { ValidationRuntimeIdentity } from "../submission-validation/contracts.js";
import lock from "../submission-validation/runtime/validation-runtime.lock.json" with { type: "json" };

export function localValidationRuntime(buildFromSource = false): ValidationRuntimeIdentity {
  if (!buildFromSource) return configuredRuntime();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const fingerprint = sourceFingerprint(root).slice(0, 16);
  const tag = `lax-validation-local:${fingerprint}`;
  try {
    execFileSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
  } catch {
    console.log("lax build: building the pinned validation runtime locally (this can take hours once)");
    execFileSync(
      "docker",
      [
        "build",
        "--file",
        path.join(root, "src", "submission-validation", "runtime", "Containerfile"),
        "--tag",
        tag,
        "--build-arg",
        `LAYOUT_VERSION=${lock.layoutVersion}`,
        "--build-arg",
        `LEAN_TOOLCHAIN=${lock.leanToolchain}`,
        "--build-arg",
        `LEAN_VERSION=${lock.leanVersion}`,
        "--build-arg",
        `MATHLIB_REPOSITORY=${lock.mathlibRepository}`,
        "--build-arg",
        `MATHLIB_COMMIT=${lock.mathlibCommit}`,
        "--build-arg",
        `ELAN_COMMIT=${lock.elanCommit}`,
        root,
      ],
      { stdio: "inherit" },
    );
  }
  const image = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  return configuredRuntime(image, { allowLocalImageId: true });
}

function sourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  const roots = [
    path.join(root, "src", "submission-validation", "runtime"),
    path.join(root, "src", "submission-validation", "lean", "inspector"),
  ];
  for (const base of roots) walk(base, hash, base);
  return hash.digest("hex");
}

function walk(directory: string, hash: ReturnType<typeof createHash>, base: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name))) {
    if (entry.name === ".lake") continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename, hash, base);
    else if (entry.isFile()) {
      hash.update(path.relative(base, filename).split(path.sep).join("/"));
      hash.update("\0");
      hash.update(fs.readFileSync(filename));
      hash.update("\0");
    }
  }
}
