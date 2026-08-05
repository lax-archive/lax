// Anonymous, digest-addressed pull of one dependency capture blob from ghcr.
//
//   node download-capture.mjs ghcr.io/<repository>@sha256:<digest> /abs/dest
//
// Consumers never fetch a capture by tag: the reference comes from the
// dependency's database record and its digest is verified by the trusted
// caller (captures/materialize.ts hashes the downloaded bytes against the
// recorded digest, then verifies the per-file inventory after extraction).
// This tool enforces only the transport rules: allowlisted public HTTPS
// hosts, an anonymous pull token (the validation job holds no registry
// credential), bounded redirects, and the 2 GiB size cap.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const REGISTRY_HOST = "ghcr.io";
// Empirically verified 2026-08-05: ghcr blob GETs answer HTTP 307 to signed
// URLs on pkg-containers.githubusercontent.com, fetchable without auth.
const allowedHosts = new Set([REGISTRY_HOST, "pkg-containers.githubusercontent.com"]);
const limit = 2 * 1024 * 1024 * 1024;

const [reference, destination] = process.argv.slice(2);
if (reference === undefined || destination === undefined || !path.isAbsolute(destination)) process.exit(2);
const match = /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@(sha256:[0-9a-f]{64})$/u.exec(reference);
if (match === null || reference.length > 512) {
  console.error("capture reference is not a ghcr digest address");
  process.exit(2);
}
const [, repository, digest] = match;

// Public packages hand out pull tokens anonymously; no credential is sent.
const tokenResponse = await fetch(
  `https://${REGISTRY_HOST}/token?service=${REGISTRY_HOST}&scope=${encodeURIComponent(`repository:${repository}:pull`)}`,
  { signal: AbortSignal.timeout(60_000) },
);
if (tokenResponse.status !== 200) {
  console.error(`ghcr token request failed with HTTP ${tokenResponse.status}`);
  process.exit(1);
}
let token;
try {
  token = JSON.parse(await tokenResponse.text()).token;
} catch {
  token = undefined;
}
if (typeof token !== "string" || token === "" || /[\s"\\]/u.test(token)) {
  console.error("ghcr token response is malformed");
  process.exit(1);
}

await mkdir(path.dirname(destination), { recursive: true });
let url = new URL(`https://${REGISTRY_HOST}/v2/${repository}/blobs/${digest}`);
let response;
for (let redirects = 0; redirects <= 5; redirects += 1) {
  // The bearer token goes only to the registry itself; redirect targets are
  // pre-signed URLs that must never see it.
  const headers = url.hostname === REGISTRY_HOST ? { authorization: `Bearer ${token}` } : {};
  response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) });
  if (![301, 302, 303, 307, 308].includes(response.status)) break;
  const location = response.headers.get("location");
  if (location === null || redirects === 5) {
    console.error("capture download has an invalid redirect chain");
    process.exit(1);
  }
  url = new URL(location, url);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password) {
    console.error("capture redirect leaves the allowed public HTTPS locations");
    process.exit(1);
  }
}
if (response === undefined) process.exit(1);
if (!response.ok || response.body === null) {
  console.error(`capture download failed with HTTP ${response.status}`);
  process.exit(1);
}
const length = Number(response.headers.get("content-length") ?? "0");
if (length > limit) {
  console.error("capture exceeds 2 GiB");
  process.exit(1);
}
let bytes = 0;
const counter = new Transform({
  transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new Error("capture exceeds 2 GiB") : null, chunk);
  },
});
await pipeline(
  Readable.fromWeb(response.body),
  counter,
  createWriteStream(destination, { flags: "wx", mode: 0o600 }),
);
