export type SubmissionState = "init" | "draft" | "registered" | "deleted";

export interface GitHubIdentity {
  githubId: number;
  handle: string;
}

export interface OwnerList {
  specVersion: "1";
  owners: GitHubIdentity[];
}

export interface SourceLocation {
  repository: string;
  commit: string;
  folder: string;
}

export interface ArchiveRecord {
  specVersion: "1";
  id: string;
  state: SubmissionState;
  createdAt: string;
  source?: SourceLocation;
  deletedAt?: string;
}

export interface IssueBinding {
  repositoryId: number;
  number: number;
}

export interface BuildOutput {
  specVersion: "1";
  id: string;
  issue: IssueBinding;
  [key: string]: unknown;
}

export interface ArchiveFiles {
  record: ArchiveRecord;
  buildOutput: BuildOutput;
  ownerList: OwnerList;
}

export type ParsedCommand =
  | { action: "owners"; owners: GitHubIdentity[] }
  | ({ action: "submit" } & SourceLocation)
  | { action: "delete" }
  | { action: "register" };

export interface FilePreconditions {
  record: string;
  buildOutput: string;
  ownerList: string;
}

export interface PublishRequest {
  action: "create" | ParsedCommand["action"];
  id: string;
  issue: IssueBinding;
  actor: GitHubIdentity;
  issueNodeId: string;
  eventCreatedAt: string;
  commentId?: number;
  title?: string;
  command?: ParsedCommand;
  archiveSha: string;
  preconditions?: FilePreconditions;
  dependents?: string[];
  /** Exact historical issue body authorized an issue-derived manifest without an issue field. */
  legacyManifestWithoutIssue?: true;
  /** Validated initialization payload produced before privileged publication starts. */
  initialFiles?: Record<string, string>;
}
