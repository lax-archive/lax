import { githubApiBase } from "./constants.js";
import fs from "node:fs";
import { Readable } from "node:stream";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubClient {
  constructor(
    private readonly token?: string,
    private readonly apiBase = githubApiBase(),
  ) {}

  static forGitHubAppUser(token: string, apiBase = githubApiBase()): GitHubClient {
    if (!token.startsWith("ghu_")) {
      throw new Error("CLI authentication requires a GitHub App user access token");
    }
    return new GitHubClient(token, apiBase);
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "lax-control-plane",
    };
    // GitHub App user, installation, and Actions tokens all use GitHub's
    // mandated Bearer HTTP scheme. CLI callers separately enforce a `ghu_`
    // App user token through forGitHubAppUser; arbitrary bearer credentials
    // never enter the CLI path.
    if (this.token !== undefined && this.token !== "") headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new Error(`GitHub request failed: ${(error as Error).message}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const detail =
        parsed !== null && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : response.statusText;
      throw new GitHubError(`GitHub API ${response.status}: ${detail}`, response.status, parsed);
    }
    return parsed as T;
  }

  async uploadReleaseAsset<T>(
    uploadUrl: string,
    filename: string,
    assetName: string,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const target = new URL(uploadUrl.replace(/\{.*$/u, ""));
    if (target.protocol !== "https:" || target.hostname !== "uploads.github.com") {
      throw new Error("GitHub release upload URL is not an allowed HTTPS endpoint");
    }
    target.searchParams.set("name", assetName);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile()) throw new Error("release asset must be a regular file");
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "content-type": "application/x-tar",
      "content-length": String(stat.size),
      "x-github-api-version": "2022-11-28",
      "user-agent": "lax-control-plane",
    };
    if (this.token !== undefined && this.token !== "") headers.authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      const body = Readable.toWeb(fs.createReadStream(filename)) as unknown as BodyInit;
      const init = {
        method: "POST",
        headers,
        body,
        duplex: "half",
        signal: AbortSignal.timeout(options.timeoutMs ?? 60 * 60_000),
      } as RequestInit & { duplex: "half" };
      response = await fetch(target, init);
    } catch (error) {
      throw new Error(`GitHub release upload failed: ${(error as Error).message}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const detail =
        parsed !== null && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : response.statusText;
      throw new GitHubError(`GitHub API ${response.status}: ${detail}`, response.status, parsed);
    }
    return parsed as T;
  }

  async paginate<T>(path: string, limit = 1_000): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; items.length < limit; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await this.request<T[]>("GET", `${path}${separator}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items.slice(0, limit);
  }
}

export function repositoryPath(repository: string): string {
  return `/repos/${repository}`;
}

export function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
