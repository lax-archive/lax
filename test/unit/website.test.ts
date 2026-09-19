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
  localEntries,
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

  it("lists the folder and the siblings its lakefiles reach, built, unbuilt or gone", () => {
    const { b, a, c } = siblingLayout();
    fs.writeFileSync(
      path.join(a, "build-output.json"),
      JSON.stringify({
        ...localBuildOutput("lax-7", "Sibling A"),
        localValidation: { nonstrict: true, siblings: ["Lax5"] },
      }),
    );
    // Before its first build the folder's manifest already names it.
    fs.writeFileSync(path.join(b, "manifest.yaml"), "id: lax-9\ntitle: Drafted B\n");
    // A required checkout that is not there — moved away, or not cloned yet.
    fs.appendFileSync(
      path.join(b, "concepts", "lakefile.toml"),
      '\n[[require]]\nname = "Lax3"\npath = "../../D/concepts"\n',
    );

    // B itself first; A through B's concepts, C through B's proofs and again
    // through A's concepts — once. The proof package's own `../concepts` edge
    // is no sibling, B never lists itself, and D keeps a row that says where
    // it was required.
    expect(localEntries(b)).toEqual([
      { folder: b, id: "lax-9", sibling: false, built: false, title: "Drafted B" },
      {
        folder: a, id: "lax-7", sibling: true, built: true, title: "Sibling A", environment: "v4.19.0",
        nonstrict: ["lax-5"],
      },
      {
        folder: path.join(path.dirname(b), "D"), id: "lax-3", sibling: true, built: false,
        missing: "concepts/lakefile.toml as ../../D/concepts",
      },
      { folder: c, id: "lax-5", sibling: true, built: false },
    ]);
  });

  it("renders built siblings before the folder and never under its id", () => {
    const archive = temporaryDirectory("lax-site-database-");
    writeSubmission(archive, "lax-7", initialFiles("lax-7", issue, alice, "2026-07-30T10:00:00Z"));
    fs.mkdirSync(path.join(archive, ".git"));
    const { b, a, c } = siblingLayout();
    fs.writeFileSync(path.join(b, "build-output.json"), JSON.stringify(localBuildOutput("lax-9", "B")));
    fs.writeFileSync(path.join(a, "build-output.json"), JSON.stringify(localBuildOutput("lax-7", "A")));
    // A sibling that a stale build filed under the folder's own id is dropped.
    fs.writeFileSync(path.join(c, "build-output.json"), JSON.stringify(localBuildOutput("lax-9", "C")));

    const submissions = loadWebsiteSubmissions(archive, b, [a, c]);
    expect(submissions.map((submission) => submission.record.id)).toEqual(["lax-7", "lax-9"]);
    // The local checkout of lax-7 replaces the archive's record of it.
    expect(submissions[0]?.output).toMatchObject({ manifest: { title: "A" } });
    expect(submissions[1]?.output).toMatchObject({ manifest: { title: "B" } });
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
    // A killed preview's output from yesterday is swept on start; this
    // preview's own is removed when it closes.
    const stale = temporaryDirectory("lax-site-");
    const yesterday = new Date(Date.now() - 25 * 60 * 60_000);
    fs.utimesSync(stale, yesterday, yesterday);
    const sitesBefore = siteDirectories();
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
      `  http://localhost:${port}/`,
      "",
      "  lax-50 and 2 published submissions.",
      "  Rebuilds when lax build writes a new result. Ctrl-C to stop.",
    ]);

    // The line the author opened this command for goes to the preview's own
    // front page, which names the folder and links to its page; the archive's
    // front door keeps its place, where the generated pages link to it.
    const frontHtml = await (await fetch(`http://localhost:${port}/`)).text();
    const frontText = text(frontHtml);
    expect(frontText).toContain("Lax local preview");
    expect(frontText).toContain("lax-50 — Bounded gaps");
    expect(frontText).toContain("local build, v4.19.0");
    expect(frontText).toContain("2 published submissions");
    expect(frontText).not.toContain("Building the website");
    expect(frontHtml).toContain('href="/lax-50/"');
    const page = await fetch(`http://localhost:${port}/lax-50/`);
    expect(await page.text()).toContain("the stub's lax-50 page");
    const index = await fetch(`http://localhost:${port}/index.html`);
    expect(await index.text()).toContain("rendered by the stub");

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

    expect(fs.existsSync(stale)).toBe(false);
    // The sweep only removes, so what is new is this preview's own output.
    const own = siteDirectories().filter((name) => !sitesBefore.includes(name));
    expect(own).toHaveLength(1);
    await preview?.close();
    preview = undefined;
    expect(siteDirectories()).not.toContain(own[0]);
  });

  it("redirects the link it printed to the id a mid-preview build allocates", async () => {
    currentDatabase([]);
    const local = temporaryDirectory("lax-serve-local-");
    fs.writeFileSync(path.join(local, "manifest.yaml"), "id: lax-50\ntitle: Bounded gaps\n");
    const port = await freePort();
    const output = capture();

    try {
      await serveWebsite(local, port, {
        renderer: stubRenderer(),
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    expect(trimmed(output.lines)).toContain(`  http://localhost:${port}/`);
    // Before a build, the manifest names the folder, the counts line says it
    // is not built, and the row links the placeholder the renderer filed
    // under the pre-build id — and reloads until the build lands.
    expect(trimmed(output.lines)).toContain("  lax-50 (not built yet) and no published submissions yet.");
    const html = await (await fetch(`http://localhost:${port}/`)).text();
    expect(text(html)).toContain("lax-50 — Bounded gaps\nno build output yet — run lax build in");
    expect(html).toContain('<a href="/local/">');
    expect(html).toContain('<meta http-equiv="refresh" content="5">');
    const before = await fetch(`http://localhost:${port}/local/`);
    expect(await before.text()).toContain("the stub's local page");

    const rebuilt = capture();
    try {
      fs.writeFileSync(
        path.join(local, "build-output.json"),
        JSON.stringify(localBuildOutput("lax-50", "Bounded gaps")),
      );
      await waitFor(
        () => rebuilt.lines.some((line) => /^ {2}↻ \d{2}:\d{2}:\d{2} {2}rebuilt$/u.test(line)),
        "the rebuild line",
      );
    } finally {
      rebuilt.restore();
    }

    // The renderer files the folder under its new id and drops the old page;
    // the tab the author already has open follows it instead of 404ing.
    const after = await fetch(`http://localhost:${port}/local/`, { redirect: "manual" });
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/lax-50/");
    const followed = await fetch(`http://localhost:${port}/local/`);
    expect(await followed.text()).toContain("the stub's lax-50 page");
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
      `  http://localhost:${taken + 1}/`,
      "",
      `  ! Port ${taken} was busy, so this preview is on ${taken + 1}.`,
      "",
      "  No published submissions yet.",
      "  Rebuilds when lax build writes a new result. Ctrl-C to stop.",
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
      `  http://localhost:${port}/`,
      "",
      "  1 published submission.",
      "  Rebuilds when your copy of the archive changes. Ctrl-C to stop.",
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

  it("shows built siblings beside the folder, lists the unbuilt, and watches them", async () => {
    currentDatabase([]);
    const { b, a, c } = siblingLayout();
    fs.writeFileSync(
      path.join(b, "build-output.json"),
      JSON.stringify({
        ...localBuildOutput("lax-9", "B"),
        localValidation: { nonstrict: true, siblings: ["Lax7", "Lax5"] },
      }),
    );
    fs.writeFileSync(path.join(a, "build-output.json"), JSON.stringify(localBuildOutput("lax-7", "A")));
    const port = await freePort();
    const renderer = stubRenderer();
    const output = capture();

    try {
      await serveWebsite(b, port, {
        renderer,
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    // A is fed to the renderer as a further local submission; C, unbuilt, is
    // not — the page builder would refuse an output it cannot resolve.
    expect(renderer.seen.at(-1)).toEqual([{ id: "lax-7" }, { id: "lax-9" }]);
    expect(trimmed(output.lines)).toContain("  lax-9, sibling lax-7, and no published submissions yet.");
    const front = text(await (await fetch(`http://localhost:${port}/`)).text());
    // The row states the local truth the rendered page's draft banner does not.
    expect(front).toContain(
      "lax-9 — B\nnonstrict local build (siblings lax-7, lax-5), v4.19.0 — a nonstrict build previews siblings the archive accepts only as registered git requires",
    );
    expect(front).toContain("lax-7 sibling — A\nlocal build, v4.19.0");
    expect(front).toContain(`lax-5 sibling\nno build output yet — run lax build in ${ui.tilde(c)}`);

    // C's first build is exactly the change the preview waits for — with no
    // watcher on C, the poll over the listed folders catches it.
    let renders = renderer.renders;
    fs.writeFileSync(path.join(c, "build-output.json"), JSON.stringify(localBuildOutput("lax-5", "C")));
    await waitFor(() => renderer.renders > renders, "a rebuild after the sibling was built");
    expect(renderer.seen.at(-1)).toEqual([{ id: "lax-7" }, { id: "lax-5" }, { id: "lax-9" }]);
    expect(text(await (await fetch(`http://localhost:${port}/`)).text())).toContain("lax-5 sibling — C");

    // A moved away keeps its row and says where it was required; moved back,
    // it is rendered again — the poll does not need a folder to exist.
    renders = renderer.renders;
    fs.renameSync(a, `${a}-renamed`);
    await waitFor(() => renderer.renders > renders, "a rebuild after the sibling went missing");
    expect(renderer.seen.at(-1)).toEqual([{ id: "lax-5" }, { id: "lax-9" }]);
    expect(text(await (await fetch(`http://localhost:${port}/`)).text())).toContain(
      "lax-7 sibling\nrequired by concepts/lakefile.toml as ../../A/concepts — folder not found",
    );
    renders = renderer.renders;
    fs.renameSync(`${a}-renamed`, a);
    await waitFor(() => renderer.renders > renders, "a rebuild after the sibling came back");
    expect(renderer.seen.at(-1)).toEqual([{ id: "lax-7" }, { id: "lax-5" }, { id: "lax-9" }]);
  });

  it("treats a local record the renderer skips as a failed preview, and says an archive skip once", async () => {
    currentDatabase(["lax-1"]);
    const { b, a, c } = siblingLayout();
    fs.writeFileSync(path.join(b, "build-output.json"), JSON.stringify(localBuildOutput("lax-9", "B")));
    const port = await freePort();
    const renderer = stubRenderer();
    renderer.skips.set("lax-9", "statement Lax5.claim has no home concept in the archive");
    renderer.skips.set("lax-1", "GRAPH_LABEL_GLYPH_UNSUPPORTED");
    const output = capture();

    try {
      await serveWebsite(b, port, {
        renderer,
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    // The renderer finished, but not with the folder in it: said like a
    // failed rebuild, with the hint, on the first render.
    const lines = output.lines.join("\n");
    expect(lines).toMatch(/^ {2}✗ \d{2}:\d{2}:\d{2} {2}the preview could not render lax-9$/mu);
    expect(lines).toContain("    lax-9: statement Lax5.claim has no home concept in the archive");
    expect(lines).toContain(`run \`lax build\` in ${ui.tilde(a)}, ${ui.tilde(c)}.`);
    expect(output.lines).toContain("  lax-9 (not rendered) and 1 published submission.");
    expect(lines).toContain("  ! The renderer skipped lax-1, a record in your copy of the archive.");
    expect(lines).toContain("    GRAPH_LABEL_GLYPH_UNSUPPORTED");
    const html = await (await fetch(`http://localhost:${port}/`)).text();
    const front = text(html);
    expect(front).toContain("The preview could not be rebuilt");
    expect(front).toContain("lax-9: statement Lax5.claim has no home concept in the archive");
    expect(front).toContain("lax-9 — B\nlocal build, v4.19.0 — not rendered, see above");
    expect(html).not.toContain('href="/lax-9/"');
    expect(html).toContain('<meta http-equiv="refresh" content="10">');

    // The archive skip is said once per preview, not once per rebuild.
    const again = capture();
    try {
      fs.writeFileSync(path.join(b, "build-output.json"), JSON.stringify(localBuildOutput("lax-9", "B2")));
      await waitFor(() => again.lines.some((line) => line.includes("could not render lax-9")), "the second render");
    } finally {
      again.restore();
    }
    expect(again.lines.join("\n")).not.toContain("The renderer skipped lax-1");
  });

  it("folds the renderer's console noise into the rebuilt line unless verbose", async () => {
    currentDatabase([]);
    const local = temporaryDirectory("lax-serve-local-");
    fs.writeFileSync(path.join(local, "build-output.json"), JSON.stringify(localBuildOutput("lax-50", "B")));
    const port = await freePort();
    const noisy = stubRenderer();
    const inner = noisy.generateSite;
    noisy.generateSite = async (...args) => {
      console.warn("No character metrics for '𝓕' in style 'Main-Regular' and mode 'text'");
      console.warn("No character metrics for '½' in style 'Main-Regular' and mode 'text'");
      await inner(...args);
    };
    const output = capture();

    try {
      await serveWebsite(local, port, {
        renderer: noisy,
        onListening: (live) => { preview = live; },
      });
      const renders = noisy.renders;
      fs.writeFileSync(path.join(local, "build-output.json"), JSON.stringify(localBuildOutput("lax-50", "B2")));
      await waitFor(
        () => output.lines.some((line) => /rebuilt {2}\(renderer: 2 warnings; -v shows them\)$/u.test(line)),
        "the rebuilt line with the warning count",
      );
      expect(noisy.renders).toBeGreaterThan(renders);
    } finally {
      output.restore();
    }
    expect(output.lines.join("\n")).not.toContain("No character metrics");
  });

  it("says on the front page why the render failed, and what to build", async () => {
    currentDatabase([]);
    const { b, a, c } = siblingLayout();
    const port = await freePort();
    const output = capture();

    try {
      await serveWebsite(b, port, {
        renderer: {
          generateSite: () => Promise.reject(new Error("statement Lax5.claim has no home concept")),
          mimeTypes: {},
        },
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    const html = await (await fetch(`http://localhost:${port}/`)).text();
    const front = text(html);
    expect(front).toContain("The preview could not be rebuilt; no render has succeeded yet.");
    expect(front).toContain("statement Lax5.claim has no home concept");
    expect(front).toContain(`run lax build in ${ui.tilde(c)}`);
    expect(front).toContain("Browse your local copy of the archive — no render has succeeded yet.");
    expect(front).not.toContain("Building the website");
    // Slow reload while failing, so building C shows up unasked.
    expect(html).toContain('<meta http-equiv="refresh" content="10">');
    // The terminal gets the same hint.
    expect(output.lines).toContain(
      `    A sibling without build output is not rendered, so its statements are unknown to the pages: run \`lax build\` in ${ui.tilde(a)}, ${ui.tilde(c)}.`,
    );
    // The folder's own page is the placeholder, and it points at the answer.
    const page = await fetch(`http://localhost:${port}/local/`);
    expect(await page.text()).toContain('<a href="/">');
  });

  it("names the archive record a renderer error blames, as not the folder's", async () => {
    currentDatabase(["lax-771646"]);
    const port = await freePort();
    const output = capture();

    try {
      await serveWebsite(temporaryDirectory("lax-serve-local-"), port, {
        renderer: {
          generateSite: () => Promise.reject(new Error("lax-771646: GRAPH_LABEL_GLYPH_UNSUPPORTED")),
          mimeTypes: {},
        },
        onListening: (live) => { preview = live; },
      });
    } finally {
      output.restore();
    }

    const front = text(await (await fetch(`http://localhost:${port}/`)).text());
    expect(front).toContain(
      "lax-771646 is a record in your copy of the archive, not a local folder: this failure is the renderer's own, and --database-only would fail the same way.",
    );
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
    const page = await fetch(`http://localhost:${preview!.port}/index.html`);
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
 * Three folders side by side: B requires A (concepts) and C (proofs) by
 * path, and A requires C in turn — the layout a nonstrict build admits.
 */
function siblingLayout(): { b: string; a: string; c: string } {
  const base = temporaryDirectory("lax-serve-siblings-");
  const folders = { b: path.join(base, "B"), a: path.join(base, "A"), c: path.join(base, "C") };
  const lakefile = (name: string, requires: string): string =>
    `name = "${name}"\ndefaultTargets = ["${name}"]\n\n[[require]]\nname = "mathlib"\n` +
    `git = "https://github.com/leanprover-community/mathlib4"\nrev = "${"a".repeat(40)}"\n${requires}`;
  const pathRequire = (name: string, to: string): string =>
    `\n[[require]]\nname = "${name}"\npath = "${to}"\n`;
  for (const folder of Object.values(folders)) {
    fs.mkdirSync(path.join(folder, "concepts"), { recursive: true });
    fs.mkdirSync(path.join(folder, "proofs"), { recursive: true });
  }
  fs.writeFileSync(
    path.join(folders.b, "concepts", "lakefile.toml"),
    lakefile("Lax9", pathRequire("Lax7", "../../A/concepts")),
  );
  fs.writeFileSync(
    path.join(folders.b, "proofs", "lakefile.toml"),
    lakefile("Lax9Proofs", pathRequire("Lax9", "../concepts") + pathRequire("Lax5", "../../C/concepts")),
  );
  fs.writeFileSync(
    path.join(folders.a, "concepts", "lakefile.toml"),
    lakefile("Lax7", pathRequire("Lax5", "../../C/concepts")),
  );
  fs.writeFileSync(path.join(folders.c, "concepts", "lakefile.toml"), lakefile("Lax5", ""));
  return folders;
}

/** The preview output directories currently in the system temp folder. */
function siteDirectories(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("lax-site-"));
}

/** A page's text, one line per block, the way a reader sees it. */
function text(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/gu, "")
    .replace(/<br>|<\/(?:title|li|p|h1|h2)>/gu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
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
  /** Records the stub drops at its per-record boundary, as the real
   * renderer does with a statement it cannot place. */
  skips: Map<string, string>;
}

/** A renderer standing in for the pinned lax-website bundle, which only a
 * release carries: it writes one page, counts how often it was asked to,
 * and records the per-submission renderer inputs the serve wiring feeds. */
function stubRenderer(): StubRenderer {
  const builder: StubRenderer = {
    renders: 0,
    seen: [],
    epochs: [],
    skips: new Map(),
    generateSite: async (submissions, outDir, options) => {
      builder.renders += 1;
      const settings = typeof options === "string" ? { epoch: options } : options ?? {};
      builder.epochs.push(settings.epoch);
      for (const [id, reason] of builder.skips) {
        if (submissions.some((submission) => submission.record.id === id)) settings.onSkip?.({ id, reason });
      }
      submissions = submissions.filter((submission) => !builder.skips.has(submission.record.id));
      builder.seen.push(
        (submissions as Array<{ record: { id: string }; paperFile?: string; bundleFile?: string }>).map(
          (submission) => ({
            id: submission.record.id,
            ...(submission.paperFile === undefined ? {} : { paperFile: submission.paperFile }),
            ...(submission.bundleFile === undefined ? {} : { bundleFile: submission.bundleFile }),
          }),
        ),
      );
      // Shaped like the real generator: the whole tree is replaced, and every
      // submission gets its own `<id>/index.html` beside the front page.
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, "index.html"),
        "<!doctype html><html><head></head><body>rendered by the stub</body></html>",
      );
      for (const submission of submissions as Array<{ record: { id: string } }>) {
        const directory = path.join(outDir, submission.record.id);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "index.html"),
          `<!doctype html><html><head></head><body>the stub's ${submission.record.id} page</body></html>`,
        );
      }
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
