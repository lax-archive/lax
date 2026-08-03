import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubReleaseCaptureStore,
  type CaptureStoreClient,
  type Release,
  type ReleaseAsset,
} from "../../src/shared/capture-store.js";
import { GitHubError } from "../../src/shared/github.js";
import type { CaptureManifest } from "../../src/submission-validation/contracts.js";
import { cleanupTemporary, temporary } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

describe("immutable GitHub Release capture promotion", () => {
  it("creates, uploads, publishes, and verifies one content-addressed release", async () => {
    const fixture = captureFixture();
    const tag = `lax-capture-lax-42-${fixture.manifest.digest}`;
    const asset = releaseAsset(tag, fixture.manifest.digest, fixture.size);
    const draftAsset = releaseAsset("untagged-draft", fixture.manifest.digest, fixture.size);
    const request = vi.fn(async (method: string, apiPath: string): Promise<unknown> => {
      if (apiPath.endsWith("/immutable-releases")) return { enabled: true };
      if (method === "GET") throw new GitHubError("not found", 404);
      if (method === "POST") return release(tag, true, false, []);
      if (method === "PATCH") return release(tag, false, true, [asset]);
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    const uploadReleaseAsset = vi.fn().mockResolvedValue(draftAsset);
    const store = new GitHubReleaseCaptureStore({ request, uploadReleaseAsset } as CaptureStoreClient);
    await expect(store.promote("lax-42", fixture.manifest, fixture.path, "a".repeat(40))).resolves.toEqual({
      ...fixture.manifest,
      downloadUrl: asset.browser_download_url,
    });
    expect(uploadReleaseAsset).toHaveBeenCalledOnce();
    expect(request.mock.calls.find((call) => call[0] === "POST")?.[2]).toMatchObject({
      tag_name: tag,
      draft: true,
      target_commitish: "a".repeat(40),
    });
  });

  it("resumes an exact uploaded draft whose download URL is still temporary", async () => {
    const fixture = captureFixture();
    const tag = `lax-capture-lax-42-${fixture.manifest.digest}`;
    const draftAsset = releaseAsset("untagged-draft", fixture.manifest.digest, fixture.size);
    const publishedAsset = releaseAsset(tag, fixture.manifest.digest, fixture.size);
    const request = vi.fn(async (method: string, apiPath: string): Promise<unknown> => {
      if (apiPath.endsWith("/immutable-releases")) return { enabled: true };
      if (method === "GET") return release(tag, true, false, [draftAsset]);
      if (method === "PATCH") return release(tag, false, true, [publishedAsset]);
      throw new Error(`unexpected ${method} ${apiPath}`);
    });
    const uploadReleaseAsset = vi.fn();

    await expect(new GitHubReleaseCaptureStore({ request, uploadReleaseAsset }).promote(
      "lax-42",
      fixture.manifest,
      fixture.path,
      "a".repeat(40),
    )).resolves.toEqual({
      ...fixture.manifest,
      downloadUrl: publishedAsset.browser_download_url,
    });
    expect(uploadReleaseAsset).not.toHaveBeenCalled();
  });

  it("reuses an already immutable exact capture without uploading", async () => {
    const fixture = captureFixture();
    const tag = `lax-capture-lax-42-${fixture.manifest.digest}`;
    const asset = releaseAsset(tag, fixture.manifest.digest, fixture.size);
    const client: CaptureStoreClient = {
      request: vi.fn(async (_method, apiPath) =>
        apiPath.endsWith("/immutable-releases")
          ? { enabled: true }
          : release(tag, false, true, [asset])),
      uploadReleaseAsset: vi.fn(),
    };
    await new GitHubReleaseCaptureStore(client).promote(
      "lax-42",
      fixture.manifest,
      fixture.path,
      "a".repeat(40),
    );
    expect(client.uploadReleaseAsset).not.toHaveBeenCalled();
  });

  it("fails closed when immutable releases are disabled or bytes changed", async () => {
    const fixture = captureFixture();
    const disabled: CaptureStoreClient = {
      request: vi.fn().mockResolvedValue({ enabled: false }),
      uploadReleaseAsset: vi.fn(),
    };
    await expect(new GitHubReleaseCaptureStore(disabled).promote(
      "lax-42", fixture.manifest, fixture.path, "a".repeat(40),
    )).rejects.toThrow("must enable immutable releases");
    fs.appendFileSync(fixture.path, "changed");
    await expect(new GitHubReleaseCaptureStore(disabled).promote(
      "lax-42", fixture.manifest, fixture.path, "a".repeat(40),
    )).rejects.toThrow("digest does not match");
  });
});

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

function releaseAsset(tag: string, digest: string, size: number): ReleaseAsset {
  return {
    id: 1,
    name: "capture.tar",
    state: "uploaded",
    size,
    digest: `sha256:${digest}`,
    browser_download_url: `https://github.com/lax-archive/lax-database/releases/download/${tag}/capture.tar`,
  };
}

function release(tag: string, draft: boolean, immutable: boolean, assets: ReleaseAsset[]): Release {
  return {
    id: 1,
    tag_name: tag,
    draft,
    immutable,
    upload_url: "https://uploads.github.com/repos/lax-archive/lax-database/releases/1/assets{?name,label}",
    assets,
  };
}
