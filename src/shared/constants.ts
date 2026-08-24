export const SPEC_VERSION = "1";

export const CONTROL_REPOSITORY =
  process.env.LAX_CONTROL_REPOSITORY ?? "lax-archive/lax";
export const CONTROL_REPOSITORY_ID = 1_320_232_165;
export const DATABASE_REPOSITORY =
  process.env.LAX_DATABASE_REPOSITORY ?? "lax-archive/lax-database";
export const WEBSITE_REPOSITORY =
  process.env.LAX_WEBSITE_REPOSITORY ?? "lax-archive/lax-website";
// The public site. The CLI hands the author exactly one link — their own page —
// so it needs the base URL the Website is served from, not just its repository.
export const WEBSITE_BASE_URL = (
  process.env.LAX_WEBSITE_URL ?? "https://laxarchive.org"
).replace(/\/+$/, "");

/** The author's own page for a submission: the one link worth clicking. */
export function submissionUrl(id: string): string {
  return `${WEBSITE_BASE_URL}/${id}/`;
}
// Dependency captures are stored as digest-addressed OCI artifacts in this
// ghcr repository under the control repository's owner. Env-derivable like
// the repository constants above; ghcr repository paths are lowercase.
export const CAPTURES_REPOSITORY =
  process.env.LAX_CAPTURES_REPOSITORY ??
  `${splitRepository(CONTROL_REPOSITORY).owner.toLowerCase()}/lax-captures`;

// Test seams (never set in production): point GitHub's REST API and OAuth
// endpoints at local fakes. Late-bound per call so a subprocess-reachable
// fake server (test/fake-github.ts) can be started after module import.
export function githubApiBase(): string {
  return process.env.LAX_GITHUB_API_URL ?? "https://api.github.com";
}
export function githubOauthBase(): string {
  return process.env.LAX_GITHUB_OAUTH_URL ?? "https://github.com";
}
// Stable public identity used by GitHub-hosted Actions when GITHUB_TOKEN posts
// an issue comment. Replay markers from any other author are untrusted input.
export const GITHUB_ACTIONS_BOT_ID = 41_898_282;
export const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]";

export const SUBMISSION_ID_PATTERN = /^lax-[1-9][0-9]*$/;
export const LEGACY_SUBMISSION_ID_PATTERN = /^Lax([1-9][0-9]*)$/;

/**
 * The id an offline scaffold carries until the archive allocates a real one.
 *
 * GitHub numbers issues from 1, so `lax-0` can never name a record: it is the
 * one id the local pipeline accepts and every archive path refuses. Keeping it
 * out of `SUBMISSION_ID_PATTERN` is what makes that refusal the default —
 * accepting the placeholder is opt-in, one call site at a time.
 */
export const PLACEHOLDER_SUBMISSION_ID = "lax-0";
export const PLACEHOLDER_SUBMISSION_ID_PATTERN = /^(?:lax-0|Lax0)$/;
/** The issue number behind that id — the one number GitHub never issues. */
export const PLACEHOLDER_ISSUE_NUMBER = 0;

export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const HANDLE_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_OWNERS = 50;
export const MAX_FOLDER_BYTES = 512;
export const MAX_FOLDER_SEGMENTS = 32;

export function splitRepository(value: string): { owner: string; repository: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (match === null) throw new Error(`invalid GitHub repository name: ${value}`);
  return { owner: match[1]!, repository: match[2]! };
}
