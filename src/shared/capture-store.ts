import { createHash } from "node:crypto";
import fs from "node:fs";
import { DATABASE_REPOSITORY } from "./constants.js";
import { GitHubError, repositoryPath } from "./github.js";
import { validateCommit, validateSubmissionId, ValidationError } from "./validation.js";
import type { CaptureManifest, PublishedCapture } from "../submission-validation/contracts.js";

const CAPTURE_ASSET_NAME = "capture.tar";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;

interface ImmutableReleaseStatus {
  enabled: boolean;
}

interface ReleaseAsset {
  id: number;
  name: string;
  state: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
}

interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  immutable?: boolean;
  upload_url: string;
  assets: ReleaseAsset[];
}

export interface CaptureStoreClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  uploadReleaseAsset<T>(uploadUrl: string, filename: string, assetName: string): Promise<T>;
}

/** Content-addressed, immutable release storage for validated submission captures. */
export class GitHubReleaseCaptureStore {
  private readonly base = repositoryPath(DATABASE_REPOSITORY);

  constructor(private readonly github: CaptureStoreClient) {}

  async promote(
    id: string,
    manifest: CaptureManifest,
    capturePath: string,
    targetCommit: string,
  ): Promise<PublishedCapture> {
    validateSubmissionId(id);
    validateCommit(targetCommit);
    const stat = fs.lstatSync(capturePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CAPTURE_BYTES) {
      throw new ValidationError("capture.tar must be a non-empty regular file no larger than 2 GiB");
    }
    if (sha256File(capturePath) !== manifest.digest) {
      throw new ValidationError("capture.tar digest does not match the validated capture manifest");
    }
    const immutable = await this.github.request<ImmutableReleaseStatus>(
      "GET",
      `${this.base}/immutable-releases`,
    ).catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 404) return { enabled: false };
      throw error;
    });
    if (immutable.enabled !== true) {
      throw new ValidationError("lax-database must enable immutable releases before captures can be published");
    }

    const tag = `lax-capture-${id}-${manifest.digest}`;
    let release = await this.releaseByTag(tag);
    if (release === undefined) {
      try {
        release = await this.github.request<Release>("POST", `${this.base}/releases`, {
          tag_name: tag,
          target_commitish: targetCommit,
          name: `Lax capture ${id} ${manifest.digest}`,
          body: "Content-addressed submission artifacts produced by the Lax validation workflow.",
          draft: true,
          prerelease: false,
          generate_release_notes: false,
        });
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 422) throw error;
        release = await this.releaseByTag(tag);
        if (release === undefined) throw error;
      }
    }

    if (release.tag_name !== tag) throw new ValidationError("capture release tag is inconsistent");
    if (release.draft) {
      if (release.assets.length > 1 || (release.assets[0] !== undefined && release.assets[0].name !== CAPTURE_ASSET_NAME)) {
        throw new ValidationError("capture draft release contains unexpected assets");
      }
      if (release.assets.length === 0) {
        const asset = await this.github.uploadReleaseAsset<ReleaseAsset>(
          release.upload_url,
          capturePath,
          CAPTURE_ASSET_NAME,
        );
        validateAssetMetadata(asset, manifest.digest, stat.size);
      } else {
        validateAssetMetadata(release.assets[0]!, manifest.digest, stat.size);
      }
      release = await this.github.request<Release>("PATCH", `${this.base}/releases/${release.id}`, {
        draft: false,
      });
    }
    if (release.draft || release.immutable !== true) {
      throw new ValidationError("capture release was not published as immutable");
    }
    if (release.assets.length !== 1) {
      throw new ValidationError("immutable capture release must contain exactly one asset");
    }
    const asset = release.assets[0]!;
    validateAsset(asset, manifest.digest, stat.size, tag);
    return { ...manifest, downloadUrl: asset.browser_download_url };
  }

  private async releaseByTag(tag: string): Promise<Release | undefined> {
    try {
      return await this.github.request<Release>(
        "GET",
        `${this.base}/releases/tags/${encodeURIComponent(tag)}`,
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined;
      throw error;
    }
  }
}

function validateAsset(asset: ReleaseAsset, digest: string, size: number, tag: string): void {
  validateAssetMetadata(asset, digest, size);
  const expectedUrl = `https://github.com/${DATABASE_REPOSITORY}/releases/download/${tag}/${CAPTURE_ASSET_NAME}`;
  if (asset.browser_download_url !== expectedUrl) {
    throw new ValidationError("capture release asset does not match the validated archive");
  }
}

function validateAssetMetadata(asset: ReleaseAsset, digest: string, size: number): void {
  if (
    asset.name !== CAPTURE_ASSET_NAME ||
    asset.state !== "uploaded" ||
    asset.size !== size ||
    asset.digest !== `sha256:${digest}`
  ) {
    throw new ValidationError("capture release asset does not match the validated archive");
  }
}

function sha256File(filename: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

export type { Release, ReleaseAsset };
