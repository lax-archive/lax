import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTag, GhcrCaptureStore } from "../../src/shared/capture-store.js";
import type { CaptureManifest } from "../../src/submission-validation/contracts.js";
import { cleanupTemporary, temporary } from "../support/submission-validation.js";

const SOURCE = {
  repository: "https://github.com/alice/submission",
  commit: "1".repeat(40),
  folder: ".",
};
const REPOSITORY = "lax-archive/lax-captures";
const EMPTY_CONFIG_DIGEST = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

afterEach(() => {
  cleanupTemporary();
  vi.unstubAllGlobals();
});

describe("capture tag encoding", () => {
  it("is deterministic, pin-sensitive, and field-separating", () => {
    const fixture = captureFixture();
    const tag = captureTag(SOURCE, fixture.manifest);
    const expectedHash = createHash("sha256")
      .update(JSON.stringify([
        SOURCE.repository,
        SOURCE.folder,
        SOURCE.commit,
        fixture.manifest.leanToolchain,
        fixture.manifest.mathlibCommit,
      ]), "utf8")
      .digest("hex");
    expect(tag).toBe(`cap-${"1".repeat(12)}-${expectedHash}`);
    expect(tag.length).toBeLessThanOrEqual(128);
    expect(tag).toMatch(/^[a-z0-9][a-z0-9._-]*$/u);
    // A pin bump must change the key (rewrite-plan.md addendum 2a).
    expect(captureTag(SOURCE, { ...fixture.manifest, mathlibCommit: "9".repeat(40) })).not.toBe(tag);
    expect(captureTag(SOURCE, { ...fixture.manifest, leanToolchain: "leanprover/lean4:v4.31.0" })).not.toBe(tag);
    expect(captureTag({ ...SOURCE, folder: "sub" }, fixture.manifest)).not.toBe(tag);
    // JSON-array serialization keeps fields separated: moving a path segment
    // between repository and folder cannot collide.
    expect(captureTag({ ...SOURCE, repository: `${SOURCE.repository}/x`, folder: "." }, fixture.manifest))
      .not.toBe(captureTag({ ...SOURCE, folder: "x" }, fixture.manifest));
  });
});

describe("ghcr capture promotion", () => {
  it("pushes blob and config by digest, tags the tuple manifest, and returns the digest reference", async () => {
    const fixture = captureFixture();
    const registry = fakeRegistry();
    const store = new GhcrCaptureStore("job-token", REPOSITORY);
    await expect(store.promote("lax-42", SOURCE, fixture.manifest, fixture.path)).resolves.toEqual({
      ...fixture.manifest,
      registryBlob: `ghcr.io/${REPOSITORY}@sha256:${fixture.manifest.digest}`,
    });

    const token = registry.calls.find((call) => call.url.startsWith("https://ghcr.io/token"));
    expect(token?.url).toContain(encodeURIComponent(`repository:${REPOSITORY}:pull,push`));
    expect(token?.headers.authorization).toMatch(/^Basic /u);
    expect(Buffer.from(token!.headers.authorization!.slice("Basic ".length), "base64").toString("utf8"))
      .toBe("x-access-token:job-token");

    const uploads = registry.calls.filter((call) => call.method === "PUT" && call.url.includes("/blobs/uploads/"));
    expect(uploads.map((call) => new URL(call.url).searchParams.get("digest")).sort()).toEqual([
      EMPTY_CONFIG_DIGEST,
      `sha256:${fixture.manifest.digest}`,
    ].sort());
    expect(registry.blobs.get(`sha256:${fixture.manifest.digest}`)).toBe(fixture.manifest.digest);

    const manifestPut = registry.calls.find((call) => call.method === "PUT" && call.url.includes("/manifests/"));
    expect(manifestPut?.url).toBe(
      `https://ghcr.io/v2/${REPOSITORY}/manifests/${captureTag(SOURCE, fixture.manifest)}`,
    );
    const manifest = JSON.parse(manifestPut!.body!) as Record<string, any>;
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: "application/vnd.lax.capture.v1+tar",
      config: { digest: EMPTY_CONFIG_DIGEST, size: 2 },
      layers: [{ digest: `sha256:${fixture.manifest.digest}`, size: fixture.size }],
    });
    expect(manifest.annotations["archive.lax.submission"]).toBe("lax-42");
  });

  it("re-pushes idempotently: existing blobs are not uploaded again but the tag is still pointed", async () => {
    const fixture = captureFixture();
    const registry = fakeRegistry();
    registry.blobs.set(`sha256:${fixture.manifest.digest}`, fixture.manifest.digest);
    registry.blobs.set(EMPTY_CONFIG_DIGEST, "");
    const store = new GhcrCaptureStore("job-token", REPOSITORY);
    await expect(store.promote("lax-42", SOURCE, fixture.manifest, fixture.path)).resolves.toMatchObject({
      registryBlob: `ghcr.io/${REPOSITORY}@sha256:${fixture.manifest.digest}`,
    });
    expect(registry.calls.some((call) => call.method === "POST")).toBe(false);
    expect(registry.calls.some((call) => call.method === "PUT" && call.url.includes("/blobs/uploads/"))).toBe(false);
    expect(registry.calls.some((call) => call.method === "PUT" && call.url.includes("/manifests/"))).toBe(true);
  });

  it("fails closed before any network request when the local bytes do not match the validated digest", async () => {
    const fixture = captureFixture();
    const registry = fakeRegistry();
    fs.appendFileSync(fixture.path, "changed");
    const store = new GhcrCaptureStore("job-token", REPOSITORY);
    await expect(store.promote("lax-42", SOURCE, fixture.manifest, fixture.path))
      .rejects.toThrow("digest does not match");
    expect(registry.calls).toHaveLength(0);
    await expect(store.promote("lax-42", { ...SOURCE, commit: "2".repeat(40) }, captureFixture().manifest, fixture.path))
      .rejects.toThrow("source commit");
    expect(registry.calls).toHaveLength(0);
  });

  it("rejects unexpected registry responses and foreign upload locations", async () => {
    const fixture = captureFixture();
    const failing = fakeRegistry({ blobStatus: 500 });
    await expect(new GhcrCaptureStore("job-token", REPOSITORY).promote("lax-42", SOURCE, fixture.manifest, fixture.path))
      .rejects.toThrow("HTTP 500");

    const redirected = fakeRegistry({ uploadLocation: "https://evil.example/upload" });
    await expect(new GhcrCaptureStore("job-token", REPOSITORY).promote("lax-42", SOURCE, fixture.manifest, fixture.path))
      .rejects.toThrow("registry origin");
    expect(redirected.calls.some((call) => call.url.startsWith("https://evil.example"))).toBe(false);
    expect(failing.calls.length).toBeGreaterThan(0);
  });
});

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body?: string;
}

/** In-process OCI registry: content-addressed blob store plus manifest PUT. */
function fakeRegistry(options: { blobStatus?: number; uploadLocation?: string } = {}): {
  calls: RecordedCall[];
  blobs: Map<string, string>;
} {
  const calls: RecordedCall[] = [];
  const blobs = new Map<string, string>();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const body = init?.body === undefined || init.body === null ? undefined : await bodyText(init.body);
    calls.push({ method, url, headers, body });
    if (url.startsWith("https://ghcr.io/token")) {
      return new Response(JSON.stringify({ token: "registry-bearer" }), { status: 200 });
    }
    if (method === "HEAD" && url.includes("/blobs/sha256:")) {
      if (options.blobStatus !== undefined) return new Response(null, { status: options.blobStatus });
      const digest = url.slice(url.indexOf("sha256:"));
      return blobs.has(digest) ? new Response(null, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (method === "POST" && url.endsWith("/blobs/uploads/")) {
      return new Response(null, {
        status: 202,
        headers: { location: options.uploadLocation ?? `/v2/${REPOSITORY}/blobs/uploads/session-1` },
      });
    }
    if (method === "PUT" && url.includes("/blobs/uploads/")) {
      const digest = new URL(url).searchParams.get("digest")!;
      const actual = createHash("sha256").update(body ?? "", "utf8").digest("hex");
      if (`sha256:${actual}` !== digest && digest !== EMPTY_CONFIG_DIGEST) {
        return new Response(null, { status: 400 });
      }
      blobs.set(digest, actual);
      return new Response(null, { status: 201 });
    }
    if (method === "PUT" && url.includes("/manifests/")) {
      return new Response(null, { status: 201 });
    }
    return new Response(null, { status: 404 });
  }));
  return { calls, blobs };
}

async function bodyText(body: BodyInit): Promise<string> {
  if (typeof body === "string") return body;
  return await new Response(body).text();
}

function captureFixture(): { path: string; size: number; manifest: CaptureManifest } {
  const bytes = Buffer.from("capture bytes", "utf8");
  const filename = path.join(temporary("capture-store-"), "capture.tar");
  fs.writeFileSync(filename, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    path: filename,
    size: bytes.length,
    manifest: {
      formatVersion: 1,
      digest,
      sourceCommit: "1".repeat(40),
      leanToolchain: "leanprover/lean4:v4.30.0",
      mathlibCommit: "3".repeat(40),
      files: [{ path: "file", bytes: 1, sha256: "4".repeat(64) }],
    },
  };
}
