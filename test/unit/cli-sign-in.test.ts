import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lax submit` and its neighbours sign in for the author the first time they
// need an identity, so these pin the three situations where they must not:
// a token supplied by the environment, no terminal to authorize on, and a
// stored login that already works.

const stub = vi.hoisted(() => ({
  githubAppUserToken: vi.fn(async () => "ghu_stored"),
  requestDeviceCode: vi.fn(async () => {
    throw new Error("device flow reached");
  }),
}));

vi.mock("../../src/cli/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  githubAppUserToken: stub.githubAppUserToken,
}));
vi.mock("../../src/cli/github-app.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestDeviceCode: stub.requestDeviceCode,
}));

const { AuthenticationError } = await import("../../src/cli/github-app.js");
const { signInIfNeeded } = await import("../../src/cli/login.js");

const terminal = (present: boolean): void => {
  Object.defineProperty(process.stdin, "isTTY", { value: present, configurable: true });
};

describe("signing in when a command needs an identity", () => {
  const inherited = process.env.LAX_GITHUB_APP_USER_TOKEN;
  const inheritedTTY = process.stdin.isTTY;

  beforeEach(() => {
    delete process.env.LAX_GITHUB_APP_USER_TOKEN;
    terminal(true);
    stub.githubAppUserToken.mockReset();
    stub.requestDeviceCode.mockReset();
    stub.githubAppUserToken.mockResolvedValue("ghu_stored");
    stub.requestDeviceCode.mockRejectedValue(new Error("device flow reached"));
  });

  afterEach(() => {
    if (inherited === undefined) delete process.env.LAX_GITHUB_APP_USER_TOKEN;
    else process.env.LAX_GITHUB_APP_USER_TOKEN = inherited;
    terminal(inheritedTTY === true);
  });

  it("does nothing when the stored login can serve the command", async () => {
    await expect(signInIfNeeded()).resolves.toBeUndefined();
    expect(stub.requestDeviceCode).not.toHaveBeenCalled();
  });

  it("signs in when there is no login this machine can act with", async () => {
    stub.githubAppUserToken.mockRejectedValue(
      new AuthenticationError("no GitHub App login found; run `lax login`"),
    );
    await expect(signInIfNeeded()).rejects.toThrow("device flow reached");
  });

  it("leaves a script without a terminal to the command's own preflight", async () => {
    terminal(false);
    stub.githubAppUserToken.mockRejectedValue(new AuthenticationError("no GitHub App login found"));
    await expect(signInIfNeeded()).resolves.toBeUndefined();
    expect(stub.requestDeviceCode).not.toHaveBeenCalled();
  });

  it("never overrides a token the environment supplied", async () => {
    process.env.LAX_GITHUB_APP_USER_TOKEN = "ghu_from-the-environment";
    stub.githubAppUserToken.mockRejectedValue(new AuthenticationError("not a GitHub App user token"));
    await expect(signInIfNeeded()).resolves.toBeUndefined();
    expect(stub.requestDeviceCode).not.toHaveBeenCalled();
  });

  it("reports a failure that signing in would not fix", async () => {
    stub.githubAppUserToken.mockRejectedValue(new Error("EACCES: permission denied"));
    await expect(signInIfNeeded()).rejects.toThrow("EACCES");
    expect(stub.requestDeviceCode).not.toHaveBeenCalled();
  });
});
