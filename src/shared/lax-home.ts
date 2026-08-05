import os from "node:os";
import path from "node:path";

/**
 * The CLI's durable per-user state directory (credentials, database clone,
 * warm mathlib workspace, built tools). LAX_HOME repoints it for tests.
 */
export function laxHome(): string {
  return process.env.LAX_HOME ?? path.join(os.homedir(), ".lax");
}
