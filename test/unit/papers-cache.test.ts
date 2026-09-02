// The serve-side paper/bundle caches against the fake registry
// (test/fake-ghcr.ts through the LAX_CAPTURE_REGISTRY_URL seam): a miss
// downloads, digest-verifies, and lands the file; a hit answers from disk
// without touching the network; tampered bytes and mismatched references
// are refused without poisoning the cache; an unreachable registry
// degrades to `undefined` — the preview's "render without the viewer".

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundleCachePath,
  ensureCachedPaperBlob,
  paperCachePath,
} from "../../src/cli/papers-cache.js";
import { startFakeGhcr, type FakeGhcr } from "../fake-ghcr.js";

const environment = {
  home: process.env.LAX_HOME,
  registry: process.env.LAX_CAPTURE_REGISTRY_URL,
};

let ghcr: FakeGhcr | undefined;
let home: string;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function pdfBytes(filler: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${filler}\n%%EOF\n`, "latin1");
}

function tarBytes(filler: string): Buffer {
  // Enough ustar shape for the cache's magic check: the byte layout of a
  // real bundle is the site build's business, not the cache's.
  const block = Buffer.alloc(1024);
  block.write("index.json", 0, "latin1");
  block.write("ustar", 257, "latin1");
  block.write(filler.slice(0, 32), 512, "latin1");
  return block;
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function referenceOf(digest: string): string {
  return `ghcr.io/lax-archive/lax-captures@sha256:${digest}`;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-papers-cache-"));
  process.env.LAX_HOME = home;
  ghcr = await startFakeGhcr();
  process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;
});

afterEach(async () => {
  await ghcr?.close();
  ghcr = undefined;
  fs.rmSync(home, { recursive: true, force: true });
  restore("LAX_HOME", environment.home);
  restore("LAX_CAPTURE_REGISTRY_URL", environment.registry);
});

describe("the serve-side paper and bundle caches", () => {
  it("downloads a missing paper once, verifies it, and answers later calls from disk", async () => {
    const bytes = pdfBytes("a compiled paper");
    const digest = digestOf(bytes);
    ghcr!.state.blobs.set(`sha256:${digest}`, bytes);

    const file = await ensureCachedPaperBlob("paper", digest, referenceOf(digest));
    expect(file).toBe(paperCachePath(digest));
    expect(file).toBe(path.join(home, "papers", `${digest}.pdf`));
    expect(fs.readFileSync(file!)).toEqual(bytes);

    const requestsAfterMiss = ghcr!.requests.length;
    expect(requestsAfterMiss).toBeGreaterThan(0);
    const again = await ensureCachedPaperBlob("paper", digest, referenceOf(digest));
    expect(again).toBe(file);
    expect(ghcr!.requests.length).toBe(requestsAfterMiss);
  });

  it("caches a web bundle under ~/.lax/bundles by its digest", async () => {
    const bytes = tarBytes("bundle bytes");
    const digest = digestOf(bytes);
    ghcr!.state.blobs.set(`sha256:${digest}`, bytes);

    const file = await ensureCachedPaperBlob("bundle", digest, referenceOf(digest));
    expect(file).toBe(bundleCachePath(digest));
    expect(file).toBe(path.join(home, "bundles", `${digest}.tar`));
    expect(fs.readFileSync(file!)).toEqual(bytes);
  });

  it("rejects tampered registry bytes and leaves the cache empty", async () => {
    const bytes = pdfBytes("the real paper");
    const digest = digestOf(bytes);
    // The registry answers the digest address with different bytes.
    ghcr!.state.blobs.set(`sha256:${digest}`, pdfBytes("something else entirely"));

    const file = await ensureCachedPaperBlob("paper", digest, referenceOf(digest));
    expect(file).toBeUndefined();
    expect(fs.existsSync(paperCachePath(digest))).toBe(false);
    expect(fs.readdirSync(home)).not.toContain("papers");
  });

  it("refuses bytes that hash right but are not the kind they claim", async () => {
    const bytes = Buffer.from("not a pdf at all", "latin1");
    const digest = digestOf(bytes);
    ghcr!.state.blobs.set(`sha256:${digest}`, bytes);

    expect(await ensureCachedPaperBlob("paper", digest, referenceOf(digest))).toBeUndefined();
    expect(await ensureCachedPaperBlob("bundle", digest, referenceOf(digest))).toBeUndefined();
    expect(fs.existsSync(paperCachePath(digest))).toBe(false);
  });

  it("refuses a reference that addresses a different digest, without any request", async () => {
    const bytes = pdfBytes("a paper");
    const digest = digestOf(bytes);
    const other = digestOf(Buffer.from("other"));

    const file = await ensureCachedPaperBlob("paper", digest, referenceOf(other));
    expect(file).toBeUndefined();
    expect(ghcr!.requests.length).toBe(0);
  });

  it("falls back to undefined when the registry is unreachable", async () => {
    const bytes = pdfBytes("an offline paper");
    const digest = digestOf(bytes);
    const url = ghcr!.url;
    await ghcr!.close();
    ghcr = undefined;
    process.env.LAX_CAPTURE_REGISTRY_URL = url;

    const file = await ensureCachedPaperBlob("paper", digest, referenceOf(digest));
    expect(file).toBeUndefined();
    expect(fs.existsSync(paperCachePath(digest))).toBe(false);
  });

  it("keeps serving a cached file when the registry is gone", async () => {
    const bytes = pdfBytes("a durable paper");
    const digest = digestOf(bytes);
    ghcr!.state.blobs.set(`sha256:${digest}`, bytes);
    const file = await ensureCachedPaperBlob("paper", digest, referenceOf(digest));
    expect(file).toBeDefined();

    const url = ghcr!.url;
    await ghcr!.close();
    ghcr = undefined;
    process.env.LAX_CAPTURE_REGISTRY_URL = url;
    expect(await ensureCachedPaperBlob("paper", digest, referenceOf(digest))).toBe(file);
  });
});
