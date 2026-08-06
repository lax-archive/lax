import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForCliUpdate, isNewerVersion } from "../../src/cli/update-check.js";

const temporary: string[] = [];
const originalIsTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

afterEach(() => {
  delete process.env.LAX_HOME;
  delete process.env.LAX_DISABLE_UPDATE_CHECK;
  vi.restoreAllMocks();
  if (originalIsTty === undefined) delete (process.stderr as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stderr, "isTTY", originalIsTty);
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("background CLI update check", () => {
  it("compares stable npm versions without accepting prereleases", () => {
    expect(isNewerVersion("0.2.0", "0.1.17")).toBe(true);
    expect(isNewerVersion("0.1.17", "0.1.17")).toBe(false);
    expect(isNewerVersion("0.1.16", "0.1.17")).toBe(false);
    expect(isNewerVersion("1.0.0-beta.1", "0.1.17")).toBe(false);
  });

  it("uses the previous background result on the next interactive start", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-update-check-"));
    temporary.push(home);
    process.env.LAX_HOME = home;
    process.env.LAX_DISABLE_UPDATE_CHECK = "1";
    fs.writeFileSync(
      path.join(home, "update-check.json"),
      JSON.stringify({ lastAttemptAt: 1, latestVersion: "0.2.0" }),
    );
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    checkForCliUpdate("0.1.17", 2);

    expect(reported).toHaveBeenCalledWith(expect.stringContaining("version 0.2.0 is available"));
    expect(reported).toHaveBeenCalledWith(expect.stringContaining("lax update"));
  });
});
