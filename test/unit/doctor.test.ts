import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor.js";

const previous = { home: process.env.LAX_HOME, token: process.env.LAX_GITHUB_APP_USER_TOKEN };
let home: string;

beforeEach(() => {
  // An empty LAX_HOME keeps every check offline: no credentials (github auth
  // fails before any request), no database clone (no `git ls-remote`).
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-doctor-"));
  process.env.LAX_HOME = home;
  delete process.env.LAX_GITHUB_APP_USER_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  if (previous.home === undefined) delete process.env.LAX_HOME;
  else process.env.LAX_HOME = previous.home;
  if (previous.token !== undefined) process.env.LAX_GITHUB_APP_USER_TOKEN = previous.token;
});

describe("lax doctor", () => {
  it("prints each check as it completes instead of buffering the whole report", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pending = doctor();
    // Everything up to the first awaited probe is already on screen: the
    // buffered version printed nothing until all checks had finished (~60 s
    // worst case).
    const immediate = log.mock.calls.map(([line]) => String(line));
    expect(immediate[0]).toContain("platform:");
    expect(immediate.some((line) => line.includes("lake:"))).toBe(true);
    expect(immediate.some((line) => line.includes("github auth:"))).toBe(false);

    await pending;
    const all = log.mock.calls.map(([line]) => String(line));
    expect(all.length).toBeGreaterThan(immediate.length);
    expect(all.some((line) => line.includes("github auth: no login found"))).toBe(true);
    expect(all.some((line) => line.includes("      → run `lax login`"))).toBe(true);
    expect(all.some((line) => line.includes("database clone:"))).toBe(true);
  });

  it("keeps the check line format (mark, name, detail, indented fix)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await doctor();

    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => /^ {2}[✓!✗] [a-z ]+: /u.test(line))).toBe(true);
    for (const line of lines) {
      if (line.startsWith("      → ")) continue;
      if (line.startsWith("lax doctor: ")) continue;
      expect(line).toMatch(/^ {2}[✓!✗] /u);
    }
  });
});
