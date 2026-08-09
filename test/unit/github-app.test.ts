import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  credentialsFile,
  githubAppUserToken,
  logout,
  readGitHubAppCredentials,
  storeGitHubAppCredentials,
} from "../../src/cli/auth.js";
import {
  AuthenticationError,
  credentialsFromTokenResponse,
  GITHUB_APP_CLIENT_ID,
  requestDeviceCode,
  requestDeviceToken,
  validateGitHubAppUserToken,
} from "../../src/cli/github-app.js";
import { GITHUB_LOGIN_ACCESS_NOTICE } from "../../src/cli/login.js";
import { GitHubClient } from "../../src/shared/github.js";

describe.sequential("GitHub App CLI authentication", () => {
  let home: string;
  let oldHome: string | undefined;
  let oldToken: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-app-auth-"));
    oldHome = process.env.LAX_HOME;
    oldToken = process.env.LAX_GITHUB_APP_USER_TOKEN;
    process.env.LAX_HOME = home;
    delete process.env.LAX_GITHUB_APP_USER_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restore("LAX_HOME", oldHome);
    restore("LAX_GITHUB_APP_USER_TOKEN", oldToken);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("bundles the official GitHub App client id", () => {
    expect(GITHUB_APP_CLIENT_ID).toBe("Iv23lil5NgwdGZfM911w");
  });

  it("explains the CLI App access before device authorization", () => {
    // Printed above the code: a thing to read before authorizing, not after.
    const notice = GITHUB_LOGIN_ACCESS_NOTICE.join(" ");
    expect(notice).toContain("read your public GitHub profile");
    expect(notice).toContain("post issues and");
    expect(notice).toContain("comments to lax-archive/lax as you");
    expect(notice).toContain("cannot write repository contents");
    expect(notice).toContain("lax-database or lax-website");
  });

  it("accepts only GitHub App user access tokens", async () => {
    expect(validateGitHubAppUserToken("ghu_example-token")).toBe("ghu_example-token");
    for (const token of ["gho_oauth-token", "github_pat_personal-token", "plain-secret"]) {
      expect(() => validateGitHubAppUserToken(token)).toThrow("GitHub App user access token");
      expect(() => GitHubClient.forGitHubAppUser(token)).toThrow("GitHub App user access token");
    }
    process.env.LAX_GITHUB_APP_USER_TOKEN = "ghu_environment-token";
    await expect(githubAppUserToken()).resolves.toBe("ghu_environment-token");
  });

  it("binds device authorization to the Lax repository id", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 }),
    );
    await requestDeviceToken("Iv-test-client", "device-code", 42);
    const body = request.mock.calls[0]![1]?.body?.toString();
    expect(body).toContain("client_id=Iv-test-client");
    expect(body).toContain("repository_id=42");
    await expect(requestDeviceToken("Iv-test-client", "device-code", 0)).rejects.toThrow(
      "repository id",
    );
  });

  it("stores expiring App credentials and their refresh token", () => {
    const credentials = credentialsFromTokenResponse(
      {
        access_token: "ghu_access-token",
        expires_in: 28_800,
        refresh_token: "ghr_refresh-token",
        refresh_token_expires_in: 15_897_600,
        scope: "",
        token_type: "bearer",
      },
      "Iv-test-client",
      1_000,
    );
    expect(credentials).toMatchObject({
      kind: "github-app-user",
      expiresAt: 28_801_000,
      refreshTokenExpiresAt: 15_897_601_000,
    });
    storeGitHubAppCredentials(credentials);
    expect(readGitHubAppCredentials()).toEqual(credentials);
  });

  it("rotates an expired App user token with its refresh token", async () => {
    storeGitHubAppCredentials({
      version: 1,
      kind: "github-app-user",
      clientId: GITHUB_APP_CLIENT_ID,
      accessToken: "ghu_expired-token",
      expiresAt: 1,
      refreshToken: "ghr_old-refresh",
      refreshTokenExpiresAt: Date.now() + 120_000,
    });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ghu_rotated-token",
          expires_in: 28_800,
          refresh_token: "ghr_rotated-refresh",
          refresh_token_expires_in: 15_897_600,
          scope: "",
          token_type: "bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(githubAppUserToken()).resolves.toBe("ghu_rotated-token");
    expect(request).toHaveBeenCalledOnce();
    const body = request.mock.calls[0]![1]?.body;
    expect(body?.toString()).toContain("grant_type=refresh_token");
    expect(readGitHubAppCredentials().refreshToken).toBe("ghr_rotated-refresh");
  });

  it("rejects a stored login issued by another GitHub App", async () => {
    storeGitHubAppCredentials({
      version: 1,
      kind: "github-app-user",
      clientId: "Iv-another-app",
      accessToken: "ghu_other-app-token",
    });

    await expect(githubAppUserToken()).rejects.toThrow("different GitHub App");
  });

  /** An expired access token with a refresh token still in date: the state
   * every login reaches eight hours after `lax login`, and the one that sends
   * the CLI to the renewal endpoint. */
  function storeExpiredLogin(): void {
    storeGitHubAppCredentials({
      version: 1,
      kind: "github-app-user",
      clientId: GITHUB_APP_CLIENT_ID,
      accessToken: "ghu_expired-token",
      expiresAt: 1,
      refreshToken: "ghr_old-refresh",
      refreshTokenExpiresAt: Date.now() + 120_000,
    });
  }

  it("reports a refused renewal as the expired login it is", async () => {
    storeExpiredLogin();
    // GitHub answers the renewal grant with HTTP 200 and an error in the body:
    // it renews a user token only for a client that can present the App's
    // client secret, which a published CLI has nowhere to keep. So this is not
    // an outage to wait out — the login is over and `lax login` is the fix.
    // A fresh Response per call: a body can only be read once, and every
    // assertion below drives the whole path again.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          error: "incorrect_client_credentials",
          error_description: "The client_id and/or client_secret passed are incorrect.",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));

    await expect(githubAppUserToken()).rejects.toThrow(AuthenticationError);
    await expect(githubAppUserToken()).rejects.toThrow(/login expired/u);
    await expect(githubAppUserToken()).rejects.toThrow(/cannot renew it by itself/u);
    await expect(githubAppUserToken()).rejects.toThrow(/lax login/u);
  });

  it("does not blame a GitHub outage for a renewal that failed", async () => {
    storeExpiredLogin();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 500 }));

    // The author saw `GitHub's authorization service is failing — that is
    // GitHub's side, not your login; try again shortly`, and went off to wait
    // for an outage that was not happening. Renewal is not something the CLI
    // can do, so a failure here is always the login, whatever the status.
    await expect(githubAppUserToken()).rejects.toThrow(AuthenticationError);
    await expect(githubAppUserToken()).rejects.toThrow(/could not be renewed \(HTTP 500\)/u);
    await expect(githubAppUserToken()).rejects.not.toThrow(/not your login/u);
    await expect(githubAppUserToken()).rejects.toThrow(/lax login/u);
  });

  it("quotes GitHub's own words when it refuses to authorize", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "device_flow_disabled" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );

    // Printing our guess instead of the answer GitHub already gave is how a
    // refused credential comes to read as a mystery.
    await expect(requestDeviceCode(GITHUB_APP_CLIENT_ID)).rejects.toThrow(/device_flow_disabled/u);
  });

  it("reports a missing or foreign login as an authentication failure", async () => {
    await expect(githubAppUserToken()).rejects.toThrow(AuthenticationError);
    storeGitHubAppCredentials({
      version: 1,
      kind: "github-app-user",
      clientId: "Iv-another-app",
      accessToken: "ghu_other-app-token",
    });
    await expect(githubAppUserToken()).rejects.toThrow(AuthenticationError);
  });

  it("revokes the stored access and refresh tokens before logging out", async () => {
    storeGitHubAppCredentials({
      version: 1,
      kind: "github-app-user",
      clientId: "Iv-test-client",
      accessToken: "ghu_access-token",
      expiresAt: Date.now() + 120_000,
      refreshToken: "ghr_refresh-token",
      refreshTokenExpiresAt: Date.now() + 240_000,
    });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));

    await expect(logout()).resolves.toBe(true);

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe("https://api.github.com/credentials/revoke");
    const options = request.mock.calls[0]![1];
    expect(options?.method).toBe("POST");
    expect((options?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(options?.body))).toEqual({
      credentials: ["ghu_access-token", "ghr_refresh-token"],
    });
    expect(fs.existsSync(credentialsFile())).toBe(false);
  });

  it("keeps the stored login when GitHub does not accept revocation", async () => {
    storeGitHubAppCredentials({
      version: 1,
      kind: "github-app-user",
      clientId: "Iv-test-client",
      accessToken: "ghu_access-token",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    await expect(logout()).rejects.toThrow("credential revocation failed");
    expect(fs.existsSync(credentialsFile())).toBe(true);
  });

  it("does not contact GitHub when there is no stored login", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    await expect(logout()).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("streams release assets only to GitHub's upload host with bearer authentication", async () => {
    const filename = path.join(home, "capture.tar");
    fs.writeFileSync(filename, "capture bytes", "utf8");
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe(
        "https://uploads.github.com/repos/lax-archive/lax-database/releases/1/assets?name=capture.tar",
      );
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer installation-token");
      expect((init?.headers as Record<string, string>)["content-length"]).toBe("13");
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      expect(bytes.toString("utf8")).toBe("capture bytes");
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    });
    const client = new GitHubClient("installation-token");
    await expect(client.uploadReleaseAsset<{ id: number }>(
      "https://uploads.github.com/repos/lax-archive/lax-database/releases/1/assets{?name,label}",
      filename,
      "capture.tar",
    )).resolves.toEqual({ id: 1 });
    await expect(client.uploadReleaseAsset(
      "https://example.com/assets{?name,label}",
      filename,
      "capture.tar",
    )).rejects.toThrow("not an allowed HTTPS endpoint");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects legacy OAuth/PAT credential files and OAuth token responses", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "credentials.json"),
      `${JSON.stringify({ githubToken: "github_pat_legacy" })}\n`,
    );
    expect(() => readGitHubAppCredentials()).toThrow("not a GitHub App user login");
    expect(() =>
      credentialsFromTokenResponse(
        { access_token: "gho_oauth", scope: "", token_type: "bearer" },
        "Iv-test-client",
      ),
    ).toThrow("GitHub App user access token");
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
