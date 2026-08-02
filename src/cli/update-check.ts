import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { laxHome } from "./auth.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const CACHE_FILE = "update-check.json";
const REGISTRY_URL = "https://registry.npmjs.org/lax-archive/latest";

interface UpdateCheckCache {
  lastAttemptAt: number;
  latestVersion?: string;
}

const BACKGROUND_CHECK = String.raw`
import fs from "node:fs";
import path from "node:path";
const [cacheFile, registryUrl, lastAttemptAt] = process.argv.slice(1);
try {
  const response = await fetch(registryUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) process.exit(0);
  const body = await response.json();
  if (typeof body.version !== "string") process.exit(0);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    lastAttemptAt: Number(lastAttemptAt),
    latestVersion: body.version,
  }) + "\n", { mode: 0o600 });
} catch {}
`;

export function checkForCliUpdate(currentVersion: string, now = Date.now()): void {
  const file = path.join(laxHome(), CACHE_FILE);
  const previous = readCache(file);
  if (
    previous?.latestVersion !== undefined &&
    isNewerVersion(previous.latestVersion, currentVersion) &&
    process.stderr.isTTY
  ) {
    console.error(
      `lax: version ${previous.latestVersion} is available (currently ${currentVersion}); ` +
        "run `lax upgrade`",
    );
  }
  if (process.env.LAX_DISABLE_UPDATE_CHECK === "1") return;
  if (previous !== undefined && now - previous.lastAttemptAt < CHECK_INTERVAL_MS) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...previous, lastAttemptAt: now })}\n`, {
      mode: 0o600,
    });
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", BACKGROUND_CHECK, file, REGISTRY_URL, String(now)],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch {
    // Update checks are best-effort and never affect the requested command.
  }
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string): [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/u.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const next = parse(candidate);
  const installed = parse(current);
  if (next === undefined || installed === undefined) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== installed[index]) return next[index]! > installed[index]!;
  }
  return false;
}

function readCache(filename: string): UpdateCheckCache | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<UpdateCheckCache>;
    if (typeof value.lastAttemptAt !== "number") return undefined;
    return {
      lastAttemptAt: value.lastAttemptAt,
      ...(typeof value.latestVersion === "string" ? { latestVersion: value.latestVersion } : {}),
    };
  } catch {
    return undefined;
  }
}
