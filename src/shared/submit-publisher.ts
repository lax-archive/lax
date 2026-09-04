import { adminStateProblem, maintainerProblem } from "./admin.js";
import type { ArchiveSnapshot, LoadedSubmission } from "./archive.js";
import { samePreconditions } from "./archive.js";
import { parseArchiveFiles, supersedesClaim, type ArchiveChanges } from "./archive-schema.js";
import type { GhcrCaptureStore } from "./capture-store.js";
import { ADMIN_GITHUB_IDS } from "./constants.js";
import {
  commitMessage,
  parsePublishRequest,
  supersedesProblems,
  type PublisherArchive,
  type PublisherControl,
} from "./publisher.js";
import type { PublishRequest, SourceLocation } from "./types.js";
import { ValidationError } from "./validation.js";
import type {
  BuildOutputPayload,
  PublishedCapture,
  ResolvedDependency,
} from "../submission-validation/contracts.js";
import type { SuccessfulValidationArtifacts } from "../submission-validation/artifact-schema.js";
import { parsePublishedCapture } from "../submission-validation/artifact-schema.js";
import type { WorkflowRunRef } from "./workflow-comments.js";

export type SubmitPublishResult =
  | { kind: "no-op" }
  | { kind: "committed"; archiveCommit: string; acceptedTitle: string };

export interface SubmitCaptureStore {
  promote: GhcrCaptureStore["promote"];
}

export class SubmitPublisher {
  constructor(
    private readonly control: PublisherControl,
    private readonly archive: PublisherArchive,
    private readonly captureStore: SubmitCaptureStore | undefined,
    private readonly repositoryId: number,
    /** Maintainer ids; injectable for tests, ADMIN_GITHUB_IDS in production. */
    private readonly admins: ReadonlySet<number> = ADMIN_GITHUB_IDS,
  ) {}

  async preflight(
    untrustedRequest: PublishRequest,
    artifacts: SuccessfulValidationArtifacts,
  ): Promise<{ kind: "no-op" } | { kind: "ready"; request: PublishRequest }> {
    const request = await this.canonicalRequest(untrustedRequest);
    if (await this.control.resultExists(
      request.issue.number,
      request.commentId!,
      request.eventCreatedAt,
    )) {
      await this.control.clearCommandProgress(request.commentId!);
      return { kind: "no-op" };
    }
    const current = await this.archive.load(request.id);
    await this.validateCurrent(request, artifacts, current);
    return { kind: "ready", request };
  }

  /**
   * `paperPdfPath` is the compiled paper from the validate artifact, required
   * exactly when the build output records one; the caller has already hashed
   * it against the recorded digest (readSuccessfulArtifacts), and promote()
   * hashes it again before the push. `paperWebPath` is the derived reflow
   * bundle under exactly the same contract, keyed to `paper.web`.
   */
  async publish(
    untrustedRequest: PublishRequest,
    artifacts: SuccessfulValidationArtifacts,
    capturePath: string,
    run: WorkflowRunRef,
    paperPdfPath?: string,
    paperWebPath?: string,
  ): Promise<SubmitPublishResult> {
    if (this.captureStore === undefined) throw new Error("submit publisher has no capture store");
    const ready = await this.preflight(untrustedRequest, artifacts);
    if (ready.kind === "no-op") return { kind: "no-op" };
    const request = ready.request;
    const current = await this.archive.load(request.id);
    await this.validateCurrent(request, artifacts, current);
    if (current === undefined) throw new ValidationError(`${request.id} no longer exists in lax-database`);
    // Ordering invariant: the ghcr push (blob, manifest, and tag) completes
    // before the database CAS commit below references the blob's digest — a
    // record must never point at a blob that is not durably stored. If the
    // commit fails afterwards, the pushed artifact is orphaned garbage,
    // never inconsistency, and a retry re-pushes the identical bytes onto
    // the same content address (idempotent).
    const paper = artifacts.buildOutput.paper;
    if ((paper === undefined) !== (paperPdfPath === undefined)) {
      throw new ValidationError("the validated build output records a paper exactly when a paper.pdf is supplied");
    }
    if ((paper?.web === undefined) !== (paperWebPath === undefined)) {
      throw new ValidationError("the validated build output records a paper web view exactly when a paper-web.tar is supplied");
    }
    const promoted = await this.captureStore.promote(
      request.id,
      artifacts.report.request.source,
      artifacts.report.capture,
      capturePath,
      paper === undefined || paperPdfPath === undefined
        ? undefined
        : { pdfPath: paperPdfPath, digest: paper.pdf.digest, bytes: paper.pdf.bytes },
      paper?.web === undefined || paperWebPath === undefined
        ? undefined
        : { bundlePath: paperWebPath, digest: paper.web.bundle.digest, bytes: paper.web.bundle.bytes },
    );
    if ((paper === undefined) !== (promoted.paperBlob === undefined)) {
      throw new ValidationError("the capture store did not push the paper layer it was asked for");
    }
    if ((paper?.web === undefined) !== (promoted.paperWebBlob === undefined)) {
      throw new ValidationError("the capture store did not push the paper web layer it was asked for");
    }
    const changes = constructSubmitChanges(
      request,
      current,
      artifacts.buildOutput,
      promoted.capture,
      promoted.paperBlob,
      promoted.paperWebBlob,
    );
    const archiveCommit = await this.archive.writeFiles({
      id: request.id,
      changes,
      message: commitMessage(request, run.url),
      validateCurrent: async (latest) => this.validateCurrent(request, artifacts, latest),
    });
    return {
      kind: "committed",
      archiveCommit,
      acceptedTitle: artifacts.buildOutput.inputs.manifest.title,
    };
  }

  private async canonicalRequest(untrustedRequest: PublishRequest): Promise<PublishRequest> {
    let request = parsePublishRequest(untrustedRequest, this.repositoryId);
    // A maintainer revalidation is a submit whose source the route job read
    // from the record; it runs the same pipeline and lands here the same way.
    const validated =
      (request.action === "submit" && request.command?.action === "submit") ||
      (request.action === "revalidate" && request.command?.action === "revalidate");
    if (!validated || request.commentId === undefined) {
      throw new ValidationError("trusted submit publication requires a submit or revalidate request");
    }
    const actor = (await this.control.resolveOwnerPairs([request.actor]))[0];
    if (actor === undefined) throw new ValidationError("submit actor no longer resolves on GitHub");
    request = parsePublishRequest({ ...request, actor }, this.repositoryId);
    return request;
  }

  private async validateCurrent(
    request: PublishRequest,
    artifacts: SuccessfulValidationArtifacts,
    current: LoadedSubmission | undefined,
  ): Promise<void> {
    if (current === undefined) throw new ValidationError(`${request.id} no longer exists in lax-database`);
    const problems: string[] = [];
    if (
      current.files.buildOutput.issue.repositoryId !== request.issue.repositoryId ||
      current.files.buildOutput.issue.number !== request.issue.number
    ) problems.push(`${request.id} no longer has the expected issue binding`);
    const revalidation = request.action === "revalidate";
    const commandSource = commandSourceOf(request);
    if (revalidation) {
      // The route job's maintainer and lifecycle gates, repeated on the
      // canonical actor and the current record (trust rule 2) — plus the one
      // rule that makes a revalidation what it is: the source is the record's
      // own, and still is.
      const maintainer = maintainerProblem(request.actor, this.admins);
      if (maintainer !== undefined) problems.push(maintainer);
      const state = adminStateProblem(
        "revalidate",
        request.id,
        current.files.record.state,
        current.files.record.source !== undefined,
      );
      if (state !== undefined) problems.push(state);
      if (
        commandSource === undefined ||
        JSON.stringify(commandSource) !== JSON.stringify(current.files.record.source ?? null)
      ) {
        problems.push(`${request.id} no longer records the source the revalidation was authorized for`);
      }
    } else {
      if (!current.files.ownerList.owners.some((owner) => owner.githubId === request.actor.githubId)) {
        problems.push(`${request.actor.handle} is no longer an owner of ${request.id}`);
      }
      if (current.files.record.state !== "init" && current.files.record.state !== "draft") {
        problems.push(`${request.id} is now ${current.files.record.state}`);
      }
    }
    if (
      request.preconditions === undefined ||
      !samePreconditions(current.preconditions, request.preconditions, ["record", "buildOutput"])
    ) problems.push(`${request.id} changed after validation; submit a new command comment`);
    if (
      commandSource === undefined ||
      JSON.stringify(commandSource) !== JSON.stringify(artifacts.report.request.source)
    ) {
      problems.push("validated source does not match the authorized submit command");
    }
    const dependencyProblems = await this.validateDependencies(
      artifacts.report.dependencies,
      current.snapshot,
    );
    problems.push(...dependencyProblems);
    if (revalidation) {
      // Same source, same manifest, same claim — and a registered record's
      // claim is already bound, so it is compared, not re-admitted (the
      // maintainer need not own the target).
      let recorded: string | undefined;
      try {
        recorded = supersedesClaim(current.files.buildOutput);
      } catch (error) {
        problems.push((error as Error).message);
      }
      if (artifacts.buildOutput.inputs.manifest.supersedes !== recorded) {
        problems.push("a revalidation may not change the recorded supersedes claim");
      }
    } else {
      // The claim only binds at registration, but a submit that can never
      // register is refused here, where the author still holds a fresh build.
      problems.push(
        ...(await supersedesProblems(
          this.archive,
          artifacts.buildOutput.inputs.manifest.supersedes,
          request.id,
          request.actor,
          current.snapshot,
        )),
      );
    }
    if (problems.length > 0) throw new ValidationError(problems.join("\n- "));
  }

  private async validateDependencies(
    dependencies: ResolvedDependency[],
    snapshot: ArchiveSnapshot,
  ): Promise<string[]> {
    const problems: string[] = [];
    const loaded = new Map<string, LoadedSubmission | undefined>();
    for (const expected of dependencies) {
      let current = loaded.get(expected.submissionId);
      if (!loaded.has(expected.submissionId)) {
        try {
          current = await this.archive.load(expected.submissionId, snapshot);
        } catch (error) {
          problems.push(`dependency ${expected.packageName} cannot be re-read: ${(error as Error).message}`);
          loaded.set(expected.submissionId, undefined);
          continue;
        }
        loaded.set(expected.submissionId, current);
      }
      if (current === undefined) {
        problems.push(`dependency ${expected.packageName} no longer exists`);
        continue;
      }
      if (current.files.buildOutput.issue.repositoryId !== this.repositoryId) {
        problems.push(`dependency ${expected.packageName} has an invalid issue binding`);
      }
      if (current.files.record.state !== "draft" && current.files.record.state !== "registered") {
        problems.push(`dependency ${expected.packageName} is now ${current.files.record.state}`);
        continue;
      }
      if (expected.state === "registered" && current.files.record.state !== "registered") {
        problems.push(`registered dependency ${expected.packageName} is no longer registered`);
      }
      if (JSON.stringify(current.files.record.source) !== JSON.stringify(expected.source)) {
        problems.push(`dependency ${expected.packageName} source changed after validation`);
      }
      let capture: PublishedCapture | undefined;
      try {
        capture = parsePublishedCapture(current.files.buildOutput.capture);
      } catch (error) {
        problems.push(`dependency ${expected.packageName} capture is invalid: ${(error as Error).message}`);
      }
      if (capture !== undefined && JSON.stringify(capture) !== JSON.stringify(expected.capture)) {
        problems.push(`dependency ${expected.packageName} capture changed after validation`);
      }
      const required = requiredPackages(current, expected.kind);
      if (JSON.stringify(required) !== JSON.stringify(expected.requiredPackages)) {
        problems.push(`dependency ${expected.packageName} dependency list changed after validation`);
      }
      const statements = expected.kind === "concepts" ? conceptStatements(current) : [];
      if (JSON.stringify(statements) !== JSON.stringify(expected.statements)) {
        problems.push(`dependency ${expected.packageName} statements changed after validation`);
      }
    }
    return problems;
  }
}

function constructSubmitChanges(
  request: PublishRequest,
  current: LoadedSubmission,
  payload: BuildOutputPayload,
  publishedCapture: PublishedCapture,
  paperBlob: string | undefined,
  paperWebBlob?: string,
): ArchiveChanges {
  const commandSource = commandSourceOf(request);
  if (commandSource === undefined) throw new ValidationError("submit command is missing");
  // A submit lands as a draft; a revalidation republishes the build output
  // under whatever state the record already has (validateCurrent has just
  // confirmed the source is unchanged, so a registered record stays one).
  const record = {
    specVersion: "1",
    id: request.id,
    state: request.action === "revalidate" ? current.files.record.state : "draft",
    createdAt: current.files.record.createdAt,
    source: commandSource,
  };
  // A recorded `paper.web` gains its bundle's registry address the same way
  // the pdf does; parseArchiveFiles below refuses a published web block
  // whose registryBlob is missing or disagrees with the bundle digest, so a
  // dropped or wrong address can never be committed.
  const publishedPaper = payload.paper === undefined || paperBlob === undefined
    ? undefined
    : {
        ...payload.paper,
        pdf: { ...payload.paper.pdf, registryBlob: paperBlob },
        ...(payload.paper.web === undefined || paperWebBlob === undefined
          ? {}
          : {
              web: {
                ...payload.paper.web,
                bundle: { ...payload.paper.web.bundle, registryBlob: paperWebBlob },
              },
            }),
      };
  const buildOutput = {
    specVersion: "1",
    id: request.id,
    issue: current.files.buildOutput.issue,
    inputs: payload.inputs,
    requiredByConcepts: payload.requiredByConcepts,
    requiredByProofs: payload.requiredByProofs,
    concepts: payload.concepts,
    proofs: payload.proofs,
    capture: publishedCapture,
    ...(publishedPaper === undefined ? {} : { paper: publishedPaper }),
  };
  const changes: ArchiveChanges = {
    "record.json": `${JSON.stringify(record, null, 2)}\n`,
    "build-output.json": `${JSON.stringify(buildOutput, null, 2)}\n`,
  };
  parseArchiveFiles(request.id, { ...current.texts, ...changes } as Record<string, string>);
  return changes;
}

function source(value: SourceLocation): SourceLocation {
  return { repository: value.repository, commit: value.commit, folder: value.folder };
}

/** The source a validated request authorizes: typed on a submit, recorded on a revalidation. */
function commandSourceOf(request: PublishRequest): SourceLocation | undefined {
  const command = request.command;
  if (command?.action === "submit") return source(command);
  if (command?.action === "revalidate" && command.source !== undefined) return source(command.source);
  return undefined;
}

function requiredPackages(current: LoadedSubmission, kind: "concepts" | "proofs"): string[] {
  const value = current.files.buildOutput[kind === "concepts" ? "requiredByConcepts" : "requiredByProofs"];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...new Set(value as string[])].sort()
    : [];
}

function conceptStatements(current: LoadedSubmission): string[] {
  const concepts = current.files.buildOutput.concepts;
  if (!Array.isArray(concepts)) return [];
  const statements: string[] = [];
  for (const concept of concepts) {
    if (concept === null || typeof concept !== "object" || Array.isArray(concept)) continue;
    const entries = (concept as Record<string, unknown>).statements;
    if (!Array.isArray(entries)) continue;
    for (const statement of entries) {
      if (statement !== null && typeof statement === "object" && !Array.isArray(statement)) {
        const id = (statement as Record<string, unknown>).id;
        if (typeof id === "string") statements.push(id);
      }
    }
  }
  return [...new Set(statements)].sort();
}
