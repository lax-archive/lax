import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadedPageBuilderDirectory,
  installWebsiteRendererIfMissing,
  parseRendererManifest,
  websiteRendererIsReady,
} from "../../src/cli/website-renderer.js";

const temporary: string[] = [];

afterEach(() => {
  delete process.env.LAX_HOME;
  delete process.env.LAX_WEBSITE_RENDERER_MANIFEST_URL;
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("downloaded Website renderer", () => {
  it("does not contact the manifest when a complete renderer is already installed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-renderer-test-"));
    temporary.push(home);
    process.env.LAX_HOME = home;
    process.env.LAX_WEBSITE_RENDERER_MANIFEST_URL = "http://127.0.0.1:1/latest.json";
    const installed = downloadedPageBuilderDirectory();
    for (const relative of [
      "dist/sitegen/generate.js",
      "dist/sitegen/assets.js",
      "assets/site",
      "content/landing.md",
      "content/contributing.md",
    ]) {
      const target = path.join(installed, relative);
      if (path.extname(target) === "") fs.mkdirSync(target, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "fixture");
      }
    }

    expect(websiteRendererIsReady()).toBe(true);
    await expect(installWebsiteRendererIfMissing()).resolves.toBe(false);
  });

  it("accepts the published manifest contract", () => {
    const commit = "a".repeat(40);
    expect(parseRendererManifest({
      commit,
      tarball: `${commit}.tgz`,
      sha256: "b".repeat(64),
    })).toEqual({
      commit,
      tarball: `${commit}.tgz`,
      sha256: "b".repeat(64),
    });
  });

  it("rejects a tarball name that is not bound to the published commit", () => {
    expect(() => parseRendererManifest({
      commit: "a".repeat(40),
      tarball: "../renderer.tgz",
      sha256: "b".repeat(64),
    })).toThrow("invalid tarball name");
  });

  it("leaves the current renderer untouched when the archive digest is wrong", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-renderer-test-"));
    temporary.push(home);
    process.env.LAX_HOME = home;
    const installed = downloadedPageBuilderDirectory();
    fs.mkdirSync(installed, { recursive: true });
    const sentinel = path.join(installed, "sentinel");
    fs.writeFileSync(sentinel, "current");

    const commit = "a".repeat(40);
    const server = http.createServer((request, response) => {
      if (request.url === "/latest.json") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          commit,
          tarball: `${commit}.tgz`,
          sha256: "0".repeat(64),
        }));
      } else {
        response.end("not the published archive");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test server has no port");
      process.env.LAX_WEBSITE_RENDERER_MANIFEST_URL =
        `http://127.0.0.1:${address.port}/latest.json`;

      await expect(installWebsiteRendererIfMissing()).rejects.toThrow(
        "does not match its SHA-256 digest",
      );
      expect(fs.readFileSync(sentinel, "utf8")).toBe("current");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });
});
