import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArchiveFiles } from "../shared/archive-schema.js";
import { SUBMISSION_ID_PATTERN } from "../shared/constants.js";
import { isObject } from "../shared/validation.js";
import {
  databaseDirectory,
  databaseFreshnessAsync,
  type DatabaseFreshness,
} from "./database.js";

interface WebsiteSubmission {
  record: Record<string, unknown> & { id: string; state: string };
  output?: Record<string, unknown>;
}

interface PageBuilder {
  generateSite(submissions: WebsiteSubmission[], outDir: string): Promise<void>;
  mimeTypes: Record<string, string>;
}

export interface ServeWebsiteOptions {
  databaseOnly?: boolean;
}

/**
 * Adapt the issue-era three-file Archive schema to the public renderer API.
 * Ownership moved to owner-list.json and accepted author inputs moved under
 * build-output.inputs; neither detail belongs in lax-website itself.
 */
export function loadWebsiteSubmissions(
  archiveDirectory: string,
  localFolder?: string,
): WebsiteSubmission[] {
  const root = path.resolve(archiveDirectory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    const local = localFolder === undefined ? undefined : loadLocalSubmission(localFolder);
    return local === undefined ? [] : [local];
  }

  const local = localFolder === undefined ? undefined : loadLocalSubmission(localFolder);
  const submissions = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SUBMISSION_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((id): WebsiteSubmission => {
      const directory = path.join(root, id);
      const texts = Object.fromEntries(
        ["record.json", "build-output.json", "owner-list.json"].map((name) => [
          name,
          fs.readFileSync(path.join(directory, name), "utf8"),
        ]),
      );
      const files = parseArchiveFiles(id, texts);
      return {
        record: { ...files.record, owners: files.ownerList.owners },
        ...(files.record.state === "deleted"
          ? {}
          : { output: rendererOutput(files.buildOutput, `${id}/build-output.json`) }),
      };
    })
    .filter((submission) => submission.record.id !== local?.record.id);
  if (local !== undefined) submissions.push(local);
  return submissions;
}

/** Run the lax-website generator and serve its output, rebuilding on changes. */
export async function serveWebsite(
  folder: string,
  port: number,
  options: ServeWebsiteOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  console.log("lax serve: loading the pinned lax-website renderer.");
  const archive = databaseDirectory();
  const localFolder = options.databaseOnly ? undefined : path.resolve(folder);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lax-site-"));
  let warning = fs.existsSync(path.join(archive, ".git"))
    ? undefined
    : `The local lax-database checkout is missing. Run \`lax pull-db\` at ${archive}.`;
  writePlaceholder(outDir, warning);
  let timer: NodeJS.Timeout | undefined;
  let building = false;
  let buildAgain = false;
  let archiveWatcher: fs.FSWatcher | undefined;
  const pageBuilder = loadPageBuilder();

  const rebuild = async (): Promise<void> => {
    if (building) {
      buildAgain = true;
      return;
    }
    building = true;
    try {
      const submissions = loadWebsiteSubmissions(archive, localFolder);
      const builder = await pageBuilder;
      await builder.generateSite(submissions, outDir);
      applyWebsiteWarning(outDir, warning);
      console.log(`site rebuilt from ${submissions.length} Archive records`);
    } catch (error) {
      console.error(`site rebuild failed: ${(error as Error).message}`);
    } finally {
      building = false;
      if (buildAgain) {
        buildAgain = false;
        void rebuild();
      }
    }
  };
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 200);
  };

  const ensureArchiveWatcher = (): void => {
    if (archiveWatcher !== undefined || !fs.existsSync(archive)) return;
    try {
      archiveWatcher = fs.watch(archive, { recursive: true }, schedule);
    } catch (error) {
      console.warn(`lax serve: database changes cannot be watched: ${(error as Error).message}`);
    }
  };
  ensureArchiveWatcher();
  if (localFolder !== undefined && fs.existsSync(localFolder)) {
    fs.watch(localFolder, (_event, filename) => {
      if (filename === "build-output.json") schedule();
    });
  }

  const server = http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }
    let relative: string;
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("bad request");
      return;
    }
    if (relative === "" || relative.endsWith("/")) relative += "index.html";
    const file = path.resolve(outDir, relative);
    const inside = file === outDir || file.startsWith(`${outDir}${path.sep}`);
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": (awaitPageBuilderMimeTypes.get(path.extname(file)) ?? "application/octet-stream"),
    });
    response.end(request.method === "HEAD" ? undefined : fs.readFileSync(file));
  });
  const awaitPageBuilderMimeTypes = new Map<string, string>([
    [".html", "text/html; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
  ]);
  void pageBuilder.then((builder) => {
    for (const [extension, mime] of Object.entries(builder.mimeTypes)) {
      awaitPageBuilderMimeTypes.set(extension, mime);
    }
  }).catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      console.log(`lax serve: http://localhost:${port}/ (Ctrl-C to stop)`);
      resolve();
    });
  });
  void rebuild();

  let announcedWarning: string | undefined;
  const refreshFreshness = async (): Promise<void> => {
    const next = websiteDatabaseWarning(await databaseFreshnessAsync(), archive);
    ensureArchiveWatcher();
    if (next !== warning) {
      warning = next;
      schedule();
    }
    if (next !== undefined && next !== announcedWarning) {
      console.warn(`lax serve: warning: ${next}`);
      announcedWarning = next;
    } else if (next === undefined) {
      announcedWarning = undefined;
    }
  };
  void refreshFreshness();
  const freshnessInterval = setInterval(
    () => void refreshFreshness(),
    positiveInterval("LAX_DATABASE_POLL_INTERVAL_MS", 60_000),
  );
  freshnessInterval.unref();
}

export function websiteDatabaseWarning(
  freshness: DatabaseFreshness,
  directory = databaseDirectory(),
): string | undefined {
  if (freshness.status === "current") return undefined;
  if (freshness.status === "stale") {
    return "The local lax-database is out of date. Run `lax pull-db` and reload this preview.";
  }
  if (freshness.status === "missing") {
    return `The local lax-database checkout is missing. Run \`lax pull-db\` at ${directory}.`;
  }
  if (freshness.status === "invalid") {
    return `The local lax-database checkout at ${directory} is invalid. Move it aside and run \`lax pull-db\`.`;
  }
  return "The local lax-database freshness could not be verified because its remote is unreachable.";
}

export function applyWebsiteWarning(outDir: string, warning?: string): void {
  const stylesheet = "lax-local-warning.css";
  walkHtml(outDir, (html) => {
    const clean = html
      .replace(new RegExp(`<link rel="stylesheet" href="/${stylesheet}">`, "gu"), "")
      .replace(/<aside class="lax-local-warning" role="status">[\s\S]*?<\/aside>/gu, "");
    if (warning === undefined) return clean;
    const withCss = clean.replace("</head>", `<link rel="stylesheet" href="/${stylesheet}"></head>`);
    const banner = `<aside class="lax-local-warning" role="status">${escapeHtml(warning)}</aside>`;
    return withCss.replace(/<body([^>]*)>/u, `<body$1>${banner}`);
  });
  if (warning !== undefined) {
    fs.writeFileSync(
      path.join(outDir, stylesheet),
      ".lax-local-warning{margin:0;padding:.75rem 1rem;background:#fff3cd;color:#4d3b00;" +
        "border-bottom:1px solid #e2c55b;font:600 14px/1.4 system-ui,sans-serif;text-align:center}",
    );
  }
}

function writePlaceholder(outDir: string, warning?: string): void {
  fs.writeFileSync(
    path.join(outDir, "index.html"),
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" " +
      "content=\"width=device-width,initial-scale=1\"><title>Lax local preview</title></head>" +
      `<body><main><h1>Lax local preview</h1><p>Building the website…</p>${
        warning === undefined ? "" : `<p>${escapeHtml(warning)}</p>`
      }</main></body></html>`,
  );
}

function walkHtml(directory: string, transform: (html: string) => string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walkHtml(filename, transform);
    else if (entry.isFile() && entry.name.endsWith(".html")) {
      fs.writeFileSync(filename, transform(fs.readFileSync(filename, "utf8")));
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function positiveInterval(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function loadLocalSubmission(folder: string): WebsiteSubmission {
  const root = path.resolve(folder);
  const outputFile = path.join(root, "build-output.json");
  const raw = fs.existsSync(outputFile)
    ? parseJson(fs.readFileSync(outputFile, "utf8"), outputFile)
    : undefined;
  const id = isObject(raw) && typeof raw.id === "string" ? raw.id : "local";
  return {
    record: {
      specVersion: "1",
      id,
      state: "draft",
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
      owners: [],
    },
    ...(raw === undefined ? {} : { output: rendererOutput(raw, outputFile) }),
  };
}

function rendererOutput(value: unknown, label: string): Record<string, unknown> | undefined {
  if (!isObject(value)) throw new Error(`${label} must contain a JSON object`);
  const inputs = isObject(value.inputs) ? value.inputs : undefined;
  const manifest = value.manifest ?? inputs?.manifest;
  if (manifest === undefined) return undefined;
  const output: Record<string, unknown> = {
    ...value,
    manifest,
    abstract: value.abstract ?? inputs?.abstract,
  };
  if (!isObject(output.manifest)) throw new Error(`${label} manifest must be an object`);
  if (typeof output.abstract !== "string") throw new Error(`${label} abstract must be a string`);
  for (const name of ["requiredByConcepts", "requiredByProofs", "concepts", "proofs"] as const) {
    if (!Array.isArray(output[name])) throw new Error(`${label} ${name} must be an array`);
  }
  return output;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function loadPageBuilder(): Promise<PageBuilder> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "vendor", "page-builder"),
    path.resolve(here, "..", "..", ".build", "page-builder", "source"),
  ];
  const root = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "dist", "sitegen", "generate.js")),
  );
  if (root === undefined) {
    throw new Error(
      "the pinned lax-website page-builder is missing; run the page-builder fetch and package scripts",
    );
  }
  const generated = await import(
    pathToFileURL(path.join(root, "dist", "sitegen", "generate.js")).href
  ) as { generateSite?: unknown };
  const assets = await import(
    pathToFileURL(path.join(root, "dist", "sitegen", "assets.js")).href
  ) as { SITE_MIME?: unknown };
  if (typeof generated.generateSite !== "function" || !isObject(assets.SITE_MIME)) {
    throw new Error("the bundled lax-website page-builder has an invalid public API");
  }
  return {
    generateSite: generated.generateSite as PageBuilder["generateSite"],
    mimeTypes: assets.SITE_MIME as Record<string, string>,
  };
}
