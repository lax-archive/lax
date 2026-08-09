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
    response = await formRequest<TokenResponse>(
      `${githubOauthBase()}/login/oauth/access_token`,
      {
        client_id: credentials.clientId,
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
      },
      "renew",
    );
  } catch (error) {
    // A bare status here reads as a Lax bug. Name the thing that failed — the
    // stored login being renewed — and the command that repairs it.
    throw new AuthenticationError(`${(error as Error).message}; run \`lax login\` again`);
  }
  // A refusal to renew arrives as HTTP 200 with an error in the body, so the
  // status says nothing and only this branch can tell the author what happened.
  if (typeof response.error === "string") {
    throw new AuthenticationError(`${renewalFailure(response.error)}; run \`lax login\` again`);
  }
  try {
    return credentialsFromTokenResponse(response, credentials.clientId);
  } catch (error) {
    throw new AuthenticationError(
      `your GitHub login expired and could not be renewed: ${(error as Error).message}; ` +
        "run `lax login` again",
    );
  }
}

/**
 * Why GitHub would not renew the stored login, in the author's terms.
 *
 * `incorrect_client_credentials` is the one that matters: GitHub renews a user
 * access token only for a client that can present the App's *client secret*,
 * and a published CLI has nowhere to keep one — so this is not a transient
 * fault and not the author's mistake, it is the renewal never having been
 * available. `lax login` is the whole fix, which is why it is what the message
 * ends on rather than "try again shortly".
 */
function renewalFailure(error: string): string {
  switch (error) {
    case "incorrect_client_credentials":
      return "your GitHub login expired, and the CLI cannot renew it by itself";
    case "bad_refresh_token":
    case "expired_token":
      return "your GitHub login expired and its renewal token is no longer valid";
    default:
      return `your GitHub login expired and could not be renewed (${error})`;
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

async function formRequest<T>(
  url: string,
  values: Record<string, string>,
  what: "authorize" | "renew" = "authorize",
): Promise<T> {
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
  if (!response.ok) {
    throw new AuthenticationError(
      authorizationFailure(response.status, what, await errorDetail(response)),
    );
  }
  return (await response.json()) as T;
}

/**
 * GitHub usually explains itself in the body — `{"error":"bad_refresh_token"}`
 * — even when the status alone would leave us guessing. Guessing is exactly how
 * a credential GitHub will not honour comes to be reported as an outage, so its
 * own words go in the message whenever it left any.
 */
async function errorDetail(response: Response): Promise<string | undefined> {
  let body: string;
  try {
    body = (await response.text()).slice(0, 4_000);
  } catch {
    return undefined;
  }
  const read = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return read(parsed.error_description) ?? read(parsed.error);
  } catch {
    // The same endpoint answers in form encoding when asked to; anything else
    // (an HTML error page) has nothing worth quoting back.
    const form = new URLSearchParams(body);
    return read(form.get("error_description")) ?? read(form.get("error"));
  }
}

/**
 * What failed, in terms of the thing the author owns.
 *
 * A 5xx while *authorizing* is GitHub's outage and logging in again cannot fix
 * it. A 5xx while *renewing a stored login* is not the same claim: the CLI
 * cannot renew a GitHub App user token at all — GitHub wants the App's client
 * secret for that — so a failure there is the login being over, and `lax login`
 * is the fix. Blaming GitHub for it sends the author away to wait for an outage
 * that will not end.
 */
function authorizationFailure(
  status: number,
  what: "authorize" | "renew",
  detail?: string,
): string {
  const because = detail === undefined ? "" : `: ${detail}`;
  if (what === "renew") {
    return `your GitHub login expired and could not be renewed (HTTP ${status})${because}`;
  }
  if (status >= 500) {
    return (
      `GitHub's authorization service is failing (HTTP ${status})${because} — ` +
      "that is GitHub's side, not your login; try again shortly"
    );
  }
  if (status === 429) {
    return "GitHub rate-limited the authorization request (HTTP 429); try again shortly";
  }
  return `GitHub refused the authorization request (HTTP ${status})${because}`;
}
