import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PAPER_CAPS } from "../config.js";
import type {
  PaperManifest,
  StaticPaper,
  StaticResult,
  ValidationRequest,
  ValidationRuntimeIdentity,
} from "../contracts.js";
import { packageNameForSubmission } from "../contracts.js";
import { FindingCollector } from "../findings.js";
import { infrastructureFailure, resourceLimitFailure } from "../failures.js";
import { rewriteMarkers, texRewriteOrder } from "../paper/rewrite.js";
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
    if (content !== undefined) result.manifest = validateManifest(content, request.id, runtime, findings);
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

  checkTrackedFiles(root, findings, result.manifest?.paper !== undefined);
  if (result.manifest?.paper !== undefined) result.paper = checkPaper(root, result.manifest.paper, findings);
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

/**
 * The paper's static gate (paper-plan.md, "Pipeline placement"): everything
 * about a declared paper that needs no TeX — the folder is a plain directory
 * inside the submission, the entry file a regular file inside it, the folder
 * within its caps, and every marker well-formed and balanced. The rewritten
 * texts and the mark table come out of it, so the paper phase never parses a
 * marker again. A typo here costs seconds, not a compile.
 */
function checkPaper(root: string, paper: PaperManifest, findings: FindingCollector): StaticPaper | undefined {
  const rootReal = fs.realpathSync(root);
  const folder = path.resolve(rootReal, paper.folder);
  if (folder !== rootReal && !folder.startsWith(`${rootReal}${path.sep}`)) {
    findings.violate("paper", `manifest.yaml: paper.folder ${paper.folder} escapes the submission`);
    return undefined;
  }
  let folderReal: string;
  try {
    folderReal = fs.realpathSync(folder);
  } catch {
    findings.violate("paper", `paper folder ${paper.folder} does not exist`);
    return undefined;
  }
  if (folderReal !== folder || !fs.statSync(folderReal).isDirectory()) {
    findings.violate("paper", `paper folder ${paper.folder} must be a plain directory and may not traverse a symlink`);
    return undefined;
  }

  // Everything under the folder goes into the compile copy, so everything
  // under it counts — except the build's own leftovers when the folder is
  // the submission root, and the version-control and Lake trees, which are
  // never part of a paper.
  const files: string[] = [];
  let bytes = 0;
  let ok = true;
  const walk = (relative: string): void => {
    const directory = relative === "" ? folderReal : path.join(folderReal, relative);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativeEntry = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        findings.violate("paper", `paper folder contains a symlink, which is not accepted: ${relativeEntry}`);
        ok = false;
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".lake") continue;
        walk(relativeEntry);
        continue;
      }
      if (!entry.isFile()) {
        findings.violate("paper", `paper folder contains a non-regular entry: ${relativeEntry}`);
        ok = false;
        continue;
      }
      if (relative === "" && folderReal === rootReal && (entry.name === "build-output.json" || entry.name === "paper.pdf")) continue;
      files.push(relativeEntry);
      bytes += fs.statSync(path.join(folderReal, relativeEntry)).size;
    }
  };
  walk("");
  if (files.length > PAPER_CAPS.folderFiles) {
    findings.violate("paper", `paper folder holds more than ${PAPER_CAPS.folderFiles} files`);
    ok = false;
  }
  if (bytes > PAPER_CAPS.folderBytes) {
    findings.violate("paper", `paper folder exceeds ${formatBytes(PAPER_CAPS.folderBytes)}`);
    ok = false;
  }
  if (!files.includes(paper.main)) {
    findings.violate("paper", `paper entry file ${paper.main} is not a regular file under ${paper.folder}`);
    ok = false;
  }
  if (!ok) return undefined;
  files.sort();

  // Binary-transparent: `.tex` files are decoded and re-encoded as latin1,
  // so a non-UTF-8 source (an old paper under inputenc) survives byte for
  // byte; the markers and their replacements are ASCII.
  const texFiles = texRewriteOrder(paper.main, files);
  const rewrite = rewriteMarkers(
    texFiles.map((file) => ({ path: file, text: fs.readFileSync(path.join(folderReal, file), "latin1") })),
  );
  for (const problem of rewrite.problems) findings.violate("paper-markers", `${paper.folder === "." ? "" : `${paper.folder}/`}${problem}`);
  if (rewrite.problems.length > 0) return undefined;
  return {
    manifest: paper,
    files,
    texFiles,
    rewritten: new Map(rewrite.rewritten.map((file) => [file.path, file.text])),
    marks: rewrite.marks,
  };
}

function checkTrackedFiles(root: string, findings: FindingCollector, paperDeclared: boolean): void {
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
      if (basename === "package-overrides.json") {
        // an author-controlled overrides file is a dependency-redirection
        // primitive; the check is about the file being *tracked* — lax itself
        // writes a gitignored .lake/package-overrides.json in every build
        findings.violate(
          "generated-files",
          `a Lake package-overrides file must not be committed: ${filename} — ` +
            ".lake/package-overrides.json is generated by lax to point dependencies at the " +
            "shared local store; a checked-in copy would redirect dependency resolution and " +
            "corrupt reproducibility, so it must stay gitignored",
        );
      } else if (basename === "build-output.json" || basename === "lake-manifest.json") {
        findings.violate("generated-files", `generated file must not be committed: ${filename}`);
      } else if (paperDeclared && filename === "paper.pdf") {
        // the local build writes the compiled paper beside build-output.json
        findings.violate("generated-files", `generated file must not be committed: ${filename}`);
      } else if (filename.split("/").includes(".lake")) {
        findings.violate("generated-files", `.lake content must not be committed: ${filename}`);
      }
    }
  } catch (error) {
    const message = `could not inspect the submitted git tree: ${(error as Error).message}`;
    if (error instanceof Error && /(?:timed? out|ETIMEDOUT)/iu.test(error.message)) {
      throw resourceLimitFailure(message);
    }
    throw infrastructureFailure(message);
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
