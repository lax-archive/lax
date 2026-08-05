// Host-side dependency capture materialization: download each required
// submission's published artifact capture over HTTPS, verify it against the
// digests the pinned Archive snapshot declared, and unpack it read-only into
// the build's dependency root. The checks mirror the trusted container path
// (runtime/download-capture.mjs + extract-capture.mjs + captures/materialize):
// allowlisted GitHub release hosts only, bounded size, no links or special
// entries, per-file sha256 verification.

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ValidationLimits } from "../config.js";
import type { PublishedCapture, ResolvedDependency } from "../contracts.js";
import {
  capturesBySubmission,
  makeCapturedPackagesUsable,
  makeReadOnly,
  mapConcurrent,
  sha256File,
  verifyFiles,
} from "../captures/materialize.js";

const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;

/** Download, verify, and unpack every dependency capture under
 * `jobDir/dependencies/<id>`; returns submission id -> capture root. */
export async function materializeHostCaptures(
  dependencies: ResolvedDependency[],
  jobDir: string,
  limits: ValidationLimits,
): Promise<Map<string, string>> {
  const bySubmission = capturesBySubmission(dependencies, limits);
  const materialized = await mapConcurrent(
    [...bySubmission],
    4,
    async ([id, capture]): Promise<[string, string]> => {
      const base = path.join(jobDir, "dependencies", id);
      const archive = path.join(jobDir, "downloads", `${id}-${capture.digest}.tar`);
      fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
      try {
        await downloadCapture(capture, archive, limits);
        if (sha256File(archive) !== capture.digest)
          throw new Error(`capture archive digest mismatch for ${id}`);
        extractCapture(archive, base);
        verifyFiles(base, capture);
        makeCapturedPackagesUsable(base, (kind) => path.join(base, kind, "lib"));
        makeReadOnly(base);
        return [id, base];
      } finally {
        fs.rmSync(archive, { force: true });
      }
    },
  );
  return new Map(materialized);
}

async function downloadCapture(
  capture: PublishedCapture,
  destination: string,
  limits: ValidationLimits,
): Promise<void> {
  let url = allowedUrl(capture.downloadUrl, "capture URL");
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (location === null || redirects === 5)
      throw new Error("capture download has an invalid redirect chain");
    url = allowedUrl(new URL(location, url).toString(), "capture redirect");
  }
  if (response === undefined || !response.ok || response.body === null)
    throw new Error(`capture download failed with HTTP ${response?.status ?? "error"}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_CAPTURE_BYTES) throw new Error("capture exceeds 2 GiB");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_CAPTURE_BYTES ? new Error("capture exceeds 2 GiB") : null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    counter,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
}

function allowedUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password)
    throw new Error(`${label} leaves the allowed public HTTPS locations`);
  return url;
}

function extractCapture(archive: string, destination: string): void {
  const listing = spawnSync("tar", ["-tvf", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listing.status !== 0) throw new Error("capture is not a readable tar archive");
  for (const line of listing.stdout.split("\n").filter(Boolean)) {
    if (line[0] !== "-" && line[0] !== "d")
      throw new Error("capture contains a link or special filesystem entry");
  }
  const names = spawnSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (names.status !== 0) throw new Error("capture is not a readable tar archive");
  for (const entry of names.stdout.split("\n").filter(Boolean)) {
    const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
    if (
      path.posix.isAbsolute(entry) ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      entry.includes("\\")
    )
      throw new Error("capture contains an escaping path");
  }
  fs.mkdirSync(destination, { recursive: true });
  const extracted = spawnSync(
    "tar",
    ["--extract", "--file", archive, "--directory", destination, "--no-same-owner", "--no-same-permissions"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (extracted.status !== 0)
    throw new Error(extracted.stderr || "capture extraction failed");
}
