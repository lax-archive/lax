import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArchiveFiles } from "../shared/archive-schema.js";
import { SUBMISSION_ID_PATTERN } from "../shared/constants.js";
import { isObject } from "../shared/validation.js";
import { epoch } from "../submission-validation/environments.js";
import {
  databaseDirectory,
  databaseFreshnessAsync,
  type DatabaseFreshness,
} from "./database.js";
import { bundleCachePath, ensureCachedPaperBlob, paperCachePath } from "./papers-cache.js";
import * as ui from "./ui.js";
import {
  downloadedPageBuilderDirectory,
  installWebsiteRendererIfMissing,
  websiteRendererIsReady,
} from "./website-renderer.js";

interface WebsiteSubmission {
  record: Record<string, unknown> & { id: string; state: string };
  output?: Record<string, unknown>;
  /** The compiled paper's PDF on disk — the renderer's `SiteSubmission.paperFile`.
   * The local folder's own `paper.pdf`, or a papers-cache hit for a database
   * record. Renderers that predate the paper page ignore it. */
  paperFile?: string;
  /** The derived reflow bundle tar on disk (`SiteSubmission.bundleFile`). */
  bundleFile?: string;
}

export interface PageBuilder {
  /** The third argument is the archive's epoch. A renderer released before
   * environments existed ignores it and uses the `EPOCH` its own config was
   * released with; a newer one prefers ours, which is the table the author's
   * installed CLI actually validates against. */
  generateSite(submissions: WebsiteSubmission[], outDir: string, epoch?: string): Promise<void>;
  mimeTypes: Record<string, string>;
}

/** How many ports above the requested one a preview tries before giving up. */
const PORT_ATTEMPTS = 20;

export interface ServeWebsiteOptions {
  databaseOnly?: boolean;
  /**
   * Handed the preview as soon as it is listening. The CLI ignores it — an
   * author stops a preview with Ctrl-C, which ends the process — but a test has
   * to be able to put the server, the watchers, and the freshness poll down
   * again, and the return value cannot carry them: `serveWebsite` resolves only
   * once the first render has produced its counts.
   */
  onListening?: (preview: WebsitePreview) => void;
  /**
   * The renderer to draw the pages with. The CLI never passes one — it loads the
   * pinned lax-website bundle, which only a release carries — so this is how a
   * test previews anything at all.
   */
  renderer?: PageBuilder;
}

/** A live preview: the port it actually bound, and the way to stop it. */
export interface WebsitePreview {
  port: number;
  close: () => Promise<void>;
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
  const archive = databaseDirectory();
  const localFolder = options.databaseOnly ? undefined : path.resolve(folder);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lax-site-"));
  let advice = fs.existsSync(path.join(archive, ".git"))
    ? undefined
    : databaseAdvice({ status: "missing" }, archive);
  // What the preview opens on. An author who ran `lax serve` in a folder came
  // to look at that folder's pages, and the archive's front page is one link
  // away from them; only `--database-only`, which renders no folder, opens on
  // the index. `linked` is the page the printed link names, `localPage` the one
  // the last render actually filed the folder under — a build landing mid-
  // preview moves it from `local` to the reserved id, and the tab the author
  // already has open is redirected rather than left on a page nothing writes.
  const linked = localFolder === undefined
    ? undefined
    : submissionPagePath(localSubmissionId(localFolder));
  let localPage = linked;
  writePlaceholder(outDir, bannerText(advice), linked);
  let timer: NodeJS.Timeout | undefined;
  let building = false;
  let buildAgain = false;
  let archiveWatcher: fs.FSWatcher | undefined;
  let localWatcher: fs.FSWatcher | undefined;
  let freshnessPoll: NodeJS.Timeout | undefined;
  // Until the Preview block is on the screen a finished render is not news: it
  // is the render that block is waiting for the counts of. And once the caller
  // has closed the preview, nothing still in flight gets to speak.
  let opened = false;
  let stopped = false;
  let counts: PreviewCounts | undefined;
  const pageBuilder = options.renderer === undefined
    ? loadPageBuilder()
    : Promise.resolve(options.renderer);
  /** Failed paper/bundle downloads, memoized across rebuilds of this preview. */
  const failedPaperFetches = new Map<string, number>();

  const rebuild = async (): Promise<void> => {
    if (building) {
      buildAgain = true;
      return;
    }
    building = true;
    try {
      const submissions = loadWebsiteSubmissions(archive, localFolder);
      if (localFolder !== undefined) {
        localPage = submissionPagePath(submissions.at(-1)?.record.id ?? LOCAL_SUBMISSION_ID);
      }
      await attachPaperFiles(submissions, failedPaperFetches);
      const builder = await pageBuilder;
      await builder.generateSite(submissions, outDir, epoch().id);
      applyWebsiteWarning(outDir, bannerText(advice));
      counts = previewCounts(submissions, localFolder);
      if (opened && !stopped) ui.faint(`↻ ${clock()}  rebuilt`);
    } catch (error) {
      // A failed rebuild stays visible: the pages the author is looking at are
      // now older than the folder they came from, and only the author can fix
      // why. The preview keeps serving the last good render.
      if (!stopped) {
        ui.failure(`${clock()}  the preview could not be rebuilt\n${(error as Error).message}`);
      }
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
      // Machinery, not a note: this watch only catches records arriving from
      // `lax sync`, and the promise the Preview block makes — a rebuild when a
      // build writes a new result — is kept by the author's own folder watch,
      // which is a separate handle.
      ui.verbose(`the archive cannot be watched for changes: ${(error as Error).message}`);
    }
  };
  ensureArchiveWatcher();
  if (localFolder !== undefined && fs.existsSync(localFolder)) {
    // The build's whole output set: the result, the compiled paper beside
    // it, and the derived web bundle — a rebuild of any of the three is the
    // same news to the preview.
    const rendered = new Set(["build-output.json", "paper.pdf", "paper-web.tar"]);
    localWatcher = fs.watch(localFolder, (_event, filename) => {
      if (typeof filename === "string" && rendered.has(filename)) schedule();
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
      if (
        inside &&
        linked !== undefined &&
        localPage !== undefined &&
        localPage !== linked &&
        relative === `${linked}index.html`
      ) {
        response.writeHead(302, { location: `/${localPage}` });
        response.end();
        return;
      }
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
  const bound = await listenNearby(server, port);
  options.onListening?.({
    port: bound,
    close: async (): Promise<void> => {
      stopped = true;
      clearTimeout(timer);
      if (freshnessPoll !== undefined) clearInterval(freshnessPoll);
      archiveWatcher?.close();
      localWatcher?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  });

  ui.title("Preview");
  ui.link(`http://localhost:${bound}${linked === undefined ? "" : `/${linked}`}`);
  // The first render is the one that knows how many submissions there are, so
  // the counts wait for it rather than being guessed at. The link does not
  // wait: loading the renderer takes a moment, and the URL is the line the
  // author opened this command for.
  await rebuild();
  opened = true;
  ui.blank();
  if (counts !== undefined) ui.line(submissionsLine(counts));
  ui.line(`Rebuilds when ${ui.cmd("lax build")} writes a new result. Ctrl-C to stop.`);

  const notes = new ui.Notes();
  if (bound !== port) notes.add(`Port ${port} was busy, so this preview is on ${bound}.`);
  if (advice !== undefined) notes.add(advice.headline, ...noteFix(advice));
  notes.print();
  ui.blank();

  let announced = bannerText(advice);
  const refreshFreshness = async (): Promise<void> => {
    const next = databaseAdvice(await databaseFreshnessAsync(), archive);
    const banner = bannerText(next);
    ensureArchiveWatcher();
    if (banner !== bannerText(advice)) {
      advice = next;
      schedule();
    }
    if (next !== undefined && banner !== announced && !stopped) {
      const note = new ui.Notes();
      note.add(next.headline, ...noteFix(next));
      note.print();
      announced = banner;
    } else if (next === undefined) {
      announced = undefined;
    }
  };
  void refreshFreshness();
  freshnessPoll = setInterval(
    () => void refreshFreshness(),
    positiveInterval("LAX_DATABASE_POLL_INTERVAL_MS", 60_000),
  );
  freshnessPoll.unref();
}

/**
 * Bind the requested port, or the next free one above it. Two previews at once
 * is an ordinary thing to want, and the second one starting is a better answer
 * than `EADDRINUSE` and an exit. Only a taken port is walked past: every other
 * listen error — a privileged port, an address that cannot be bound — would
 * repeat identically on the next one.
 */
async function listenNearby(server: http.Server, first: number): Promise<number> {
  const last = Math.min(first + PORT_ATTEMPTS - 1, 65_535);
  for (let candidate = first; candidate <= last; candidate += 1) {
    try {
      await listenOnce(server, candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(
    `ports ${first}-${last} are all in use; stop one of those previews or pass --port`,
  );
}

function listenOnce(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listening = (): void => {
      server.off("error", failed);
      resolve();
    };
    const failed = (error: Error): void => {
      server.off("listening", listening);
      reject(error);
    };
    server.once("listening", listening);
    server.once("error", failed);
    server.listen(port);
  });
}

interface PreviewCounts {
  /** The id of the folder being previewed, once a build has given it one. */
  localId?: string;
  published: number;
}

/**
 * Split what was rendered into the author's own folder and the archive's
 * records: `loadWebsiteSubmissions` appends the local submission last, and calls
 * it `local` until a build has written an id into build-output.json.
 */
function previewCounts(
  submissions: readonly WebsiteSubmission[],
  localFolder: string | undefined,
): PreviewCounts {
  if (localFolder === undefined) return { published: submissions.length };
  const id = submissions.at(-1)?.record.id;
  return {
    ...(id === undefined || id === LOCAL_SUBMISSION_ID ? {} : { localId: id }),
    published: submissions.length - 1,
  };
}

/** `lax-50 and 1,204 published submissions.` — what the preview is showing. */
function submissionsLine(counts: PreviewCounts): string {
  const published = counts.published === 0
    ? "no published submissions yet"
    : `${ui.count(counts.published)} published ${counts.published === 1 ? "submission" : "submissions"}`;
  if (counts.localId === undefined) {
    return `${published.charAt(0).toUpperCase()}${published.slice(1)}.`;
  }
  return `${counts.localId} and ${published}.`;
}

/** `14:22:07` — the author's own wall clock, all a rebuild line has to say. */
function clock(at = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * What to say about a copy of the archive that is not current, in the two halves
 * both surfaces need: the fact, and the one thing to do about it. The in-page
 * banner joins them into a sentence; the terminal note prints the fix on its own
 * line with the command in bold, which is why the command stays behind a
 * markup function rather than being spelled into the prose — HTML must carry no
 * escape codes.
 */
interface DatabaseAdvice {
  headline: string;
  fix?: (emphasise: (command: string) => string) => string;
}

function databaseAdvice(
  freshness: DatabaseFreshness,
  directory: string,
): DatabaseAdvice | undefined {
  const sync = (emphasise: (command: string) => string): string => `Run ${emphasise("lax sync")}.`;
  if (freshness.status === "current") return undefined;
  if (freshness.status === "stale") {
    return { headline: "Your copy of the archive is out of date.", fix: sync };
  }
  if (freshness.status === "missing") {
    return { headline: "Your copy of the archive is missing.", fix: sync };
  }
  if (freshness.status === "invalid") {
    return {
      headline: `Your copy of the archive at ${ui.tilde(directory)} is not a usable clone.`,
      fix: (emphasise) => `Move it aside and run ${emphasise("lax sync")}.`,
    };
  }
  return { headline: "Your copy of the archive could not be checked: GitHub is unreachable." };
}

/** The advice as one plain sentence, for the banner drawn into every page. */
function bannerText(advice: DatabaseAdvice | undefined): string | undefined {
  if (advice === undefined) return undefined;
  const fix = advice.fix?.((command) => command);
  return fix === undefined ? advice.headline : `${advice.headline} ${fix}`;
}

/** The advice's fix as the note's second line, with the command in bold. */
function noteFix(advice: DatabaseAdvice): string[] {
  const fix = advice.fix?.(ui.cmd);
  return fix === undefined ? [] : [fix];
}

export function websiteDatabaseWarning(
  freshness: DatabaseFreshness,
  directory = databaseDirectory(),
): string | undefined {
  return bannerText(databaseAdvice(freshness, directory));
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

/**
 * The loading page, written to the site root and — so the link the preview
 * prints answers from the first second, before any renderer has loaded — to the
 * previewed folder's own page. The first successful render replaces the whole
 * directory, so neither copy outlives it.
 */
function writePlaceholder(outDir: string, warning?: string, localPage?: string): void {
  const html = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" " +
    "content=\"width=device-width,initial-scale=1\"><title>Lax local preview</title></head>" +
    `<body><main><h1>Lax local preview</h1><p>Building the website…</p>${
      warning === undefined ? "" : `<p>${escapeHtml(warning)}</p>`
    }</main></body></html>`;
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  if (localPage === undefined) return;
  const directory = path.join(outDir, localPage);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "index.html"), html);
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

/**
 * The id a folder's pages are filed under before `lax init` has allocated one:
 * `lax serve` renders a folder against a synthetic draft record, and the
 * renderer files every submission by its record id.
 */
const LOCAL_SUBMISSION_ID = "local";

/**
 * The id the renderer will file this folder's pages under, read without
 * rendering anything: the preview prints its link before the first render
 * finishes, and the link may not name a different id than the pages do. Never
 * throws — an unreadable `build-output.json` is the render's error to report,
 * and the folder still has the placeholder page this id addresses.
 */
function localSubmissionId(folder: string): string {
  const outputFile = path.join(path.resolve(folder), "build-output.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(outputFile, "utf8")) as unknown;
  } catch {
    return LOCAL_SUBMISSION_ID;
  }
  return isObject(raw) && typeof raw.id === "string" ? raw.id : LOCAL_SUBMISSION_ID;
}

/**
 * The site path a submission's page is at, for an id the preview is willing to
 * speak: `lax build` writes the id and `lax serve` turns it into a directory
 * under the output tree, a URL it prints, and a redirect target, so an id that
 * is not one plain path segment gets none of the three — the preview opens on
 * the index instead, and the render still shows the folder as it always did.
 * Deliberately wider than `SUBMISSION_ID_PATTERN`: the ids that reach here also
 * include the scaffold's `lax-0` and the pre-build `local`.
 */
function submissionPagePath(id: string): string | undefined {
  return /^[A-Za-z0-9][\w.-]*$/u.test(id) ? `${id}/` : undefined;
}

function loadLocalSubmission(folder: string): WebsiteSubmission {
  const root = path.resolve(folder);
  const outputFile = path.join(root, "build-output.json");
  const raw = fs.existsSync(outputFile)
    ? parseJson(fs.readFileSync(outputFile, "utf8"), outputFile)
    : undefined;
  const id = isObject(raw) && typeof raw.id === "string" ? raw.id : LOCAL_SUBMISSION_ID;
  const submission: WebsiteSubmission = {
    record: {
      specVersion: "1",
      id,
      state: "draft",
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
      owners: [],
    },
    ...(raw === undefined ? {} : { output: rendererOutput(raw, outputFile) }),
  };
  // A local build writes the compiled paper and the derived web bundle
  // beside build-output.json (removing stale ones), so presence is the
  // whole check here; a record that instead points at the registry has no
  // local file and is resolved through the caches by attachPaperFiles.
  const paper = isObject(submission.output?.paper) ? submission.output.paper : undefined;
  if (paper !== undefined) {
    const pdf = path.join(root, "paper.pdf");
    if (fs.existsSync(pdf)) submission.paperFile = pdf;
    if (isObject(paper.web)) {
      const bundle = path.join(root, "paper-web.tar");
      if (fs.existsSync(bundle)) submission.bundleFile = bundle;
    }
  }
  return submission;
}

/** How long a failed paper or bundle download stays memoized before a later
 * rebuild may retry it: an offline preview must render without the viewer,
 * not stall every rebuild re-asking the registry for the same bytes. */
const FAILED_FETCH_RETRY_MS = 5 * 60_000;

/**
 * Resolve every recorded `registryBlob` the loaded submissions carry into
 * `paperFile`/`bundleFile` through the `~/.lax` caches (papers-cache.ts).
 * Data-driven, not identity-driven: whichever submission records a registry
 * address and has no file yet gets the cache lookup, and any failure leaves
 * the field unset — the renderer already degrades to a page without that
 * surface. Never throws; a preview outlives an offline registry.
 */
export async function attachPaperFiles(
  submissions: WebsiteSubmission[],
  failedAt: Map<string, number> = new Map(),
): Promise<void> {
  const resolve = async (
    kind: "paper" | "bundle",
    entry: Record<string, unknown> | undefined,
  ): Promise<string | undefined> => {
    if (
      entry === undefined ||
      typeof entry.digest !== "string" ||
      typeof entry.registryBlob !== "string"
    ) {
      return undefined;
    }
    let cached: string;
    try {
      cached = kind === "paper" ? paperCachePath(entry.digest) : bundleCachePath(entry.digest);
    } catch {
      return undefined;
    }
    // A disk hit is always an answer; the failure memo only spares the
    // preview re-asking the registry for bytes it could not get moments ago.
    if (fs.existsSync(cached)) return cached;
    const failed = failedAt.get(entry.digest);
    if (failed !== undefined && Date.now() - failed < FAILED_FETCH_RETRY_MS) return undefined;
    const file = await ensureCachedPaperBlob(kind, entry.digest, entry.registryBlob);
    if (file === undefined) failedAt.set(entry.digest, Date.now());
    else failedAt.delete(entry.digest);
    return file;
  };
  for (const submission of submissions) {
    const paper = isObject(submission.output?.paper) ? submission.output.paper : undefined;
    if (paper === undefined) continue;
    if (submission.paperFile === undefined) {
      const file = await resolve("paper", isObject(paper.pdf) ? paper.pdf : undefined);
      if (file !== undefined) submission.paperFile = file;
    }
    const web = isObject(paper.web) ? paper.web : undefined;
    if (submission.bundleFile === undefined && web !== undefined) {
      const file = await resolve("bundle", isObject(web.bundle) ? web.bundle : undefined);
      if (file !== undefined) submission.bundleFile = file;
    }
  }
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
  const downloaded = downloadedPageBuilderDirectory();
  try {
    if (await installWebsiteRendererIfMissing()) {
      ui.verbose("downloaded the current Website renderer");
    }
  } catch (error) {
    ui.verbose(
      `Website renderer could not be downloaded; using the bundled fallback: ${(error as Error).message}`,
    );
  }
  const candidates = [
    downloaded,
    path.join(here, "vendor", "page-builder"),
    path.resolve(here, "..", "..", ".build", "page-builder", "source"),
  ];
  const failures: string[] = [];
  for (const [index, root] of candidates.entries()) {
    const ready = index === 0
      ? websiteRendererIsReady(root)
      : fs.existsSync(path.join(root, "dist", "sitegen", "generate.js"));
    if (!ready) {
      if (index === 0 && fs.existsSync(root)) {
        ui.verbose("downloaded Website renderer is incomplete; using the bundled fallback");
      }
      continue;
    }
    try {
      const generated = await import(
        pathToFileURL(path.join(root, "dist", "sitegen", "generate.js")).href
      ) as { generateSite?: unknown };
      const assets = await import(
        pathToFileURL(path.join(root, "dist", "sitegen", "assets.js")).href
      ) as { SITE_MIME?: unknown };
      if (typeof generated.generateSite !== "function" || !isObject(assets.SITE_MIME)) {
        throw new Error("invalid public API");
      }
      return {
        generateSite: generated.generateSite as PageBuilder["generateSite"],
        mimeTypes: assets.SITE_MIME as Record<string, string>,
      };
    } catch (error) {
      failures.push(`${root}: ${(error as Error).message}`);
      if (index === 0) {
        ui.verbose("downloaded Website renderer is unusable; using the bundled fallback");
      }
    }
  }
  const detail = failures.length === 0 ? "no renderer installation was found" : failures.join("; ");
  throw new Error(
    "the lax-website page-builder is unavailable; reinstall the CLI or run `lax update`: " + detail,
  );
}
