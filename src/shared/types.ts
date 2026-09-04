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

/**
 * The closed command vocabulary. `admin: true` marks the maintainer form of a
 * verb (`/lax admin <verb>`), which the route job admits only from
 * ADMIN_GITHUB_IDS and which bypasses the owner, open-issue, and lifecycle
 * gates ordinary commands must pass. `revalidate` and `reset-draft` exist only
 * in that form; a revalidation's `source` is filled in by the route job from
 * the record itself, never read from the comment.
 */
export type ParsedCommand =
  | { action: "owners"; owners: GitHubIdentity[]; admin?: true }
  | ({ action: "submit" } & SourceLocation)
  | { action: "delete"; admin?: true }
  | { action: "register" }
  | { action: "revalidate"; admin: true; source?: SourceLocation }
  | { action: "reset-draft"; admin: true };

export const ADMIN_VERBS = ["revalidate", "delete", "reset-draft", "owners"] as const;
export type AdminVerb = (typeof ADMIN_VERBS)[number];

export function isAdminVerb(value: unknown): value is AdminVerb {
  return (ADMIN_VERBS as readonly unknown[]).includes(value);
}

export function isAdminCommand(command: ParsedCommand | undefined): boolean {
  return command !== undefined && "admin" in command && command.admin === true;
}

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
