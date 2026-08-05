import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type { SourceLocation } from "../../shared/types.js";
import type { ValidationRunner } from "../sandbox/container.js";

export interface FetchedSource {
  repositoryRoot: string;
  submissionRoot: string;
}

export async function fetchSource(
  source: SourceLocation,
  jobDir: string,
  runner: ValidationRunner,
  limits: ValidationLimits,
): Promise<FetchedSource> {
  const repositoryRoot = path.join(jobDir, "source");
  fs.mkdirSync(repositoryRoot, { recursive: true, mode: 0o700 });
  const result = await runner.run({
    label: "fetch-source",
    args: [
      "node",
      "/opt/lax-runtime/bin/fetch-source.mjs",
      source.repository,
      source.commit,
      "/job/source",
    ],
    mounts: [{ source: jobDir, target: "/job", writable: true }],
    network: true,
    timeoutMs: limits.fetchTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  });
  if (result.code !== 0) {
    const reason = result.timedOut ? "source fetch exceeded its time limit" : result.output.trim();
    throw new Error(reason || "source fetch failed");
  }
  const submissionRoot = containedDirectory(repositoryRoot, source.folder);
  inspectCheckout(repositoryRoot);
  return { repositoryRoot: fs.realpathSync(repositoryRoot), submissionRoot };
}

export function containedDirectory(base: string, folder: string): string {
  const baseReal = fs.realpathSync(base);
  const lexical = path.resolve(baseReal, folder);
  if (lexical !== baseReal && !lexical.startsWith(`${baseReal}${path.sep}`)) {
    throw new Error("submission folder escapes the repository");
  }
  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    throw new Error(`repository has no submission folder ${folder}`);
  }
  if (real !== lexical || !fs.statSync(real).isDirectory()) {
    throw new Error("submission folder must be a plain directory and may not traverse a symlink");
  }
  return real;
}

function inspectCheckout(root: string): void {
  const maxFiles = 100_000;
  const maxBytes = 2 * 1024 * 1024 * 1024;
  let files = 0;
  let bytes = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".lake") continue;
      const current = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`repository contains a symlink, which is not accepted: ${path.relative(root, current)}`);
      }
      if (entry.isDirectory()) walk(current);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(current).size;
        if (files > maxFiles) throw new Error(`repository contains more than ${maxFiles} files`);
        if (bytes > maxBytes) throw new Error("repository checkout exceeds 2 GiB");
      } else {
        throw new Error(`repository contains a non-regular entry: ${path.relative(root, current)}`);
      }
    }
  };
  walk(root);
}
