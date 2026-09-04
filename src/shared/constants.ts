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

/**
 * Archive maintainers, by immutable numeric GitHub id. `/lax admin` commands
 * are accepted only from these accounts: the route job checks the list, and
 * the trusted publisher checks it again, credential-free, before any token is
 * minted (trust rule 2). The list changes only by a reviewed commit to `main`
 * — the one branch the `lax-database-publish` environment deploys from — so
 * there is no org-membership lookup to spoof and nothing to configure.
 */
export const ADMIN_GITHUB_IDS: ReadonlySet<number> = new Set([
  2_657_497, // jan3er
]);

export const SUBMISSION_ID_PATTERN = /^lax-[1-9][0-9]*$/;
export const LEGACY_SUBMISSION_ID_PATTERN = /^Lax([1-9][0-9]*)$/;
/** IDs allocated locally by current CLIs before an issue binding exists. */
export const NEW_SUBMISSION_ID_PATTERN = /^lax-[1-9][0-9]{5}$/;

/**
 * Complete lax-database id snapshot immediately before locally allocated ids
 * and manifest issue bindings were introduced (database commit
 * 6e823d989aa4944dcd29f91fd1d01f3fca4f0919).
 *
 * This set is deliberately closed. It is the migration authority that lets a
 * current CLI add the historical issue binding to an old local manifest; later
 * issue-derived ids created by an old CLI are handled only through their exact
 * historical issue body and are not silently grandfathered forever.
 */
export const LEGACY_SUBMISSION_IDS: ReadonlySet<string> = new Set([
  "lax-3",
  "lax-4",
  "lax-5",
  "lax-6",
  "lax-8",
  "lax-9",
  "lax-10",
  "lax-11",
  "lax-12",
  "lax-13",
  "lax-14",
  "lax-15",
  "lax-16",
  "lax-17",
  "lax-18",
  "lax-41",
  "lax-46",
  "lax-47",
  "lax-48",
  "lax-49",
  "lax-50",
  "lax-51",
  "lax-52",
  "lax-53",
  "lax-54",
  "lax-55",
  "lax-56",
  "lax-57",
  "lax-58",
  "lax-59",
  "lax-60",
  "lax-61",
  "lax-62",
  "lax-65",
  "lax-66",
  "lax-67",
]);

/**
 * The id carried by scaffolds from the released opt-in offline-init era.
 *
 * GitHub numbers issues from 1, so `lax-0` can never name a record: it is the
 * one id the local pipeline accepts and every archive path refuses. Keeping it
 * out of `SUBMISSION_ID_PATTERN` is what makes that refusal the default —
 * accepting the placeholder is opt-in, one call site at a time.
 */
export const PLACEHOLDER_SUBMISSION_ID = "lax-0";
export const PLACEHOLDER_SUBMISSION_ID_PATTERN = /^(?:lax-0|Lax0)$/;
/** Historical companion constant — the one number GitHub never issues. */
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
