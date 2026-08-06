// A local stand-in for ghcr.io's OCI distribution API, reachable through the
// LAX_CAPTURE_REGISTRY_URL test seam (never set in production — see
// src/shared/capture-store.ts). One server plays every registry role the
// capture path uses, on both sides:
//
// - publisher (GhcrCaptureStore.promote): token exchange (Basic auth),
//   HEAD blob by digest, POST upload session, PUT upload by digest,
//   PUT manifest by tag;
// - consumer: anonymous pull token, GET blob by digest (served directly —
//   the real ghcr's 307 redirect to a signed host is an optimization a
//   consumer treats as optional);
// - plus HEAD/GET manifests by tag or digest for completeness.
//
// In-memory, request-recording, seedable: tests may pre-seed `state.blobs`
// or overwrite an entry with corrupted bytes to model a tampered registry.
//
// Test-only infrastructure: never import this from src/.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";

export interface RecordedRegistryRequest {
  method: string;
  path: string;
  /** Raw `authorization` header, if any. */
  authorization?: string;
}

export interface FakeGhcrState {
  /** Stored blobs by `sha256:<hex>` digest; corrupt an entry to tamper. */
  blobs: Map<string, Buffer>;
  /** Manifests by tag and by `sha256:<hex>` digest of their bytes. */
  manifests: Map<string, { mediaType: string; body: Buffer }>;
}

export interface FakeGhcr {
  url: string;
  requests: RecordedRegistryRequest[];
  state: FakeGhcrState;
  /** The env pointing a subprocess (or per-call seam read) at this fake. */
  env(): { LAX_CAPTURE_REGISTRY_URL: string };
  close(): Promise<void>;
}

const TOKEN = "fake-registry-token";

export async function startFakeGhcr(): Promise<FakeGhcr> {
  const requests: RecordedRegistryRequest[] = [];
  const state: FakeGhcrState = { blobs: new Map(), manifests: new Map() };
  let nextUpload = 1;
  const uploads = new Set<string>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://fake");
      requests.push({
        method,
        path: req.url ?? "/",
        ...(req.headers.authorization === undefined
          ? {}
          : { authorization: req.headers.authorization }),
      });

      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };

      if (method === "GET" && url.pathname === "/token") {
        return json(200, { token: TOKEN });
      }

      const blob = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/u.exec(url.pathname);
      if (blob !== null && (method === "HEAD" || method === "GET")) {
        const stored = state.blobs.get(blob[2]!);
        if (stored === undefined) return json(404, { errors: [{ code: "BLOB_UNKNOWN" }] });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(stored.length),
        });
        return res.end(method === "GET" ? stored : undefined);
      }

      const session = /^\/v2\/(.+)\/blobs\/uploads\/$/u.exec(url.pathname);
      if (session !== null && method === "POST") {
        const id = String(nextUpload++);
        uploads.add(id);
        res.writeHead(202, { location: `/v2/${session[1]}/blobs/uploads/${id}` });
        return res.end();
      }

      const upload = /^\/v2\/(.+)\/blobs\/uploads\/([0-9]+)$/u.exec(url.pathname);
      if (upload !== null && method === "PUT") {
        const digest = url.searchParams.get("digest");
        if (!uploads.delete(upload[2]!) || digest === null) {
          return json(400, { errors: [{ code: "BLOB_UPLOAD_INVALID" }] });
        }
        if (`sha256:${createHash("sha256").update(body).digest("hex")}` !== digest) {
          return json(400, { errors: [{ code: "DIGEST_INVALID" }] });
        }
        state.blobs.set(digest, body);
        res.writeHead(201, { "docker-content-digest": digest });
        return res.end();
      }

      const manifest = /^\/v2\/(.+)\/manifests\/([^/]+)$/u.exec(url.pathname);
      if (manifest !== null && method === "PUT") {
        const mediaType = req.headers["content-type"] ?? "application/octet-stream";
        const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
        state.manifests.set(manifest[2]!, { mediaType, body });
        state.manifests.set(digest, { mediaType, body });
        res.writeHead(201, { "docker-content-digest": digest });
        return res.end();
      }
      if (manifest !== null && (method === "HEAD" || method === "GET")) {
        const stored = state.manifests.get(manifest[2]!);
        if (stored === undefined) return json(404, { errors: [{ code: "MANIFEST_UNKNOWN" }] });
        res.writeHead(200, {
          "content-type": stored.mediaType,
          "content-length": String(stored.body.length),
        });
        return res.end(method === "GET" ? stored.body : undefined);
      }

      return json(404, { errors: [{ code: "NOT_FOUND" }] });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("fake ghcr did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    requests,
    state,
    env: () => ({ LAX_CAPTURE_REGISTRY_URL: url }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}
