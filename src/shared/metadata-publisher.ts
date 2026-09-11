import type { LoadedSubmission } from "./archive.js";
import { parseArchiveFiles, type ArchiveChanges } from "./archive-schema.js";
import { ADMIN_GITHUB_IDS } from "./constants.js";
import {
  commitMessage,
  parsePublishRequest,
  supersedesProblems,
  type PublisherArchive,
  type PublisherControl,
} from "./publisher.js";
import { AUTHOR_MUTABLE_STATES, recordGateProblems, requireCurrentRecord } from "./record-gates.js";
import type { PublishRequest } from "./types.js";
import { ValidationError } from "./validation.js";
import type { WorkflowRunRef } from "./workflow-comments.js";
import { parsePublishedBuildOutputPayload } from "../submission-validation/artifact-schema.js";
import type { BuildOutputPayload, SubmissionManifest, ValidationRequest } from "../submission-validation/contracts.js";
import {
  parseCurrentBuildOutput,
  parseMetadataResubmissionArtifact,
  presentationChanges,
  type ParsedMetadataResubmissionArtifact,
} from "../submission-validation/metadata-resubmission.js";

export type MetadataPublishResult =
  | { kind: "no-op" }
  | { kind: "committed"; archiveCommit: string; acceptedTitle: string };

interface MetadataPlan {
  payload: BuildOutputPayload;
  manifest: SubmissionManifest;
}

/** Trusted publication of a classifier-proven presentation-only resubmission. */
export class MetadataPublisher {
  constructor(
    private readonly control: PublisherControl,
    private readonly archive: PublisherArchive,
    private readonly repositoryId: number,
    private readonly admins: ReadonlySet<number> = ADMIN_GITHUB_IDS,
  ) {}

  async preflight(
    untrustedRequest: PublishRequest,
    untrustedArtifact: ParsedMetadataResubmissionArtifact,
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
    const artifact = parseMetadataResubmissionArtifact(untrustedArtifact, request);
    const current = await this.archive.load(request.id);
    await this.validateCurrent(request, artifact, current);
    return { kind: "ready", request };
  }

  async publish(
    untrustedRequest: PublishRequest,
    untrustedArtifact: ParsedMetadataResubmissionArtifact,
    run: WorkflowRunRef,
  ): Promise<MetadataPublishResult> {
    const ready = await this.preflight(untrustedRequest, untrustedArtifact);
    if (ready.kind === "no-op") return ready;
    const request = ready.request;
    const artifact = parseMetadataResubmissionArtifact(untrustedArtifact, request);
    const current = requireCurrentRecord(request.id, await this.archive.load(request.id));
    const plan = await this.validateCurrent(request, artifact, current);
    const changes = constructMetadataChanges(request, current, plan.payload);
    const archiveCommit = await this.archive.writeFiles({
      id: request.id,
      changes,
      message: commitMessage(request, run.url),
      validateCurrent: async (latest) => {
        await this.validateCurrent(request, artifact, latest);
      },
    });
    return {
      kind: "committed",
      archiveCommit,
      acceptedTitle: plan.manifest.title,
    };
  }

  private async canonicalRequest(untrustedRequest: PublishRequest): Promise<PublishRequest> {
    let request = parsePublishRequest(untrustedRequest, this.repositoryId);
    if (request.action !== "submit" || request.command?.action !== "submit" || request.commentId === undefined) {
      throw new ValidationError("metadata publication requires an ordinary submit request");
    }
    const actor = (await this.control.resolveOwnerPairs([request.actor]))[0];
    if (actor === undefined) throw new ValidationError("submit actor no longer resolves on GitHub");
    request = parsePublishRequest({ ...request, actor }, this.repositoryId);
    return request;
  }

  private async validateCurrent(
    request: PublishRequest,
    artifact: ParsedMetadataResubmissionArtifact,
    loaded: LoadedSubmission | undefined,
  ): Promise<MetadataPlan> {
    const current = requireCurrentRecord(request.id, loaded);
    const problems = recordGateProblems(request, current, {
      authorStates: AUTHOR_MUTABLE_STATES,
      relevantPreconditions: ["record", "buildOutput"],
      admins: this.admins,
    });
    if (artifact.previousBuildOutput !== current.preconditions.buildOutput) {
      problems.push("metadata comparison does not describe the current build output");
    }
    if (JSON.stringify(current.files.record.source ?? null) !== JSON.stringify(artifact.previousSource)) {
      problems.push("metadata comparison does not describe the current recorded source");
    }
    if (request.command?.action !== "submit" || JSON.stringify(request.command) !== JSON.stringify({
      action: "submit",
      ...artifact.source,
    })) {
      problems.push("metadata comparison source does not match the authorized submit command");
    }

    let plan: MetadataPlan | undefined;
    try {
      const published = parseCurrentBuildOutput(current, artifact.previousSource);
      const candidateValue = {
        ...published.payload,
        inputs: artifact.inputs,
        capture: { ...published.payload.capture, sourceCommit: artifact.source.commit },
      };
      const payload = parsePublishedBuildOutputPayload(
        candidateValue,
        validationRequest(request, artifact.source),
        published.runtime,
      );
      const fields = presentationChanges(published.payload.inputs, payload.inputs);
      if (fields === undefined || JSON.stringify(fields) !== JSON.stringify(artifact.fields)) {
        problems.push("metadata comparison changed fields outside title, authors, and abstract");
      }
      plan = { payload, manifest: payload.inputs.manifest };
    } catch (error) {
      problems.push((error as Error).message);
    }
    if (plan !== undefined) {
      problems.push(...(await supersedesProblems(
        this.archive,
        plan.manifest.supersedes,
        request.id,
        request.actor,
        current.snapshot,
      )));
    }
    if (problems.length > 0 || plan === undefined) {
      throw new ValidationError(problems.join("\n- ") || "metadata publication could not be reconstructed");
    }
    return plan;
  }
}

function constructMetadataChanges(
  request: PublishRequest,
  current: LoadedSubmission,
  payload: BuildOutputPayload,
): ArchiveChanges {
  if (request.command?.action !== "submit") throw new ValidationError("metadata submit command is missing");
  const source = {
    repository: request.command.repository,
    commit: request.command.commit,
    folder: request.command.folder,
  };
  const record = {
    specVersion: "1",
    id: request.id,
    state: "draft",
    createdAt: current.files.record.createdAt,
    source,
  };
  const buildOutput = {
    specVersion: "1",
    id: request.id,
    issue: current.files.buildOutput.issue,
    ...payload,
  };
  const changes: ArchiveChanges = {
    "record.json": `${JSON.stringify(record, null, 2)}\n`,
    "build-output.json": `${JSON.stringify(buildOutput, null, 2)}\n`,
  };
  parseArchiveFiles(request.id, { ...current.texts, ...changes } as Record<string, string>);
  return changes;
}

function validationRequest(request: PublishRequest, source: ParsedMetadataResubmissionArtifact["source"]): ValidationRequest {
  return {
    requestVersion: 1,
    id: request.id,
    source,
    archiveSha: request.archiveSha,
    issue: request.issue,
    ...(request.legacyManifestWithoutIssue === true ? { legacyManifestWithoutIssue: true } : {}),
  };
}
