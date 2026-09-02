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
// refresh-token grants), `GET /user`, `POST /credentials/revoke`, `GET
// /repos/:owner/:repo/issues` (backed by the seedable `state.issues`, which
// `lax doctor` lists), issue comments (`POST`/`GET`
// /repos/:owner/:repo/issues/:n/comments, backed by `state.issueComments`;
// `state.onComment` lets a test play the control-plane bot and answer a
// posted command, e.g. with a refusal carrying the result marker), workflow
// runs (`GET /repos/:owner/:repo/actions/runs/:id[/jobs]`, backed by
// `state.actionsRuns`, which is what `follow`/`lax submit --resume` poll once
// a comment's hidden marker names a run), and that run's artifacts (`GET
// .../actions/runs/:id/artifacts` plus `GET .../actions/artifacts/:id/zip`,
// backed by `state.actionsArtifacts`; `artifactZip()` builds a real zip, and
// the download answers a redirect to an unauthenticated blob path exactly as
// GitHub does). Stage 5 (full author journey) grows this via `state` and new
// routes in `handle()`: issue creation/lookup and Releases.
//
// Test-only infrastructure: never import this from src/.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { zipSync } from "fflate";

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

export interface FakeIssueComment {
  id: number;
  body: string;
  user: { id: number; login: string; type: string };
}

export interface FakeActionsRun {
  status: string;
  conclusion: string | null;
  jobs: unknown[];
}

export interface FakeArtifact {
  id: number;
  name: string;
  expired?: boolean;
  /** Zip bytes served by the download route; see `artifactZip`. */
  zip: Uint8Array;
  /** HTTP status for the download instead of the bytes, e.g. 403. */
  status?: number;
}

/** A real zip, as `actions/upload-artifact` would have produced it. */
export function artifactZip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, encoder.encode(content)]),
    ),
  );
}

export interface FakeGitHubState {
  /** Issues served by `GET /repos/:owner/:repo/issues`; seed or grow in tests. */
  issues: unknown[];
  /** Issue fields updated through `PATCH /repos/:owner/:repo/issues/:n`
   * (e.g. `lax delete` closing the tracking issue), by issue number. */
  issuePatches: Map<number, Record<string, unknown>>;
  /** Status for issue PATCHes instead of applying them, e.g. 403. */
  issuePatchStatus?: number;
  /** Tokens received by `POST /credentials/revoke`. */
  revoked: string[];
  /** Issue comments by issue number; seed bot comments or read back posts. */
  issueComments: Map<number, FakeIssueComment[]>;
  /** Workflow runs by run id, for the run correlation `follow`/`--resume` poll. */
  actionsRuns: Map<string, FakeActionsRun>;
  /** Artifacts by run id, for the validation report `lax submit` downloads. */
  actionsArtifacts: Map<string, FakeArtifact[]>;
  /** Status for the artifact *list*, e.g. 403 for a token without Actions read. */
  artifactListStatus?: number;
  /** Called after a comment is stored — a test's chance to answer as the bot. */
  onComment?: (issue: number, comment: FakeIssueComment) => void;
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
  const state: FakeGitHubState = {
    issues: [],
    issuePatches: new Map(),
    revoked: [],
    issueComments: new Map(),
    actionsRuns: new Map(),
    actionsArtifacts: new Map(),
  };
  let nextCommentId = 1000;

  const tokenResponse = (handle: string): Record<string, unknown> => ({
    access_token: tokenFor(handle),
    expires_in: 28_800,
    refresh_token: refreshTokenFor(handle),
    refresh_token_expires_in: 15_897_600,
    scope: "",
    token_type: "bearer",
  });

  const handle = (
    request: RecordedRequest,
  ): { status: number; body?: unknown; bytes?: Uint8Array; location?: string } => {
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

    const issuePatch = /^PATCH \/repos\/[^/]+\/[^/]+\/issues\/([1-9][0-9]*)$/u.exec(route);
    if (issuePatch !== null) {
      if (state.issuePatchStatus !== undefined && state.issuePatchStatus !== 200) {
        return { status: state.issuePatchStatus, body: { message: "Forbidden" } };
      }
      const bearer = /^Bearer (.+)$/u.exec(request.authorization ?? "")?.[1];
      if (![...users.keys()].some((h) => tokenFor(h) === bearer)) {
        return { status: 401, body: { message: "Bad credentials" } };
      }
      const issue = Number(issuePatch[1]);
      const fields = typeof request.body === "object" && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
      state.issuePatches.set(issue, { ...state.issuePatches.get(issue), ...fields });
      return { status: 200, body: { number: issue, ...fields } };
    }

    const comments = /^(GET|POST) \/repos\/[^/]+\/[^/]+\/issues\/([1-9][0-9]*)\/comments$/u.exec(route);
    if (comments !== null) {
      const issue = Number(comments[2]);
      const list = state.issueComments.get(issue) ?? [];
      if (comments[1] === "GET") return { status: 200, body: list };
      const bearer = /^Bearer (.+)$/u.exec(request.authorization ?? "")?.[1];
      const author = [...users.entries()].find(([h]) => tokenFor(h) === bearer);
      if (author === undefined) return { status: 401, body: { message: "Bad credentials" } };
      const body = (request.body as { body?: unknown })?.body;
      if (typeof body !== "string") return { status: 422, body: { message: "body is required" } };
      const comment: FakeIssueComment = {
        id: nextCommentId++,
        body,
        user: { id: author[1], login: author[0], type: "User" },
      };
      list.push(comment);
      state.issueComments.set(issue, list);
      state.onComment?.(issue, comment);
      return {
        status: 201,
        body: {
          id: comment.id,
          html_url: `https://github.com/lax-archive/lax/issues/${issue}#issuecomment-${comment.id}`,
        },
      };
    }

    const artifacts = /^GET \/repos\/[^/]+\/[^/]+\/actions\/runs\/([0-9]+)\/artifacts$/u.exec(route);
    if (artifacts !== null) {
      if (state.artifactListStatus !== undefined && state.artifactListStatus !== 200) {
        return { status: state.artifactListStatus, body: { message: "Forbidden" } };
      }
      const list = state.actionsArtifacts.get(artifacts[1]!) ?? [];
      return {
        status: 200,
        body: {
          total_count: list.length,
          artifacts: list.map((entry) => ({
            id: entry.id,
            name: entry.name,
            expired: entry.expired ?? false,
          })),
        },
      };
    }

    // GitHub answers the zip endpoint with a redirect to a signed blob URL on
    // another host, which carries no Authorization header; the fake keeps that
    // shape so the CLI's redirect handling is exercised, not assumed.
    const zip = /^GET \/repos\/[^/]+\/[^/]+\/actions\/artifacts\/([0-9]+)\/zip$/u.exec(route);
    if (zip !== null) {
      const found = [...state.actionsArtifacts.values()]
        .flat()
        .find((entry) => entry.id === Number(zip[1]));
      if (found === undefined) return { status: 404, body: { message: "Not Found" } };
      if (found.status !== undefined && found.status !== 200) {
        return { status: found.status, body: { message: "Forbidden" } };
      }
      return { status: 302, location: `/artifact-blobs/${found.id}` };
    }

    const blob = /^GET \/artifact-blobs\/([0-9]+)$/u.exec(route);
    if (blob !== null) {
      const found = [...state.actionsArtifacts.values()]
        .flat()
        .find((entry) => entry.id === Number(blob[1]));
      if (found === undefined) return { status: 404, body: { message: "Not Found" } };
      return { status: 200, bytes: found.zip };
    }

    const run = /^GET \/repos\/[^/]+\/[^/]+\/actions\/runs\/([0-9]+)(\/jobs)?$/u.exec(route);
    if (run !== null) {
      const record = state.actionsRuns.get(run[1]!);
      if (record === undefined) return { status: 404, body: { message: "Not Found" } };
      return run[2] === undefined
        ? { status: 200, body: { status: record.status, conclusion: record.conclusion } }
        : { status: 200, body: { jobs: record.jobs } };
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
      const { status, body, bytes, location } = handle(recorded);
      if (location !== undefined) {
        res.writeHead(status, { location });
        res.end();
      } else if (bytes !== undefined) {
        res.writeHead(status, { "content-type": "application/zip" });
        res.end(Buffer.from(bytes));
      } else if (body === undefined) {
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
