export const SPEC_VERSION = "1";

export const CONTROL_REPOSITORY =
  process.env.LAX_CONTROL_REPOSITORY ?? "lax-archive/lax";
export const CONTROL_REPOSITORY_ID = 1_312_595_743;
export const DATABASE_REPOSITORY =
  process.env.LAX_DATABASE_REPOSITORY ?? "lax-archive/lax-database";
export const WEBSITE_REPOSITORY =
  process.env.LAX_WEBSITE_REPOSITORY ?? "lax-archive/lax-website";

export const GITHUB_API_URL = process.env.LAX_GITHUB_API_URL ?? "https://api.github.com";
export const GITHUB_OAUTH_URL = process.env.LAX_GITHUB_OAUTH_URL ?? "https://github.com";
// Stable public identity used by GitHub-hosted Actions when GITHUB_TOKEN posts
// an issue comment. Replay markers from any other author are untrusted input.
export const GITHUB_ACTIONS_BOT_ID = 41_898_282;
export const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]";

export const SUBMISSION_ID_PATTERN = /^lax-[1-9][0-9]*$/;
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
