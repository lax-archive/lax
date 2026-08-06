import { createHash } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { CAPTURES_REPOSITORY } from "./constants.js";
import type { SourceLocation } from "./types.js";
import { validateSubmissionId, ValidationError } from "./validation.js";
import type { CaptureManifest, PublishedCapture } from "../submission-validation/contracts.js";

const REGISTRY = "https://ghcr.io";

/** Test seam (never set in production): LAX_CAPTURE_REGISTRY_URL points
 * promote() at a local fake registry (test/fake-ghcr.ts). Read per call,
 * like githubApiBase() in ./constants.js, so a fake started after module
 * import is honored; unset means the real ghcr origin. */
function registryOrigin(): string {
  const value = process.env.LAX_CAPTURE_REGISTRY_URL;
  return value === undefined ? REGISTRY : new URL(value).origin;
}

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 60 * 60_000;
/** OCI 1.1 artifact guidance: an artifact manifest uses the two-byte empty
 * JSON config blob so registries treat it as data, not a runnable image. */
const EMPTY_CONFIG = Buffer.from("{}", "utf8");
const EMPTY_CONFIG_DIGEST = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
export const CAPTURE_MEDIA_TYPE = "application/vnd.lax.capture.v1+tar";
const REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;

/**
 * Deterministic discoverability tag for the capture of one validated
 * (source repository, folder, commit) built under one (Lean toolchain,
 * mathlib commit) pin: `cap-<commit12>-<sha256 of the canonical tuple>`.
 *
 * A directly escaped tuple cannot fit OCI's 128-character tag limit or its
 * `[A-Za-z0-9._-]` alphabet (repository URLs and folders run to hundreds of
 * arbitrary bytes), so the tuple is serialized as a JSON array of its five
 * strings — an injective encoding: JSON escaping disambiguates every hostile
 * character and the array structure separates the fields — and hashed with
 * the full sha256. Distinct tuples therefore get distinct tags up to a
 * sha256 collision. The 12-hex commit prefix is redundant with the hash and
 * exists only for human browsing. Total length: 4 + 12 + 1 + 64 = 81 < 128.
 *
 * The pin is inside the hashed tuple (rewrite-plan.md addendum 2a): a
 * toolchain or mathlib bump changes the tag, so stale-pin oleans are never
 * discovered under the new pin's key.
 *
 * The current capture layout seals ONE tarball per submission holding both
 * the concepts and proofs subtrees, so the plan's proof|concept axis is not
 * a separate artifact and does not appear in the tag.
 *
 * Tags are MUTABLE and carry no integrity — see GhcrCaptureStore.
 */
export function captureTag(source: SourceLocation, manifest: CaptureManifest): string {
  const canonical = JSON.stringify([
    source.repository,
    source.folder,
    source.commit,
    manifest.leanToolchain,
    manifest.mathlibCommit,
  ]);
  const tupleHash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `cap-${source.commit.slice(0, 12)}-${tupleHash}`;
}

/**
 * Dependency captures as digest-addressed OCI artifacts on ghcr.
 *
 * Integrity model — the fail-closed successor to the immutable-Releases
 * probe of the old GitHubReleaseCaptureStore:
 *
 * - ghcr tags are MUTABLE and exist only for discoverability and later
 *   garbage collection. Consumers never fetch a capture through a tag: they
 *   fetch the blob by the sha256 digest recorded in the dependent's
 *   build-output.json and hash the received bytes. The schema parsers
 *   (artifact-schema.ts, archive/snapshot.ts) reject any registryBlob
 *   reference whose digest differs from the record's own capture digest, so
 *   a rewritten tag or reference can never redirect a consumer.
 * - The publisher refuses to write a database record whose capture digest it
 *   did not itself just hash, push, and re-verify: promote() hashes the
 *   local tarball, requires it to equal the validated manifest digest,
 *   pushes to that content address, and confirms the registry stores the
 *   blob before returning the reference the caller embeds in the record.
 * - Ordering: promote() completes — blob, config, manifest, and tag —
 *   strictly before the database CAS commit that references the blob
 *   (submit-publisher.ts). A record must never point at a blob that is not
 *   durably stored, and only a manifest reference makes a ghcr blob
 *   durable, so the tag is pushed here rather than trailed after the
 *   commit. If the commit then fails, the orphaned tag is garbage — never
 *   inconsistency — and identifiable by comparing tags against database
 *   records. Retries re-push identical bytes onto the same content address
 *   and re-PUT a byte-identical manifest: naturally idempotent.
 * - GC note: the deterministic tuple tags let a later, separate collector
 *   enumerate ghcr artifacts and delete those no database record
 *   references. Deliberately not built here.
 *
 * The transport is the OCI distribution HTTP API driven directly with the
 * publish job's GITHUB_TOKEN (packages: write) — no oras or docker binary.
 * Every registry response is untrusted input: only exact expected status
 * codes are accepted and all parsed bodies are bounded.
 */
export class GhcrCaptureStore {
  constructor(
    private readonly token: string,
    private readonly repository = CAPTURES_REPOSITORY,
  ) {
    if (token === "") throw new ValidationError("capture store requires a registry credential");
    if (!REPOSITORY_PATTERN.test(repository)) {
      throw new ValidationError("capture registry repository is not a valid ghcr path");
    }
  }

  async promote(
    id: string,
    source: SourceLocation,
    manifest: CaptureManifest,
    capturePath: string,
  ): Promise<PublishedCapture> {
    validateSubmissionId(id);
    if (source.commit !== manifest.sourceCommit) {
      throw new ValidationError("capture source commit does not match the publication source");
    }
    const stat = fs.lstatSync(capturePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CAPTURE_BYTES) {
      throw new ValidationError("capture.tar must be a non-empty regular file no larger than 2 GiB");
    }
    // The publisher only ever references a digest it computed itself over
    // the exact bytes it is about to push.
    if (sha256File(capturePath) !== manifest.digest) {
      throw new ValidationError("capture.tar digest does not match the validated capture manifest");
    }
    const digest = `sha256:${manifest.digest}`;
    const bearer = await this.exchangeToken();
    await this.ensureBlob(bearer, digest, stat.size, () =>
      Readable.toWeb(fs.createReadStream(capturePath)) as unknown as BodyInit);
    await this.ensureBlob(bearer, EMPTY_CONFIG_DIGEST, EMPTY_CONFIG.length, () =>
      EMPTY_CONFIG as unknown as BodyInit);
    await this.putManifest(bearer, captureTag(source, manifest), {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: CAPTURE_MEDIA_TYPE,
      config: {
        mediaType: "application/vnd.oci.empty.v1+json",
        digest: EMPTY_CONFIG_DIGEST,
        size: EMPTY_CONFIG.length,
      },
      layers: [{ mediaType: CAPTURE_MEDIA_TYPE, digest, size: stat.size }],
      // Discoverability and GC metadata only; consumers trust none of it.
      annotations: {
        "org.opencontainers.image.revision": manifest.sourceCommit,
        "archive.lax.submission": id,
        "archive.lax.repository": source.repository,
        "archive.lax.folder": source.folder,
        "archive.lax.lean-toolchain": manifest.leanToolchain,
        "archive.lax.mathlib-commit": manifest.mathlibCommit,
      },
    });
    return { ...manifest, registryBlob: `ghcr.io/${this.repository}@${digest}` };
  }

  /** ghcr's token endpoint trades the Actions GITHUB_TOKEN (Basic auth, any
   * username) for a short-lived registry bearer token. */
  private async exchangeToken(): Promise<string> {
    const scope = `repository:${this.repository}:pull,push`;
    const response = await this.fetch(
      `${registryOrigin()}/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(`x-access-token:${this.token}`, "utf8").toString("base64")}`,
        },
      },
    );
    if (response.status !== 200) {
      throw new Error(`ghcr token exchange failed with HTTP ${response.status}`);
    }
    const body = await boundedText(response, 1024 * 1024);
    let token: unknown;
    try {
      token = (JSON.parse(body) as { token?: unknown }).token;
    } catch {
      throw new Error("ghcr token response is not JSON");
    }
    if (typeof token !== "string" || token === "" || /[\s"\\]/u.test(token)) {
      throw new Error("ghcr token response is malformed");
    }
    return token;
  }

  /** Blobs are content-addressed, so pushing the same bytes twice is a
   * natural no-op: HEAD first, upload only when absent, verify after. */
  private async ensureBlob(
    bearer: string,
    digest: string,
    size: number,
    body: () => BodyInit,
  ): Promise<void> {
    if (await this.blobExists(bearer, digest, size)) return;
    const registry = registryOrigin();
    const session = await this.fetch(`${registry}/v2/${this.repository}/blobs/uploads/`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (session.status !== 202) {
      throw new Error(`ghcr blob upload session failed with HTTP ${session.status}`);
    }
    const location = session.headers.get("location");
    if (location === null) throw new Error("ghcr blob upload session has no location");
    // The registry names the upload endpoint; keep it pinned to the registry
    // origin so the credential and the capture bytes cannot be redirected.
    const target = new URL(location, registry);
    if (target.origin !== registry) {
      throw new Error("ghcr blob upload session left the registry origin");
    }
    target.searchParams.set("digest", digest);
    const upload = await this.fetch(target.toString(), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/octet-stream",
        "content-length": String(size),
      },
      body: body(),
      duplex: "half",
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (upload.status !== 201) {
      throw new Error(`ghcr blob upload failed with HTTP ${upload.status}`);
    }
    if (!(await this.blobExists(bearer, digest, size))) {
      throw new Error("ghcr does not report the capture blob after upload");
    }
  }

  private async blobExists(bearer: string, digest: string, size: number): Promise<boolean> {
    const response = await this.fetch(`${registryOrigin()}/v2/${this.repository}/blobs/${digest}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (response.status === 404) return false;
    if (response.status !== 200) {
      throw new Error(`ghcr blob check failed with HTTP ${response.status}`);
    }
    const reported = response.headers.get("content-length");
    if (reported !== null && Number(reported) !== size) {
      throw new Error("ghcr reports a stored capture blob with the wrong size");
    }
    return true;
  }

  private async putManifest(bearer: string, tag: string, manifest: unknown): Promise<void> {
    const response = await this.fetch(
      `${registryOrigin()}/v2/${this.repository}/manifests/${tag}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/vnd.oci.image.manifest.v1+json",
        },
        body: JSON.stringify(manifest),
      },
    );
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`ghcr manifest push failed with HTTP ${response.status}`);
    }
  }

  private async fetch(
    url: string,
    init: RequestInit & { duplex?: "half"; timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs, ...request } = init;
    try {
      return await fetch(url, {
        ...request,
        signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`ghcr request failed: ${(error as Error).message}`);
    }
  }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw new Error("ghcr response exceeds the size bound");
  return text;
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
