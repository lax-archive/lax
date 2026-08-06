import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchiveSnapshot } from "../submission-validation/archive/snapshot.js";
import type { ValidationRequest, ValidationScope } from "../submission-validation/contracts.js";
import { validateSubmissionOnHost } from "../submission-validation/host/pipeline.js";
import { hostValidationRuntime } from "../submission-validation/pins.js";
import { removeValidationWorkspace } from "../submission-validation/workspace-cleanup.js";
import { formatProfile, Profiler } from "../shared/profile.js";
import { databaseDirectory } from "./database.js";
import { formatLocalFindings } from "./findings.js";
import { deriveLocalSource, repositoryRoot } from "./git.js";
import { LoadingLine } from "./loading.js";
import { submissionIdFromFolder } from "./manifest.js";
import type { SourceLocation } from "../shared/types.js";

export interface LocalBuildOptions {
  replay?: boolean;
  scope?: ValidationScope;
  profile?: boolean;
  buildFromSource?: boolean;
}

/** Phases that stream their own transcript; the spinner stays out of the way. */
const STREAMING_PHASES = new Set(["warm store", "compile concepts", "compile proofs", "inspector binary"]);

/** Run the shared validation pipeline on the host toolchain, in place, against
 * the working tree and local Archive clone. */
export async function buildSubmission(
  folder: string,
  options: LocalBuildOptions = {},
): Promise<number> {
  const submissionRoot = fs.realpathSync(path.resolve(folder));
  const repository = fs.realpathSync(repositoryRoot(submissionRoot));
  const database = databaseDirectory();
  if (!fs.existsSync(path.join(database, ".git"))) {
    throw new Error(
      `local lax-database checkout is missing at ${database}; run \`lax update-db\``,
    );
  }
  const archiveSha = git(database, ["rev-parse", "HEAD"]);
  const request: ValidationRequest = {
    requestVersion: 1,
    id: submissionIdFromFolder(submissionRoot),
    source: deriveLocalSource(submissionRoot),
    archiveSha,
  };
  const runtime = hostValidationRuntime();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lax-build-"));
  const jobDir = path.join(temporary, "work");
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const scope = options.scope ?? "both";
  const progress = new LoadingLine(process.stderr);
  const profiler = new Profiler();
  console.log(
    `lax build: validating ${request.id}${scope === "both" ? "" : ` (${scope} only)`}` +
      `${options.replay === true ? " with kernel replay" : ""}`,
  );
  try {
    const report = await validateSubmissionOnHost(request, jobDir, {
      local: {
        fetched: { repositoryRoot: repository, submissionRoot },
        archive: new ArchiveSnapshot(database, archiveSha),
      },
      replay: options.replay ?? false,
      scope,
      fromSource: options.buildFromSource ?? false,
      profiler,
      onPhase: (event) => {
        if (event.state !== "start") return;
        if (STREAMING_PHASES.has(event.name)) progress.clear();
        else progress.update(`lax build · ${event.name}`);
      },
    });
    progress.clear();
    const findings = formatLocalFindings(report.warnings, report.violations);
    if (!report.ok || (scope === "both" && report.buildOutput === undefined)) {
      console.error(
        [findings, "lax build: validation failed; build-output.json was not changed"]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      );
      if (options.profile === true) console.log(`\n${formatProfile(profiler.snapshot())}`);
      return 1;
    }
    if (findings !== undefined) console.warn(findings);
    if (scope !== "both") {
      console.log(`lax build: OK (${scope} only) — partial build; build-output.json was not changed`);
      if (options.profile === true) console.log(`\n${formatProfile(profiler.snapshot())}`);
      return 0;
    }
    const output = {
      specVersion: "1",
      id: request.id,
      ...report.buildOutput!,
      localValidation: {
        version: 1,
        source: request.source,
        archiveSha,
        runtimeImageDigest: runtime.imageDigest,
        replay: options.replay === true,
      },
    };
    const filename = path.join(submissionRoot, "build-output.json");
    const staging = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(staging, `${JSON.stringify(output, null, 2)}\n`);
    fs.renameSync(staging, filename);
    console.log(`lax build: OK — ${filename} written`);
    if (options.profile === true) console.log(`\n${formatProfile(profiler.snapshot())}`);
    return 0;
  } finally {
    progress.clear();
    try {
      // parts of the job dir may be read-only (e.g. sealed capture files);
      // removeValidationWorkspace restores directory write bits before rm so
      // the temp tree never lingers in /tmp
      removeValidationWorkspace(temporary);
    } catch (error) {
      // never mask the build result with a cleanup failure
      console.warn(
        `lax build: could not remove the temporary workspace ${temporary}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** A clean checkout can reuse a full build only when source, Archive snapshot,
 * and the runtime that produced it all match: a pin bump changes what the same
 * sources compile to, so a pre-bump build-output is not current. */
export function hasCurrentLocalBuild(
  folder: string,
  source: SourceLocation,
  archiveSha: string,
): boolean {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(path.resolve(folder), "build-output.json"), "utf8"),
    ) as Record<string, unknown>;
    const validation = value.localValidation as Record<string, unknown> | undefined;
    const builtSource = validation?.source as Record<string, unknown> | undefined;
    return (
      value.id === submissionIdFromFolder(folder) &&
      validation?.version === 1 &&
      validation.archiveSha === archiveSha &&
      validation.runtimeImageDigest === hostValidationRuntime().imageDigest &&
      builtSource?.repository === source.repository &&
      builtSource.commit === source.commit &&
      builtSource.folder === source.folder
    );
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
