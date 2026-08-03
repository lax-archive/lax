import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decodeUtf8, isObject, requireExactKeys, ValidationError } from "../shared/validation.js";
import {
  type ValidationRequest,
  validationRequestFromUnknown,
} from "./contracts.js";
import { resetValidationOutputs, writeValidationOutputs } from "./outputs.js";
import {
  compileSubmission,
  inspectSubmission,
  replaySubmission,
  validateSubmission,
} from "./pipeline.js";
import { removeValidationWorkspace } from "./workspace-cleanup.js";

type Stage = "compile" | "replay" | "inspect";
type CompletedStage = "compile" | "replay";

interface StageState {
  stateVersion: 1;
  completed: CompletedStage;
  runtimeImage: string;
  request: ValidationRequest;
}

const mode = process.argv[2] as Stage | "cleanup" | undefined;
if (mode !== undefined && !["compile", "replay", "inspect", "cleanup"].includes(mode)) {
  throw new Error("usage: run.js [compile|replay|inspect|cleanup]");
}

const outputDir = validationOutputDirectory();
const jobDir = path.join(outputDir, "work");
const statePath = path.join(outputDir, "stage-state.json");

let exitCode = 1;
try {
  if (mode === "cleanup") {
    removeValidationWorkspace(jobDir);
    fs.rmSync(statePath, { force: true });
    exitCode = 0;
  } else if (mode === undefined) {
    resetValidationOutputs(outputDir);
    fs.rmSync(statePath, { force: true });
    removeValidationWorkspace(jobDir);
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const report = await validateSubmission(readRequest(), jobDir);
    writeValidationOutputs(outputDir, report);
    exitCode = report.ok ? 0 : 2;
  } else {
    if (mode === "compile") resetStagedValidation();
    const request = readRequest();
    exitCode = await runStage(mode, request);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  // The single-process entry point retains its original cleanup behavior.
  // Staged workflow invocations deliberately preserve work until the
  // unconditional cleanup step runs after Compile, Replay, and Inspect.
  if (mode === undefined) removeValidationWorkspace(jobDir);
}
process.exitCode = exitCode;

async function runStage(stage: Stage, request: ValidationRequest): Promise<number> {
  if (stage === "compile") {
    const failure = await compileSubmission(request, jobDir);
    if (failure !== undefined) {
      writeValidationOutputs(outputDir, failure);
      return 2;
    }
    writeStageState({
      stateVersion: 1,
      completed: "compile",
      runtimeImage: requiredEnv("LAX_VALIDATION_IMAGE"),
      request,
    });
    return 0;
  }

  requireStageState(stage === "replay" ? "compile" : "replay", request);
  if (stage === "replay") {
    const failure = await replaySubmission(request, jobDir);
    if (failure !== undefined) {
      writeValidationOutputs(outputDir, failure);
      return 2;
    }
    writeStageState({
      stateVersion: 1,
      completed: "replay",
      runtimeImage: requiredEnv("LAX_VALIDATION_IMAGE"),
      request,
    });
    return 0;
  }

  const report = await inspectSubmission(request, jobDir);
  writeValidationOutputs(outputDir, report);
  return report.ok ? 0 : 2;
}

function resetStagedValidation(): void {
  resetValidationOutputs(outputDir);
  fs.rmSync(statePath, { force: true });
  removeValidationWorkspace(jobDir);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
}

function readRequest(): ValidationRequest {
  const encoded = requiredEnv("VALIDATION_REQUEST");
  let raw: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("non-canonical base64");
    raw = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    throw new ValidationError("VALIDATION_REQUEST is not canonical base64-encoded JSON");
  }
  return validationRequestFromUnknown(raw);
}

function requireStageState(expected: CompletedStage, request: ValidationRequest): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(statePath);
  } catch {
    throw new Error(`validation ${expected} stage did not complete`);
  }
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("validation stage state is malformed");
  const value = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
  if (!isObject(value)) throw new Error("validation stage state must be an object");
  requireExactKeys(
    value,
    ["stateVersion", "completed", "runtimeImage", "request"],
    "validation stage state",
  );
  if (value.stateVersion !== 1 || value.completed !== expected) {
    throw new Error(`validation ${expected} stage did not complete`);
  }
  if (value.runtimeImage !== requiredEnv("LAX_VALIDATION_IMAGE")) {
    throw new Error("validation runtime changed between steps");
  }
  const stagedRequest = validationRequestFromUnknown(value.request);
  if (JSON.stringify(stagedRequest) !== JSON.stringify(request)) {
    throw new Error("validation stage request changed between steps");
  }
}

function writeStageState(state: StageState): void {
  const temporary = path.join(
    outputDir,
    `.stage-state.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, statePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function validationOutputDirectory(): string {
  const directory = path.resolve(requiredEnv("LAX_VALIDATION_OUTPUT"));
  if (directory === "/" || directory === process.cwd()) {
    throw new Error("LAX_VALIDATION_OUTPUT must be a dedicated directory");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
