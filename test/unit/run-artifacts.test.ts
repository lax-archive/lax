// The CLI's side of the report channel: the zip an author downloads from the
// validate job is untrusted input that reaches a terminal, so the bounds, the
// shape check, and the sanitizing are the point of these tests. The redirect
// hop is exercised against a real socket, because "fetch drops the header
// cross-origin" is exactly the kind of assumption that should be a test.

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { GitHubClient, GitHubError } from "../../src/shared/github.js";
import {
  fetchValidationReport,
  parseValidationReportZip,
  ValidationReportUnavailableError,
} from "../../src/cli/run-artifacts.js";

const encoder = new TextEncoder();

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, body]) => [name, encoder.encode(body)])),
  );
}

function reportZip(report: unknown): Uint8Array {
  return zipOf({ "validation-report.json": JSON.stringify(report) });
}

const failedReport = {
  reportVersion: 1,
  ok: false,
  warnings: [],
  violations: [
    {
      phase: "compile-proofs",
      rule: "build",
      message: "Proofs/Main.lean:9:2: error: unsolved goals\n⊢ False",
    },
  ],
};

describe("validation report artifacts", () => {
  it("reads the report entry and keeps a transcript's lines", () => {
    const report = parseValidationReportZip(reportZip(failedReport));
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      {
        phase: "compile-proofs",
        rule: "build",
        message: "Proofs/Main.lean:9:2: error: unsolved goals\n⊢ False",
      },
    ]);
  });

  it("strips escape sequences and invisible characters from every string", () => {
    const report = parseValidationReportZip(
      reportZip({
        reportVersion: 1,
        ok: false,
        warnings: [],
        violations: [
          {
            phase: "\u001b[31mstatic",
            rule: "manifest\u200b",
            message: "title\u0007 is\u202e missing",
          },
        ],
      }),
    );
    expect(report.violations[0]).toEqual({
      phase: "[31mstatic",
      rule: "manifest",
      message: "title  is missing",
    });
  });

  it("substitutes placeholders for missing or non-string finding fields", () => {
    const report = parseValidationReportZip(
      reportZip({ reportVersion: 1, ok: false, warnings: [], violations: [{ rule: 7 }, "nope"] }),
    );
    expect(report.violations).toEqual([
      { phase: "validation", rule: "unspecified", message: "unspecified failure" },
      { phase: "validation", rule: "unspecified", message: "unspecified failure" },
    ]);
  });

  it("reads and sanitizes a typed infrastructure failure separately from findings", () => {
    const report = parseValidationReportZip(reportZip({
      reportVersion: 1,
      ok: false,
      warnings: [],
      violations: [],
      failure: {
        kind: "infrastructure",
        retryable: true,
        phase: "provision\u200b",
        rule: "runtime",
        message: "could not connect\u001b[31m\nto Docker",
      },
    }));
    expect(report.failure).toEqual({
      kind: "infrastructure",
      retryable: true,
      phase: "provision",
      rule: "runtime",
      message: "could not connect [31m\nto Docker",
    });
    expect(report.violations).toEqual([]);
  });

  it("refuses a report that mixes an operational failure with submission violations", () => {
    expect(() => parseValidationReportZip(reportZip({
      ...failedReport,
      failure: {
        kind: "resource-limit",
        retryable: false,
        phase: "compile-proofs",
        rule: "compile",
        message: "memory limit",
      },
    }))).toThrow("mixes an operational failure");
  });

  it("refuses an artifact without the report entry", () => {
    expect(() => parseValidationReportZip(zipOf({ "capture.tar": "not the report" }))).toThrow(
      ValidationReportUnavailableError,
    );
  });

  it("refuses bytes that are not a zip", () => {
    expect(() => parseValidationReportZip(encoder.encode("PK not really"))).toThrow(
      ValidationReportUnavailableError,
    );
  });

  it("refuses a report of the wrong version, verdict, or shape", () => {
    for (const value of [
      "not an object",
      { reportVersion: 2, ok: false, warnings: [], violations: [] },
      { reportVersion: 1, ok: "no", warnings: [], violations: [] },
      { reportVersion: 1, ok: false, warnings: [], violations: {} },
    ]) {
      expect(() => parseValidationReportZip(reportZip(value)), JSON.stringify(value)).toThrow(
        ValidationReportUnavailableError,
      );
    }
  });
});

describe("fetching the report of a run", () => {
  const options = { attempts: 3, intervalMs: 0 };

  function client(
    request: (method: string, path: string) => unknown,
    binary?: (path: string, opts: { maxBytes: number }) => Uint8Array,
  ): GitHubClient {
    return {
      request: vi.fn(async (method: string, path: string) => request(method, path)),
      requestBinary: vi.fn(async (path: string, opts: { maxBytes: number }) => {
        if (binary === undefined) throw new Error("unexpected download");
        return binary(path, opts);
      }),
    } as unknown as GitHubClient;
  }

  it("downloads the report artifact of this submission and nothing else", async () => {
    const paths: string[] = [];
    const github = client(
      () => ({
        artifacts: [
          { id: 1, name: "submission-validation-42", expired: false },
          { id: 2, name: "submission-validation-report-42", expired: false },
        ],
      }),
      (path, opts) => {
        paths.push(path);
        // The whole artifact is bounded by what a report can be.
        expect(opts.maxBytes).toBe(64 * 1024 * 1024);
        return reportZip(failedReport);
      },
    );

    const report = await fetchValidationReport(github, 42, "777", options);

    expect(report?.ok).toBe(false);
    expect(paths).toEqual(["/repos/lax-archive/lax/actions/artifacts/2/zip"]);
  });

  it("waits out the upload lag and gives up without an error when nothing appears", async () => {
    let listed = 0;
    const github = client(() => {
      listed += 1;
      return { artifacts: [] };
    });

    // A validate job that died before writing a report is the workflow's story
    // to tell, not an error the CLI invents.
    expect(await fetchValidationReport(github, 42, "777", options)).toBeUndefined();
    expect(listed).toBe(3);
  });

  it("retries a transient list failure", async () => {
    let listed = 0;
    const github = client(
      () => {
        listed += 1;
        if (listed < 2) throw new Error("GitHub request failed: socket hang up");
        return { artifacts: [{ id: 2, name: "submission-validation-report-42" }] };
      },
      () => reportZip({ ...failedReport, ok: true, violations: [] }),
    );

    expect((await fetchValidationReport(github, 42, "777", options))?.ok).toBe(true);
    expect(listed).toBe(2);
  });

  it("names the missing permission when the token cannot read Actions", async () => {
    let listed = 0;
    const github = client(() => {
      listed += 1;
      throw new GitHubError("GitHub API 403: Resource not accessible", 403);
    });

    await expect(fetchValidationReport(github, 42, "777", options)).rejects.toThrow(
      /Actions read permission.*lax login/su,
    );
    // A refusal is authoritative: retrying the same token cannot change it.
    expect(listed).toBe(1);
  });
});

describe("the artifact download hop", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running !== undefined) {
      await new Promise<void>((resolve) => running.close(() => resolve()));
    }
  });

  async function start(
    handler: (path: string, authorization: string | undefined, respond: (
      status: number,
      headers: Record<string, string>,
      body?: Buffer,
    ) => void) => void,
  ): Promise<string> {
    server = createServer((request, response) => {
      handler(request.url ?? "/", request.headers.authorization, (status, headers, body) => {
        response.writeHead(status, headers);
        response.end(body);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("fake did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  it("follows the redirect to the blob without carrying the credential", async () => {
    const seen: Array<{ path: string; authorization?: string }> = [];
    const base = await start((path, authorization, respond) => {
      seen.push({ path, ...(authorization === undefined ? {} : { authorization }) });
      if (path === "/download") {
        respond(302, { location: "/blob" });
        return;
      }
      respond(200, { "content-type": "application/zip" }, Buffer.from("zip bytes"));
    });

    const bytes = await new GitHubClient("ghu_tok-alice", base).requestBinary("/download", {
      maxBytes: 1_000,
    });

    expect(Buffer.from(bytes).toString("utf8")).toBe("zip bytes");
    expect(seen).toEqual([
      { path: "/download", authorization: "Bearer ghu_tok-alice" },
      { path: "/blob" },
    ]);
  });

  it("refuses a body larger than the cap, declared or not", async () => {
    const base = await start((path, _authorization, respond) => {
      respond(
        200,
        path === "/declared" ? { "content-length": "5000" } : {},
        Buffer.alloc(5_000, 0x61),
      );
    });
    const github = new GitHubClient("ghu_tok-alice", base);

    await expect(github.requestBinary("/declared", { maxBytes: 100 })).rejects.toThrow(
      "download exceeds 100 bytes",
    );
    await expect(github.requestBinary("/streamed", { maxBytes: 100 })).rejects.toThrow(
      "download exceeds 100 bytes",
    );
  });

  it("reports an HTTP refusal with its status", async () => {
    const base = await start((_path, _authorization, respond) => {
      respond(403, { "content-type": "application/json" }, Buffer.from("{}"));
    });

    await expect(
      new GitHubClient("ghu_tok-alice", base).requestBinary("/download", { maxBytes: 1_000 }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
