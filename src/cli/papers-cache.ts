// The serve-side blob caches of the paper layer (paper-plan.md "CLI",
// paper-web-plan.md "CLI"): a database submission records its compiled PDF
// and derived reflow bundle as digest-addressed ghcr blobs, and `lax serve`
// resolves them through `~/.lax/papers/<digest>.pdf` and
// `~/.lax/bundles/<digest>.tar`, filled on demand with the same anonymous
// pull the sandbox's download-capture tool and the website's papers:fetch
// use. Everything downloaded is verified against the recorded digest before
// it enters the cache, and every failure — offline, a refusal, tampered
// bytes — resolves to `undefined` so the preview renders the page without
// that file instead of dying: local previews degrade, they never block.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { laxHome } from "../shared/lax-home.js";
import * as ui from "./ui.js";

const REGISTRY = "https://ghcr.io";
/** Empirically verified 2026-08-05 (download-capture.mjs): ghcr blob GETs
 * answer HTTP 307 to signed URLs on this host, fetchable without auth. */
const REDIRECT_HOSTS = new Set(["ghcr.io", "pkg-containers.githubusercontent.com"]);
const MAX_REDIRECTS = 5;
/** The paper layer's cap (capture-store MAX_PAPER_BYTES); bundles share it. */
const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const TOKEN_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** A ghcr digest address exactly as the archive records it (`registryBlob`). */
const BLOB_REFERENCE =
  /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@sha256:([0-9a-f]{64})$/u;

/** Test seam (never set in production): LAX_CAPTURE_REGISTRY_URL points the
 * pull at a local fake registry (test/fake-ghcr.ts). Read per call, like
 * capture-store's registryOrigin, so a fake started after module import is
 * honored; unset means the real ghcr origin. */
function registryOrigin(): string {
  const value = process.env.LAX_CAPTURE_REGISTRY_URL;
  return value === undefined ? REGISTRY : new URL(value).origin;
}

export type PaperBlobKind = "paper" | "bundle";

export function paperCachePath(digest: string): string {
  return blobCachePath("paper", digest);
}

export function bundleCachePath(digest: string): string {
  return blobCachePath("bundle", digest);
}

function blobCachePath(kind: PaperBlobKind, digest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error(`${kind} digest is not sha256 hex`);
  return kind === "paper"
    ? path.join(laxHome(), "papers", `${digest}.pdf`)
    : path.join(laxHome(), "bundles", `${digest}.tar`);
}

/**
 * Resolve one recorded blob to its cache file, downloading on a miss. The
 * record's own digest is the authority: the reference must address exactly
 * that digest, and the downloaded bytes must hash to it before they land —
 * a rewritten reference or a tampered registry yields `undefined`, never a
 * poisoned cache. `undefined` for any failure; the caller renders without.
 */
export async function ensureCachedPaperBlob(
  kind: PaperBlobKind,
  digest: string,
  registryBlob: string,
): Promise<string | undefined> {
  let file: string;
  try {
    file = blobCachePath(kind, digest);
  } catch (error) {
    ui.verbose((error as Error).message);
    return undefined;
  }
  if (fs.existsSync(file)) return file;
  const reference = BLOB_REFERENCE.exec(registryBlob);
  if (reference === null || registryBlob.length > 512 || reference[2] !== digest) {
    ui.verbose(`recorded ${kind} blob is not a ghcr address of its own digest: ${registryBlob.slice(0, 120)}`);
    return undefined;
  }
  try {
    const bytes = await downloadBlob(reference[1]!, digest);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error("downloaded bytes do not match the recorded digest");
    }
    if (kind === "paper" && bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error("downloaded paper is not a PDF");
    }
    if (kind === "bundle" && bytes.subarray(257, 262).toString("latin1") !== "ustar") {
      throw new Error("downloaded bundle is not a ustar archive");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.part`;
    fs.writeFileSync(temporary, bytes, { mode: 0o644 });
    fs.renameSync(temporary, file);
    return file;
  } catch (error) {
    ui.verbose(
      `could not fetch the ${kind === "paper" ? "paper" : "web bundle"} ` +
        `${digest.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Anonymous pull of one public blob: pull token, manual bounded redirects
 * that never carry the token off the registry, and the 25 MiB cap. */
async function downloadBlob(repository: string, digest: string): Promise<Buffer> {
  const registry = registryOrigin();
  const scope = `repository:${repository}:pull`;
  // Public packages hand out pull tokens anonymously; no credential is sent.
  const tokenResponse = await fetch(
    `${registry}/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`,
    { signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) },
  );
  if (tokenResponse.status !== 200) {
    throw new Error(`ghcr token request failed with HTTP ${tokenResponse.status}`);
  }
  let token: unknown;
  try {
    token = (JSON.parse(await tokenResponse.text()) as { token?: unknown }).token;
  } catch {
    throw new Error("ghcr token response is not JSON");
  }
  if (typeof token !== "string" || token === "" || /[\s"\\]/u.test(token)) {
    throw new Error("ghcr token response is malformed");
  }

  let url = new URL(`${registry}/v2/${repository}/blobs/sha256:${digest}`);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    // The bearer token goes only to the registry itself; redirect targets
    // are pre-signed URLs that must never see it.
    const headers: Record<string, string> =
      url.origin === registry ? { authorization: `Bearer ${token}` } : {};
    response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (location === null || redirects === MAX_REDIRECTS) {
      throw new Error("blob download has an invalid redirect chain");
    }
    url = new URL(location, url);
    const allowed =
      url.origin === registry ||
      (url.protocol === "https:" && REDIRECT_HOSTS.has(url.hostname) && !url.username && !url.password);
    if (!allowed) throw new Error("blob redirect leaves the allowed public locations");
  }
  if (response === undefined || !response.ok) {
    throw new Error(`blob download failed with HTTP ${response?.status ?? "?"}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BLOB_BYTES) throw new Error(`blob exceeds ${MAX_BLOB_BYTES} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BLOB_BYTES) throw new Error(`blob exceeds ${MAX_BLOB_BYTES} bytes`);
  return bytes;
}
