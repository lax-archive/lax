import { githubApiBase, githubOauthBase } from "../shared/constants.js";

export const GITHUB_APP_CLIENT_ID = "Iv23lil5NgwdGZfM911w";

/**
 * The CLI could not authenticate: no login, an unusable one, or GitHub's
 * authorization endpoint refusing to answer. Its defining property for callers
 * is *when* it happens — always before a command comment is posted — so a
 * command that fails with one has sent nothing and started nothing.
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubAppCredentials {
  version: 1;
  kind: "github-app-user";
  clientId: string;
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export function validateGitHubAppUserToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("ghu_") ||
    value.length > 512 ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new AuthenticationError(
      "GitHub credential is not a GitHub App user access token (expected ghu_ prefix)",
    );
  }
  return value;
}

export function credentialsFromTokenResponse(
  value: TokenResponse,
  clientId: string,
  now = Date.now(),
): GitHubAppCredentials {
  if (value.error !== undefined) {
    throw new Error(
      typeof value.error_description === "string"
        ? value.error_description
        : typeof value.error === "string"
          ? value.error
          : "GitHub App authorization failed",
    );
  }
  const accessToken = validateGitHubAppUserToken(value.access_token);
  if (value.token_type !== "bearer" || value.scope !== "") {
    throw new Error("GitHub did not return a scoped GitHub App user access token");
  }
  if (value.expires_in === undefined) {
    return { version: 1, kind: "github-app-user", clientId, accessToken };
  }
  const expiresIn = positiveInteger(value.expires_in, "GitHub App access-token lifetime");
  const refreshToken = validateRefreshToken(value.refresh_token);
  const refreshExpiresIn = positiveInteger(
    value.refresh_token_expires_in,
    "GitHub App refresh-token lifetime",
  );
  return {
    version: 1,
    kind: "github-app-user",
    clientId,
    accessToken,
    expiresAt: now + expiresIn * 1_000,
    refreshToken,
    refreshTokenExpiresAt: now + refreshExpiresIn * 1_000,
  };
}

export async function requestDeviceCode(clientId: string): Promise<DeviceCode> {
  const value = await formRequest<Record<string, unknown>>(`${githubOauthBase()}/login/device/code`, {
    client_id: clientId,
  });
  if (
    typeof value.device_code !== "string" ||
    typeof value.user_code !== "string" ||
    typeof value.verification_uri !== "string"
  ) throw new Error("GitHub returned a malformed device authorization response");
  return {
    device_code: value.device_code,
    user_code: value.user_code,
    verification_uri: value.verification_uri,
    expires_in: positiveInteger(value.expires_in, "device-code lifetime"),
    interval: positiveInteger(value.interval, "device-code polling interval"),
  };
}

export async function requestDeviceToken(
  clientId: string,
  deviceCode: string,
  repositoryId: number,
): Promise<TokenResponse> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("the Lax GitHub repository id is invalid");
  }
  return formRequest<TokenResponse>(`${githubOauthBase()}/login/oauth/access_token`, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    repository_id: String(repositoryId),
  });
}

export async function refreshGitHubAppCredentials(
  credentials: GitHubAppCredentials,
): Promise<GitHubAppCredentials> {
  if (credentials.refreshToken === undefined) {
    throw new AuthenticationError("GitHub App login has expired; run `lax login` again");
  }
  let response: TokenResponse;
  try {
    response = await formRequest<TokenResponse>(`${githubOauthBase()}/login/oauth/access_token`, {
      client_id: credentials.clientId,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    });
  } catch (error) {
    // A bare status here reads as a Lax bug. Name the thing that failed — the
    // stored login being renewed — and the command that repairs it.
    throw new AuthenticationError(
      `could not refresh your stored GitHub login: ${(error as Error).message}; ` +
        "run `lax login` if it keeps failing",
    );
  }
  try {
    return credentialsFromTokenResponse(response, credentials.clientId);
  } catch (error) {
    throw new AuthenticationError(
      `could not refresh the GitHub App login: ${(error as Error).message}; run \`lax login\` again`,
    );
  }
}

export async function revokeGitHubAppCredentials(
  credentials: GitHubAppCredentials,
): Promise<void> {
  const tokens = [
    validateGitHubAppUserToken(credentials.accessToken),
    ...(credentials.refreshToken === undefined
      ? []
      : [validateRefreshToken(credentials.refreshToken)]),
  ];
  let response: Response;
  try {
    response = await fetch(`${githubApiBase()}/credentials/revoke`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ credentials: tokens }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`could not revoke the GitHub App login: ${(error as Error).message}`);
  }
  if (response.status !== 202) {
    throw new Error(`GitHub credential revocation failed with HTTP ${response.status}`);
  }
}

function validateRefreshToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("ghr_") ||
    value.length > 512 ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) throw new Error("GitHub returned a malformed App refresh token");
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

async function formRequest<T>(url: string, values: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AuthenticationError(`could not reach GitHub to authorize: ${(error as Error).message}`);
  }
  if (!response.ok) throw new AuthenticationError(authorizationFailure(response.status));
  return (await response.json()) as T;
}

/**
 * A 5xx from GitHub's authorization endpoint is GitHub's outage, not a bad
 * login, and logging in again cannot fix it — so say which of the two it is
 * rather than printing the bare status the author has to interpret.
 */
function authorizationFailure(status: number): string {
  if (status >= 500) {
    return `GitHub's authorization service is failing (HTTP ${status}) — that is GitHub's side, not your login; try again shortly`;
  }
  if (status === 429) {
    return "GitHub rate-limited the authorization request (HTTP 429); try again shortly";
  }
  return `GitHub refused the authorization request (HTTP ${status})`;
}
