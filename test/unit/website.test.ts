import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as ui from "../../src/cli/ui.js";
import {
  applyWebsiteWarning,
  attachPaperFiles,
  loadWebsiteSubmissions,
  type PageBuilder,
  serveWebsite,
  websiteDatabaseWarning,
  type WebsitePreview,
} from "../../src/cli/website.js";
import { initialFiles } from "../../src/shared/archive-schema.js";
import { epoch } from "../../src/submission-validation/environments.js";
import { startFakeGhcr, type FakeGhcr } from "../fake-ghcr.js";

const issue = { repositoryId: 123456789, number: 42 };
const alice = { githubId: 10, handle: "alice" };

describe("local website Archive adapter", () => {
  it("joins owner-list.json into records and hides initialization output", () => {
    const archive = temporaryDirectory("lax-site-database-");
    writeSubmission(
      archive,
      "lax-42",
      initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z"),
    );
    fs.mkdirSync(path.join(archive, ".git"));

    expect(loadWebsiteSubmissions(archive)).toEqual([
      {
        record: {
          specVersion: "1",
          id: "lax-42",
          state: "init",
          createdAt: "2026-07-30T10:00:00Z",
          owners: [alice],
        },
        output: undefined,
      },
    ]);
  });

  it("lifts accepted inputs into the lax-website renderer contract", () => {
    const archive = temporaryDirectory("lax-site-database-");
    const files = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    files["build-output.json"] = `${JSON.stringify({
      specVersion: "1",
      id: "lax-42",
      issue,
      inputs: {
        manifest: {
          specVersion: "1",
          id: "lax-42",
          leanVersion: "v4.19.0",
          mathlibVersion: "a".repeat(40),
          title: "Example",
          authors: [],
          bibEntries: [],
        },
        abstract: "An example.",
      },
      requiredByConcepts: [],
      requiredByProofs: [],
      concepts: [],
      proofs: [],
    }, null, 2)}\n`;
    writeSubmission(archive, "lax-42", files);

    const [submission] = loadWebsiteSubmissions(archive);
    expect(submission?.output).toMatchObject({
      id: "lax-42",
      manifest: { title: "Example" },
      abstract: "An example.",
      concepts: [],
      proofs: [],
    });
  });

  it("lets a local build-output replace the matching Archive submission", () => {
    const archive = temporaryDirectory("lax-site-database-");
    writeSubmission(
      archive,
      "lax-42",
      initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z"),
    );
    const local = temporaryDirectory("lax-site-local-");
    fs.writeFileSync(
      path.join(local, "build-output.json"),
      JSON.stringify(localBuildOutput("lax-42", "Local version")),
    );

    const submissions = loadWebsiteSubmissions(archive, local);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.record).toMatchObject({ id: "lax-42", state: "draft" });
    expect(submissions[0]?.output).toMatchObject({ manifest: { title: "Local version" } });
  });

  it("starts with local content when the database is missing", () => {
    const missing = path.join(temporaryDirectory("lax-site-missing-"), "database");
    expect(loadWebsiteSubmissions(missing)).toEqual([]);
    expect(websiteDatabaseWarning({ status: "missing" }, missing)).toBe(
      "Your copy of the archive is missing. Run lax sync.",
    );
  });

  it("adds a visible database warning to every generated page", () => {
    const site = temporaryDirectory("lax-site-output-");
    fs.writeFileSync(
      path.join(site, "index.html"),
      "<!doctype html><html><head></head><body><main>Archive</main></body></html>",
    );
    applyWebsiteWarning(site, "The database is stale.");
    const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
    expect(html).toContain("lax-local-warning");
    expect(html).toContain("The database is stale.");
    expect(fs.existsSync(path.join(site, "lax-local-warning.css"))).toBe(true);

    applyWebsiteWarning(site);
    expect(fs.readFileSync(path.join(site, "index.html"), "utf8")).not.toContain(
      "lax-local-warning",
    );
  });
});

describe("the local preview", () => {
  const environment = {
    home: process.env.LAX_HOME,
    url: process.env.LAX_DATABASE_URL,
    poll: process.env.LAX_DATABASE_POLL_INTERVAL_MS,
  };
  // A preview leaves a listening server, two watchers, and a freshness poll
  // behind: the handle `onListening` hands out is how this suite puts them down
  // again so vitest can exit.
  let preview: WebsitePreview | undefined;
  const blockers: http.Server[] = [];

  beforeEach(() => {
    ui.configure({ color: false });
    // One poll is enough: the immediate one. A second, mid-assertion, would race.
    process.env.LAX_DATABASE_POLL_INTERVAL_MS = "600000";
  });

  afterEach(async () => {
    await preview?.close();
    preview = undefined;
    for (const blocker of blockers.splice(0)) {
      blocker.closeAllConnections();
      await new Promise<void>((resolve) => blocker.close(() => { resolve(); }));
    }
    restore("LAX_HOME", environment.home);
    restore("LAX_DATABASE_URL", environment.url);
    restore("LAX_DATABASE_POLL_INTERVAL_MS", environment.poll);
  });

  it("opens with the URL and says what it is showing once the first render knows", async () => {
    currentDatabase(["lax-1", "lax-2"]);
    const local = temporaryDirectory("lax-serve-local-");
    fs.writeFileSync(
      path.join(local, "build-output.json"),
      JSON.stringify(localBuildOutput("lax-50", "Bounded gaps")),
    );
    const port = await freePort();
    const renderer = stubRenderer();
    const output = capture();

    try {
      await serveWebsite(local, port, {
        renderer,
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    expect(preview?.port).toBe(port);
    expect(trimmed(output.lines)).toEqual([
      "  Preview",
      "",
      `  http://localhost:${port}`,
      "",
      "  lax-50 and 2 published submissions.",
      "  Rebuilds when lax build writes a new result. Ctrl-C to stop.",
    ]);

    const page = await fetch(`http://localhost:${port}/`);
    expect(await page.text()).toContain("rendered by the stub");

    // The renderer is told the epoch this CLI's own table names, not the one
    // its config carried when it was released.
    expect(renderer.epochs).toEqual([epoch().id]);

    // A later render is one dim line, not a sentence.
    const rebuilt = capture();
    try {
      fs.writeFileSync(
        path.join(local, "build-output.json"),
        JSON.stringify(localBuildOutput("lax-50", "Bounded gaps, again")),
      );
      await waitFor(
        () => rebuilt.lines.some((line) => /^ {2}↻ \d{2}:\d{2}:\d{2} {2}rebuilt$/u.test(line)),
        "the rebuild line",
      );
    } finally {
      rebuilt.restore();
    }
    expect(renderer.renders).toBeGreaterThan(1);
    expect(output.lines.join("\n")).not.toContain("site rebuilt from");
    expect(output.lines.join("\n")).not.toContain("loading the pinned");
  });

  it("moves to the next free port and says so", async () => {
    currentDatabase([]);
    const local = temporaryDirectory("lax-serve-local-");
    // Bound, and left bound for the whole test: `serveWebsite` must walk past it
    // rather than die of EADDRINUSE. The port above it is free the same way
    // `freePort` is free — nothing else here is expected to take it mid-test.
    const blocker = await listening();
    blockers.push(blocker);
    const taken = (blocker.address() as AddressInfo).port;
    const output = capture();

    try {
      await serveWebsite(local, taken, {
        renderer: stubRenderer(),
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    expect(preview?.port).toBe(taken + 1);
    expect(trimmed(output.lines)).toEqual([
      "  Preview",
      "",
      `  http://localhost:${taken + 1}`,
      "",
      "  No published submissions yet.",
      "  Rebuilds when lax build writes a new result. Ctrl-C to stop.",
      "",
      `  ! Port ${taken} was busy, so this preview is on ${taken + 1}.`,
    ]);
  });

  it("counts only the archive with --database-only, and notes a missing copy", async () => {
    const home = temporaryDirectory("lax-serve-home-");
    const archive = path.join(home, "lax-database");
    fs.mkdirSync(archive);
    writeSubmission(
      archive,
      "lax-7",
      initialFiles("lax-7", issue, alice, "2026-07-30T10:00:00Z"),
    );
    process.env.LAX_HOME = home;
    const port = await freePort();
    const output = capture();

    try {
      await serveWebsite(temporaryDirectory("lax-serve-local-"), port, {
        databaseOnly: true,
        renderer: stubRenderer(),
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    expect(trimmed(output.lines)).toEqual([
      "  Preview",
      "",
      `  http://localhost:${port}`,
      "",
      "  1 published submission.",
      "  Rebuilds when lax build writes a new result. Ctrl-C to stop.",
      "",
      "  ! Your copy of the archive is missing.",
      "    Run lax sync.",
    ]);
  });

  it("keeps a failed render on the screen and stays up", async () => {
    currentDatabase([]);
    const port = await freePort();
    const output = capture();

    try {
      await serveWebsite(temporaryDirectory("lax-serve-local-"), port, {
        renderer: {
          generateSite: () => Promise.reject(new Error("the renderer exploded")),
          mimeTypes: {},
        },
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    expect(preview?.port).toBe(port);
    expect(output.lines.join("\n")).toMatch(
      /^ {2}✗ \d{2}:\d{2}:\d{2} {2}the preview could not be rebuilt$/mu,
    );
    expect(output.lines).toContain("    the renderer exploded");
    // Still a live preview, and no count it could not have known.
    expect(output.lines).toContain("  Rebuilds when lax build writes a new result. Ctrl-C to stop.");
    expect(output.lines.join("\n")).not.toContain("published submission");
  });

  it("rejects a port that is not a port at all", async () => {
    await expect(serveWebsite(".", 0)).rejects.toThrow("between 1 and 65535");
    await expect(serveWebsite(".", 70_000)).rejects.toThrow("between 1 and 65535");
  });
});

describe("the paper surfaces in the preview", () => {
  const environment = {
    home: process.env.LAX_HOME,
    url: process.env.LAX_DATABASE_URL,
    poll: process.env.LAX_DATABASE_POLL_INTERVAL_MS,
    registry: process.env.LAX_CAPTURE_REGISTRY_URL,
  };
  let preview: WebsitePreview | undefined;
  let ghcr: FakeGhcr | undefined;

  beforeEach(() => {
    ui.configure({ color: false });
    process.env.LAX_DATABASE_POLL_INTERVAL_MS = "600000";
  });

  afterEach(async () => {
    await preview?.close();
    preview = undefined;
    await ghcr?.close();
    ghcr = undefined;
    restore("LAX_HOME", environment.home);
    restore("LAX_DATABASE_URL", environment.url);
    restore("LAX_DATABASE_POLL_INTERVAL_MS", environment.poll);
    restore("LAX_CAPTURE_REGISTRY_URL", environment.registry);
  });

  it("hands the local paper.pdf and paper-web.tar to the renderer and watches both", async () => {
    currentDatabase([]);
    const local = temporaryDirectory("lax-serve-paper-");
    const pdf = Buffer.from("%PDF-1.7\nlocal paper\n%%EOF\n", "latin1");
    const bundle = Buffer.alloc(1024);
    bundle.write("ustar", 257, "latin1");
    fs.writeFileSync(
      path.join(local, "build-output.json"),
      JSON.stringify(paperBuildOutput("lax-50", digestOf(pdf), digestOf(bundle))),
    );
    fs.writeFileSync(path.join(local, "paper.pdf"), pdf);
    fs.writeFileSync(path.join(local, "paper-web.tar"), bundle);
    const port = await freePort();
    const renderer = stubRenderer();
    const output = capture();

    try {
      await serveWebsite(local, port, {
        renderer,
        onListening: (live) => { preview = live; },
      });

      expect(renderer.seen.at(-1)).toEqual([
        {
          id: "lax-50",
          paperFile: path.join(local, "paper.pdf"),
          bundleFile: path.join(local, "paper-web.tar"),
        },
      ]);

      // A rebuilt paper is the same news as a rebuilt output: the watcher
      // schedules a render for it.
      const renders = renderer.renders;
      fs.writeFileSync(path.join(local, "paper.pdf"), Buffer.concat([pdf, Buffer.from("v2\n")]));
      await waitFor(() => renderer.renders > renders, "a rebuild after paper.pdf changed");
    } finally {
      output.restore();
    }
  });

  it("resolves a database record's paper and bundle through the ~/.lax caches", async () => {
    const pdf = Buffer.from("%PDF-1.7\narchive paper\n%%EOF\n", "latin1");
    const bundle = Buffer.alloc(1536);
    bundle.write("index.json", 0, "latin1");
    bundle.write("ustar", 257, "latin1");
    const home = currentDatabase([]);
    writeSubmission(
      path.join(home, "lax-database"),
      "lax-9",
      draftFilesWithPaper("lax-9", digestOf(pdf), digestOf(bundle)),
    );
    ghcr = await startFakeGhcr();
    process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;
    ghcr.state.blobs.set(`sha256:${digestOf(pdf)}`, pdf);
    ghcr.state.blobs.set(`sha256:${digestOf(bundle)}`, bundle);
    const port = await freePort();
    const renderer = stubRenderer();
    const output = capture();

    try {
      await serveWebsite(temporaryDirectory("lax-serve-local-"), port, {
        databaseOnly: true,
        renderer,
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    const paperFile = path.join(home, "papers", `${digestOf(pdf)}.pdf`);
    const bundleFile = path.join(home, "bundles", `${digestOf(bundle)}.tar`);
    expect(renderer.seen.at(-1)).toEqual([{ id: "lax-9", paperFile, bundleFile }]);
    expect(fs.readFileSync(paperFile)).toEqual(pdf);
    expect(fs.readFileSync(bundleFile)).toEqual(bundle);
  });

  it("renders the page without the viewer when the registry is unreachable", async () => {
    const pdf = Buffer.from("%PDF-1.7\nunreachable\n%%EOF\n", "latin1");
    const home = currentDatabase([]);
    writeSubmission(
      path.join(home, "lax-database"),
      "lax-9",
      draftFilesWithPaper("lax-9", digestOf(pdf)),
    );
    // A registry that answers nothing: the port was real once and is closed.
    const probe = await listening();
    const dead = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => probe.close(() => { resolve(); }));
    process.env.LAX_CAPTURE_REGISTRY_URL = dead;
    const port = await freePort();
    const renderer = stubRenderer();
    const output = capture();

    try {
      await serveWebsite(temporaryDirectory("lax-serve-local-"), port, {
        databaseOnly: true,
        renderer,
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    // The preview is up and the record rendered — just without the file.
    expect(renderer.seen.at(-1)).toEqual([{ id: "lax-9" }]);
    const page = await fetch(`http://localhost:${preview!.port}/`);
    expect(await page.text()).toContain("rendered by the stub");
  });

  it("attaches nothing for outputs without a paper and skips memoized failures", async () => {
    const submissions = [
      { record: { id: "lax-1", state: "draft" }, output: { concepts: [] } },
      { record: { id: "lax-2", state: "draft" } },
    ];
    await attachPaperFiles(submissions);
    expect(submissions[0]).not.toHaveProperty("paperFile");
    expect(submissions[1]).not.toHaveProperty("paperFile");

    // A digest that failed moments ago is not retried on the next rebuild.
    ghcr = await startFakeGhcr();
    process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;
    process.env.LAX_HOME = temporaryDirectory("lax-serve-home-");
    const digest = digestOf(Buffer.from("missing"));
    const failed = new Map<string, number>([[digest, Date.now()]]);
    const withPaper = [{
      record: { id: "lax-3", state: "draft" },
      output: {
        paper: {
          pdf: { digest, registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${digest}` },
        },
      },
    }];
    await attachPaperFiles(withPaper, failed);
    expect(withPaper[0]).not.toHaveProperty("paperFile");
    expect(ghcr.requests.length).toBe(0);
  });
});

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A local build output declaring a compiled paper and its derived bundle. */
function paperBuildOutput(id: string, pdfDigest: string, bundleDigest?: string): Record<string, unknown> {
  return {
    ...localBuildOutput(id, "With a paper"),
    paper: {
      folder: "paper",
      main: "main.tex",
      engine: "pdflatex",
      pdf: { digest: pdfDigest, bytes: 1, pages: 2 },
      pageSizes: [[612, 792]],
      marks: [],
      ...(bundleDigest === undefined
        ? {}
        : {
            web: {
              format: { tool: "reflowtex", rev: "0".repeat(40), schema: "0".repeat(64) },
              bundle: { digest: bundleDigest, bytes: 1 },
            },
          }),
    },
  };
}

/** A draft archive record whose build output records registry blobs. */
function draftFilesWithPaper(
  id: string,
  pdfDigest: string,
  bundleDigest?: string,
): Record<string, string> {
  const reference = (digest: string): string => `ghcr.io/lax-archive/lax-captures@sha256:${digest}`;
  const output = paperBuildOutput(id, pdfDigest, bundleDigest) as {
    paper: { pdf: Record<string, unknown>; web?: { bundle: Record<string, unknown> } };
  };
  output.paper.pdf.registryBlob = reference(pdfDigest);
  if (output.paper.web !== undefined) {
    output.paper.web.bundle.registryBlob = reference(bundleDigest!);
  }
  return {
    "record.json": `${JSON.stringify({
      specVersion: "1",
      id,
      state: "draft",
      createdAt: "2026-07-30T10:00:00Z",
      source: {
        repository: "https://github.com/alice/formalization",
        commit: "0".repeat(40),
        folder: ".",
      },
    })}\n`,
    "build-output.json": `${JSON.stringify({
      issue,
      ...output,
    })}\n`,
    "owner-list.json": `${JSON.stringify({ specVersion: "1", owners: [alice] })}\n`,
  };
}

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSubmission(root: string, id: string, files: Record<string, string>): void {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
}

function localBuildOutput(id: string, title: string): Record<string, unknown> {
  return {
    specVersion: "1",
    id,
    manifest: {
      specVersion: "1",
      id,
      leanVersion: "v4.19.0",
      mathlibVersion: "a".repeat(40),
      title,
      authors: [],
      bibEntries: [],
    },
    abstract: "",
    requiredByConcepts: [],
    requiredByProofs: [],
    concepts: [],
    proofs: [],
  };
}

/**
 * A temp LAX_HOME whose lax-database is its own git remote: `git ls-remote` then
 * answers from disk, so the freshness poll stays offline and reports `current` —
 * no note, and nothing asynchronous racing the assertions.
 */
function currentDatabase(ids: readonly string[]): string {
  const home = temporaryDirectory("lax-serve-home-");
  const archive = path.join(home, "lax-database");
  fs.mkdirSync(archive);
  for (const id of ids) {
    writeSubmission(archive, id, initialFiles(id, issue, alice, "2026-07-30T10:00:00Z"));
  }
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", archive, ...args], {
      stdio: "ignore",
    });
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "records");
  process.env.LAX_HOME = home;
  process.env.LAX_DATABASE_URL = archive;
  return home;
}

/** What the stub renderer was handed, one snapshot per render. */
interface SeenSubmission {
  id: string;
  paperFile?: string;
  bundleFile?: string;
}

interface StubRenderer extends PageBuilder {
  renders: number;
  seen: SeenSubmission[][];
  /** The epoch of each render: the argument a renderer released before
   * environments existed simply ignores. */
  epochs: Array<string | undefined>;
}

/** A renderer standing in for the pinned lax-website bundle, which only a
 * release carries: it writes one page, counts how often it was asked to,
 * and records the per-submission renderer inputs the serve wiring feeds. */
function stubRenderer(): StubRenderer {
  const builder: StubRenderer = {
    renders: 0,
    seen: [],
    epochs: [],
    generateSite: async (submissions, outDir, epoch) => {
      builder.renders += 1;
      builder.epochs.push(epoch);
      builder.seen.push(
        (submissions as Array<{ record: { id: string }; paperFile?: string; bundleFile?: string }>).map(
          (submission) => ({
            id: submission.record.id,
            ...(submission.paperFile === undefined ? {} : { paperFile: submission.paperFile }),
            ...(submission.bundleFile === undefined ? {} : { bundleFile: submission.bundleFile }),
          }),
        ),
      );
      fs.writeFileSync(
        path.join(outDir, "index.html"),
        "<!doctype html><html><head></head><body>rendered by the stub</body></html>",
      );
    },
    mimeTypes: { ".html": "text/html; charset=utf-8" },
  };
  return builder;
}

/** A port nothing is listening on — as close to a promise as an OS makes. */
async function freePort(): Promise<number> {
  const probe = await listening();
  const { port } = probe.address() as AddressInfo;
  probe.closeAllConnections();
  await new Promise<void>((resolve) => probe.close(() => { resolve(); }));
  return port;
}

function listening(): Promise<http.Server> {
  const server = http.createServer();
  return new Promise((resolve) => {
    server.listen(0, () => { resolve(server); });
  });
}

/** Everything `ui` printed, with the ANSI-free lines it printed them as. */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  const errors = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: string | Uint8Array): boolean => {
      lines.push(...String(chunk).replace(/\n$/u, "").split("\n"));
      return true;
    }) as typeof process.stderr.write);
  return {
    lines,
    restore: () => {
      log.mockRestore();
      errors.mockRestore();
    },
  };
}

/** The block itself: `ui` opens and closes with blank lines whose presence
 * depends on what the previous command printed, which is not under test. */
function trimmed(lines: readonly string[]): string[] {
  const kept = [...lines];
  while (kept[0] === "") kept.shift();
  while (kept.at(-1) === "") kept.pop();
  return kept;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
