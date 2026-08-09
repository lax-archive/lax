import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_ARGS, installLatest, versionRow } from "../../src/cli/update.js";
import * as ui from "../../src/cli/ui.js";

// `lax update` exists to answer one question — which version am I running now —
// so its row always carries both ends of the move, and the `after` end is what
// npm left on disk rather than what it was asked to install.

const { version } = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
    "utf8",
  ),
) as { version: string };

const previous = { path: process.env.PATH };
const temporary: string[] = [];

afterEach(() => {
  process.env.PATH = previous.path;
  ui.configure({ verbose: false });
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** An `npm` on PATH that records its argv and says nothing. */
function fakeNpm(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lax-fake-npm-"));
  temporary.push(directory);
  const log = path.join(directory, "argv");
  fs.writeFileSync(
    path.join(directory, "npm"),
    `#!/bin/sh\nfor arg in "$@"; do echo "$arg" >> ${JSON.stringify(log)}; done\n`,
    { mode: 0o755 },
  );
  process.env.PATH = directory;
  return log;
}

describe("lax update", () => {
  it("always asks the network what `latest` is, whatever npm is configured to do", async () => {
    // The bug this pins: `prefer-online` is off by default, so npm resolves the
    // `latest` tag from its cached packument and an update in the minutes after
    // a release reinstalls the version already present and exits 0. The two
    // `--no-` flags close the same door opened from the author's ~/.npmrc.
    const log = fakeNpm();
    await installLatest();
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(INSTALL_ARGS);
    expect(INSTALL_ARGS).toContain("--prefer-online");
    expect(INSTALL_ARGS).toContain("--no-prefer-offline");
    expect(INSTALL_ARGS).toContain("--no-offline");
  });

  it("asks for the same thing when it is showing npm's transcript", async () => {
    // The verbose path spawns npm with inherited stdio instead of capturing it,
    // which is a second call site and therefore a second chance to drift.
    ui.configure({ verbose: true });
    const log = fakeNpm();
    await installLatest();
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(INSTALL_ARGS);
  });

  it("prints the version it came from and the version it is on", () => {
    expect(versionRow("9.9.9")).toEqual({
      label: "Updated lax",
      detail: `${version} → 9.9.9`,
    });
  });

  it("prints both ends even when the update moved nothing", () => {
    expect(versionRow(version)).toEqual({
      label: "lax is up to date",
      detail: `${version} → ${version}`,
    });
  });

  it("refuses to invent the version when npm will not say which it installed", () => {
    const row = versionRow(undefined);
    expect(row.status).toBe("warn");
    expect(row.label).toBe("Updated lax");
    expect(row.detail).toContain("did not say which version");
  });
});
