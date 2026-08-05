// A local stand-in for github.com and api.github.com, reachable from CLI
// subprocesses through the LAX_GITHUB_API_URL/LAX_GITHUB_OAUTH_URL test seams
// (never set in production — see src/shared/constants.ts). Successor of old
// lax's in-test device-flow fake (test/cli.test.ts) and its LAX_FAKE_GITHUB
// user registry: users come from a "alice:1,bob:2"-style spec, and the GitHub
// App user token for handle h is `ghu_tok-h` (refresh token `ghr_refresh-h`)
// to match the ghu_/ghr_ shapes the CLI enforces.
//
// Endpoint surface today: the GitHub App device flow (`POST
// /login/device/code`, `POST /login/oauth/access_token` with device-code and
// refresh-token grants), `GET /user`, `POST /credentials/revoke`, and `GET
// /repos/:owner/:repo/issues` (backed by the seedable `state.issues`, which
// `lax doctor` lists). Stage 5 (full author journey) grows this via
// `state` and new routes in `handle()`: issue creation/lookup, issue
// comments, Actions runs, and Releases.
//
// Test-only infrastructure: never import this from src/.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";

export interface FakeGitHubOptions {
  /** `authorization_pending` responses before the device flow succeeds. */
  pendingPolls?: number;
  /** Handle registry, `"alice:1,bob:2"`; the first user approves the device flow. */
  users?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  /** Raw `authorization` header, if any. */
  authorization?: string;
  /** Parsed body: form bodies as key/value pairs, JSON bodies as parsed JSON. */
  body?: unknown;
}

export interface FakeGitHubState {
  /** Issues served by `GET /repos/:owner/:repo/issues`; seed or grow in tests. */
  issues: unknown[];
  /** Tokens received by `POST /credentials/revoke`. */
  revoked: string[];
}

export interface FakeGitHub {
  url: string;
  requests: RecordedRequest[];
  state: FakeGitHubState;
  /** The env pointing a CLI subprocess at this fake. */
  env(): { LAX_GITHUB_API_URL: string; LAX_GITHUB_OAUTH_URL: string };
  close(): Promise<void>;
}

export const FAKE_USER_CODE = "ABCD-1234";
const FAKE_DEVICE_CODE = "fake-device-code";

export function tokenFor(handle: string): string {
  return `ghu_tok-${handle}`;
}

export function refreshTokenFor(handle: string): string {
  return `ghr_refresh-${handle}`;
}

export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const users = parseUsers(options.users ?? "alice:1");
  const primary = [...users.keys()][0];
  if (primary === undefined) throw new Error("fake GitHub needs at least one user");
  let pendingPolls = options.pendingPolls ?? 1;
  const requests: RecordedRequest[] = [];
  const state: FakeGitHubState = { issues: [], revoked: [] };

  const tokenResponse = (handle: string): Record<string, unknown> => ({
    access_token: tokenFor(handle),
    expires_in: 28_800,
    refresh_token: refreshTokenFor(handle),
    refresh_token_expires_in: 15_897_600,
    scope: "",
    token_type: "bearer",
  });

  const handle = (request: RecordedRequest): { status: number; body?: unknown } => {
    const route = `${request.method} ${new URL(request.path, "http://fake").pathname}`;

    if (route === "POST /login/device/code") {
      return {
        status: 200,
        body: {
          device_code: FAKE_DEVICE_CODE,
          user_code: FAKE_USER_CODE,
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1,
        },
      };
    }

    if (route === "POST /login/oauth/access_token") {
      const form = request.body as Record<string, string>;
      if (form.grant_type === "refresh_token") {
        const owner = [...users.keys()].find((h) => refreshTokenFor(h) === form.refresh_token);
        return owner === undefined
          ? { status: 200, body: { error: "bad_refresh_token" } }
          : { status: 200, body: tokenResponse(owner) };
      }
      if (form.device_code !== FAKE_DEVICE_CODE) {
        return { status: 200, body: { error: "incorrect_device_code" } };
      }
      if (pendingPolls-- > 0) return { status: 200, body: { error: "authorization_pending" } };
      return { status: 200, body: tokenResponse(primary) };
    }

    if (route === "GET /user") {
      const bearer = /^Bearer (.+)$/u.exec(request.authorization ?? "")?.[1];
      const owner = [...users.entries()].find(([h]) => tokenFor(h) === bearer);
      if (owner === undefined) return { status: 401, body: { message: "Bad credentials" } };
      return { status: 200, body: { login: owner[0], id: owner[1] } };
    }

    if (route === "POST /credentials/revoke") {
      const body = request.body as { credentials?: unknown };
      if (Array.isArray(body?.credentials)) state.revoked.push(...(body.credentials as string[]));
      return { status: 202 };
    }

    if (/^GET \/repos\/[^/]+\/[^/]+\/issues$/u.test(route)) {
      return { status: 200, body: state.issues };
    }

    return { status: 404, body: { message: "Not Found" } };
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        ...(req.headers.authorization === undefined
          ? {}
          : { authorization: req.headers.authorization }),
        ...parseBody(Buffer.concat(chunks).toString("utf8"), req.headers["content-type"]),
      };
      requests.push(recorded);
      const { status, body } = handle(recorded);
      if (body === undefined) {
        res.writeHead(status);
        res.end();
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("fake GitHub did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    requests,
    state,
    env: () => ({ LAX_GITHUB_API_URL: url, LAX_GITHUB_OAUTH_URL: url }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

function parseUsers(spec: string): Map<string, number> {
  const users = new Map<string, number>();
  for (const part of spec.split(",")) {
    if (part === "") continue;
    const [handle, id] = part.split(":");
    if (handle === undefined || id === undefined || !Number.isInteger(Number(id))) {
      throw new Error(`malformed fake-GitHub user entry: ${part}`);
    }
    users.set(handle, Number(id));
  }
  return users;
}

function parseBody(text: string, contentType: string | undefined): { body?: unknown } {
  if (text === "") return {};
  if (contentType?.includes("application/x-www-form-urlencoded") === true) {
    return { body: Object.fromEntries(new URLSearchParams(text)) };
  }
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { body: text };
  }
}
