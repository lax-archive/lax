import fs from "node:fs";
import path from "node:path";
import { laxHome } from "../shared/lax-home.js";
import { GitHubClient, GitHubError } from "../shared/github.js";
import {
  AuthenticationError,
  GITHUB_APP_CLIENT_ID,
  type GitHubAppCredentials,
  refreshGitHubAppCredentials,
  revokeGitHubAppCredentials,
  validateGitHubAppUserToken,
} from "./github-app.js";

export { laxHome } from "../shared/lax-home.js";
export { AuthenticationError } from "./github-app.js";

export function credentialsFile(): string {
  return path.join(laxHome(), "credentials.json");
}

export async function githubAppUserToken(): Promise<string> {
  const environment = process.env.LAX_GITHUB_APP_USER_TOKEN;
  if (environment !== undefined && environment !== "") {
    return validateGitHubAppUserToken(environment);
  }
  const credentials = readGitHubAppCredentials();
  if (GITHUB_APP_CLIENT_ID !== credentials.clientId) {
    throw new AuthenticationError(
      "stored login belongs to a different GitHub App; run `lax login` again",
    );
  }
  if (credentials.expiresAt === undefined || credentials.expiresAt > Date.now() + 60_000) {
    return credentials.accessToken;
  }
  if (
    credentials.refreshTokenExpiresAt !== undefined &&
    credentials.refreshTokenExpiresAt <= Date.now() + 60_000
  ) throw new AuthenticationError("GitHub App refresh token has expired; run `lax login` again");
  const refreshed = await refreshGitHubAppCredentials(credentials);
  storeGitHubAppCredentials(refreshed);
  return refreshed.accessToken;
}

/**
 * Resolve the login and prove GitHub still honours it, returning the handle.
 *
 * Commands call this *first*, before a local build or a typed confirmation:
 * every one of them ends in a write to the control issue, so a login that
 * cannot authenticate makes the minutes of Lean that precede it wasted work.
 * The `GET /user` round trip is what the stored credentials cannot tell us —
 * a token the author revoked on github.com still reads back as well-formed.
 */
export async function ensureLoggedIn(): Promise<string> {
  const token = await githubAppUserToken();
  try {
    const user = await GitHubClient.forGitHubAppUser(token).request<{ login: string }>(
      "GET",
      "/user",
      undefined,
      { timeoutMs: 10_000 },
    );
    return user.login;
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 401 || error.status === 403)) {
      throw new AuthenticationError(
        `GitHub rejected the stored login (HTTP ${error.status}); run \`lax login\` again`,
      );
    }
    throw new AuthenticationError(
      `could not verify the GitHub login: ${(error as Error).message}`,
    );
  }
}

export function storeGitHubAppCredentials(credentials: GitHubAppCredentials): void {
  validateCredentials(credentials);
  fs.mkdirSync(laxHome(), { recursive: true, mode: 0o700 });
  const target = credentialsFile();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export async function logout(): Promise<boolean> {
  if (!fs.existsSync(credentialsFile())) return false;
  const credentials = readGitHubAppCredentials();
  await revokeGitHubAppCredentials(credentials);
  fs.rmSync(credentialsFile());
  return true;
}

export function readGitHubAppCredentials(): GitHubAppCredentials {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(credentialsFile(), "utf8")) as unknown;
  } catch {
    throw new AuthenticationError("no GitHub App login found; run `lax login`");
  }
  return validateCredentials(value);
}

function validateCredentials(value: unknown): GitHubAppCredentials {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthenticationError("stored GitHub App login is malformed; run `lax login` again");
  }
  const item = value as Record<string, unknown>;
  if ("githubToken" in item) {
    throw new AuthenticationError("stored login is not a GitHub App user login; run `lax login` again");
  }
  const allowed = new Set([
    "version",
    "kind",
    "clientId",
    "accessToken",
    "expiresAt",
    "refreshToken",
    "refreshTokenExpiresAt",
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) {
    throw new AuthenticationError("stored GitHub App login is malformed; run `lax login` again");
  }
  if (
    item.version !== 1 ||
    item.kind !== "github-app-user" ||
    typeof item.clientId !== "string" ||
    !/^[A-Za-z0-9_.-]{1,200}$/u.test(item.clientId)
  ) throw new AuthenticationError("stored login is not a GitHub App user login; run `lax login` again");
  const accessToken = validateGitHubAppUserToken(item.accessToken);
  const optionalTime = (key: "expiresAt" | "refreshTokenExpiresAt"): number | undefined => {
    const entry = item[key];
    if (entry === undefined) return undefined;
    if (!Number.isSafeInteger(entry) || (entry as number) <= 0) {
      throw new AuthenticationError("stored GitHub App login is malformed; run `lax login` again");
    }
    return entry as number;
  };
  const expiresAt = optionalTime("expiresAt");
  const refreshTokenExpiresAt = optionalTime("refreshTokenExpiresAt");
  const refreshTokenValid =
    typeof item.refreshToken === "string" &&
    item.refreshToken.startsWith("ghr_") &&
    item.refreshToken.length <= 512 &&
    /^[\x21-\x7e]+$/u.test(item.refreshToken);
  if (
    (expiresAt !== undefined || item.refreshToken !== undefined || refreshTokenExpiresAt !== undefined) &&
    (expiresAt === undefined || !refreshTokenValid || refreshTokenExpiresAt === undefined)
  ) throw new AuthenticationError("stored GitHub App login is malformed; run `lax login` again");
  return {
    version: 1,
    kind: "github-app-user",
    clientId: item.clientId,
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(typeof item.refreshToken === "string" ? { refreshToken: item.refreshToken } : {}),
    ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
  };
}
