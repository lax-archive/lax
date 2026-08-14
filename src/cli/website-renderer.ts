import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { laxHome } from "./auth.js";

const DEFAULT_MANIFEST_URL = "https://laxarchive.org/_renderer/latest.json";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_RENDERER_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface RendererManifest {
  commit: string;
  tarball: string;
  sha256: string;
}

export function downloadedPageBuilderDirectory(): string {
  return path.join(
    laxHome(),
    "page-builder",
    "node_modules",
    "@lax-archive",
    "website",
  );
}

export function parseRendererManifest(value: unknown): RendererManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("website renderer manifest must be a JSON object");
  }
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.commit !== "string" || !/^[0-9a-f]{40}$/u.test(manifest.commit)) {
    throw new Error("website renderer manifest has an invalid commit");
  }
  if (manifest.tarball !== `${manifest.commit}.tgz`) {
    throw new Error("website renderer manifest has an invalid tarball name");
  }
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.sha256)) {
    throw new Error("website renderer manifest has an invalid SHA-256 digest");
  }
  return manifest as unknown as RendererManifest;
}

/** Download and replace the optional current Website renderer used by `lax serve`. */
export async function updateWebsiteRenderer(): Promise<void> {
  const manifestUrl = new URL(
    process.env.LAX_WEBSITE_RENDERER_MANIFEST_URL ?? DEFAULT_MANIFEST_URL,
  );
  const manifestBytes = await download(manifestUrl, MAX_MANIFEST_BYTES, "renderer manifest");
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("website renderer manifest is not valid JSON");
  }
  const manifest = parseRendererManifest(rawManifest);
  const tarballUrl = new URL(manifest.tarball, manifestUrl);
  if (tarballUrl.origin !== manifestUrl.origin) {
    throw new Error("website renderer tarball must use the manifest origin");
  }
  const archiveBytes = await download(tarballUrl, MAX_RENDERER_BYTES, "renderer tarball");
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  if (digest !== manifest.sha256) {
    throw new Error("website renderer tarball does not match its SHA-256 digest");
  }

  const home = laxHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(home, ".page-builder-"));
  const archive = path.join(staging, manifest.tarball);
  const target = path.join(home, "page-builder");
  try {
    fs.writeFileSync(archive, archiveBytes, { mode: 0o600 });
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        staging,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        archive,
      ],
      { stdio: "inherit", timeout: INSTALL_TIMEOUT_MS },
    );
    const installed = path.join(
      staging,
      "node_modules",
      "@lax-archive",
      "website",
    );
    for (const relative of [
      "dist/sitegen/generate.js",
      "dist/sitegen/assets.js",
      "assets/site",
      "content/landing.md",
      "content/contributing.md",
    ]) {
      if (!fs.existsSync(path.join(installed, relative))) {
        throw new Error(`installed website renderer is missing ${relative}`);
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    console.log(`website renderer is current at ${manifest.commit}`);
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function download(url: URL, maximumBytes: number, label: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`could not download ${label}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`could not download ${label}: HTTP ${response.status}`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
    }
  }
  if (response.body === null) throw new Error(`${label} response has no body`);

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
