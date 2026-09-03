import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StaticResult, ValidationRequest, ValidationRuntimeIdentity } from "../contracts.js";
import { packageNameForSubmission } from "../contracts.js";
import { FindingCollector } from "../findings.js";
import { validateLakefile } from "../validators/lakefile.js";
import { isAcceptedLicense } from "../validators/license.js";
import { validateManifest } from "../validators/manifest.js";
import { deriveInventory } from "./inventory.js";

export function runStaticValidation(
  request: ValidationRequest,
  root: string,
  runtime: ValidationRuntimeIdentity,
): { result: StaticResult; findings: FindingCollector } {
  const findings = new FindingCollector("static");
  const result: StaticResult = {};
  const manifestPath = path.join(root, "manifest.yaml");
  if (!regularFile(manifestPath)) findings.violate("manifest", "manifest.yaml is missing");
  else {
    const content = readBounded(manifestPath, 256 * 1024, "manifest.yaml", findings);
    if (content !== undefined) {
      result.manifest = validateManifest(
        content,
        request.id,
        runtime,
        findings,
        request.issue,
        request.legacyManifestWithoutIssue,
      );
    }
  }

  const abstractPath = path.join(root, "abstract.md");
  if (!regularFile(abstractPath)) findings.violate("abstract", "abstract.md is missing");
  else {
    const content = readBounded(abstractPath, 1024 * 1024, "abstract.md", findings);
    if (content !== undefined) {
      const abstract = content.replace(/\r\n?/gu, "\n");
      if (abstract.trim() === "") findings.violate("abstract", "abstract.md must be non-empty");
      else result.abstract = abstract;
    }
  }

  const licensePath = path.join(root, "LICENSE");
  if (!regularFile(licensePath)) findings.violate("license", "LICENSE is missing");
  else {
    const content = readBounded(licensePath, 256 * 1024, "LICENSE", findings);
    if (content !== undefined && !isAcceptedLicense(content))
      findings.violate("license", "LICENSE does not match the canonical Apache License 2.0 text");
  }

  checkTrackedFiles(root, findings);
  const packageId = packageNameForSubmission(request.id);
  for (const kind of ["concepts", "proofs"] as const) {
    const packageName = kind === "concepts" ? packageId : `${packageId}Proofs`;
    const packageDir = path.join(root, kind);
    if (!directory(packageDir)) {
      findings.violate("layout", `${kind}/ is missing`);
      continue;
    }
    const toolchainPath = path.join(packageDir, "lean-toolchain");
    if (!regularFile(toolchainPath)) findings.violate("toolchain", `${kind}/lean-toolchain is missing`);
    else {
      const content = readBounded(toolchainPath, 1024, `${kind}/lean-toolchain`, findings);
      if (content !== undefined && content.trim() !== runtime.leanToolchain)
        findings.violate("toolchain", `${kind}/lean-toolchain must contain ${runtime.leanToolchain}`);
    }
    if (fs.existsSync(path.join(packageDir, "lakefile.lean")))
      findings.violate("lakefile", `${kind}/lakefile.lean is forbidden; use lakefile.toml`);
    const lakefilePath = path.join(packageDir, "lakefile.toml");
    let lakefile;
    if (!regularFile(lakefilePath)) findings.violate("lakefile", `${kind}/lakefile.toml is missing`);
    else {
      const content = readBounded(lakefilePath, 1024 * 1024, `${kind}/lakefile.toml`, findings);
      if (content !== undefined)
        lakefile = validateLakefile(
          content,
          kind,
          packageName,
          `${kind}/lakefile.toml`,
          runtime,
          findings,
        );
    }
    const inventory = deriveInventory(root, kind, packageName, findings);
    if (lakefile !== undefined) result[kind] = { lakefile, inventory };
  }
  return { result, findings };
}

function checkTrackedFiles(root: string, findings: FindingCollector): void {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "--", "."], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    }).toString();
    for (const filename of output.split("\n")) {
      const basename = path.basename(filename);
      if (basename === "build-output.json" || basename === "lake-manifest.json")
        findings.violate("generated-files", `generated file must not be committed: ${filename}`);
      if (filename.split("/").includes(".lake")) findings.violate("generated-files", `.lake content must not be committed: ${filename}`);
    }
  } catch (error) {
    findings.violate("tracked-files", `could not inspect the submitted git tree: ${(error as Error).message}`);
  }
}

function regularFile(filename: string): boolean {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function directory(filename: string): boolean {
  try {
    return fs.statSync(filename).isDirectory();
  } catch {
    return false;
  }
}

function readBounded(
  filename: string,
  maxBytes: number,
  label: string,
  findings: FindingCollector,
): string | undefined {
  const stat = fs.statSync(filename);
  if (stat.size > maxBytes) {
    findings.violate("file-size", `${label} exceeds ${formatBytes(maxBytes)}`);
    return undefined;
  }
  return fs.readFileSync(filename, "utf8");
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}
