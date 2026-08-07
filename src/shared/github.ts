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

  /**
   * A bounded binary GET. GitHub answers artifact downloads with a redirect to
   * a signed blob URL on a different host, so the hop is taken by hand with
   * `redirect: "manual"`: the credential is attached to the API request only,
   * and the signed URL — which carries its own authorization — is fetched
   * without it. (Standard fetch drops the header cross-origin anyway; doing it
   * explicitly makes the boundary visible and independent of that behaviour.)
   */
  async requestBinary(
    path: string,
    options: { timeoutMs?: number; maxBytes: number },
  ): Promise<Uint8Array> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "lax-control-plane",
    };
    if (this.token !== undefined && this.token !== "") headers.authorization = `Bearer ${this.token}`;
    const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}${path}`, { method: "GET", headers, redirect: "manual", signal });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        const target = new URL(location, `${this.apiBase}${path}`);
        if (target.protocol !== "https:" && target.protocol !== "http:") {
          throw new Error("download redirect is not an HTTP(S) URL");
        }
        response = await fetch(target, {
          method: "GET",
          headers: { "user-agent": "lax-control-plane" },
          redirect: "follow",
          signal,
        });
      }
    } catch (error) {
      throw new Error(`GitHub request failed: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new GitHubError(
        `GitHub API ${response.status}: ${response.statusText}`,
        response.status,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(declared) && declared > options.maxBytes) {
      throw new Error(`download exceeds ${options.maxBytes} bytes`);
    }
    return readBounded(response, options.maxBytes);
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

/** Read a response body, refusing it as soon as it passes the cap rather than
 * after buffering whatever the server chose to send. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`download exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
