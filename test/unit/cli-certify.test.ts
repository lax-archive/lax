// `lax certify` over a hand-written local archive copy in a spec-2 fake
// environment: a record's bundle regenerated from its telescopes and held to
// the stored Challenge; the stored bundle fetched by digest from the fake
// registry and refused when the bytes differ; one edge; a statement proven
// relative to others, composed along the witness forest; the refusals; and
// --run against a fake toolchain whose `lake comparator` answers as the real
// one does, so the verdict rendering is seen without Lean — with the
// records' packages taken from their captures in the fake registry, in a
// fresh run project, and never from the certificate folder's `.lake`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { certify } from "../../src/cli/certify.js";
import * as ui from "../../src/cli/ui.js";
import { CAPTURES_REPOSITORY } from "../../src/shared/constants.js";
import { readBundle, sealBundle, sealTar } from "../../src/submission-validation/certify/bundle.js";
import { BUNDLE_FILES, challengeText, certifiedProof, type RelativeBundle } from "../../src/submission-validation/certify/generate.js";
import type { InspectorReport, ProofEntry } from "../../src/submission-validation/contracts.js";
import { environment as environmentById, epoch } from "../../src/submission-validation/environments.js";
import { inspectorSourceHash } from "../../src/submission-validation/host/inspector.js";
import { warmDir } from "../../src/submission-validation/host/warmstore.js";
import { startFakeGhcr, type FakeGhcr } from "../fake-ghcr.js";
import { spec2TestEnvironment, withTestEnvironments, withTestEnvironmentsAsync } from "../support/environments.js";
import { removeTree } from "../support/tmp.js";
import { SELF_TEST_PROBES } from "../../src/submission-validation/contracts.js";
import { fakeToolDigests } from "../support/validation-artifacts.js";

const SPEC2 = spec2TestEnvironment();
const TOOLCHAIN = SPEC2.leanToolchain!;
const previous = { home: process.env.LAX_HOME, elan: process.env.ELAN_HOME, path: process.env.PATH, registry: process.env.LAX_CAPTURE_REGISTRY_URL };
let home: string;
let work: string;
let ghcr: FakeGhcr | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-certify-"));
  work = path.join(home, "work");
  fs.mkdirSync(work);
  process.env.LAX_HOME = home;
  process.env.ELAN_HOME = path.join(home, "elan");
  // a `.git` that is not a clone: the refresh fails and the command carries on
  fs.mkdirSync(path.join(home, "lax-database", ".git"), { recursive: true });
  ui.configure({ color: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ghcr?.close();
  ghcr = undefined;
  removeTree(home);
  for (const [name, value] of [
    ["LAX_HOME", previous.home],
    ["ELAN_HOME", previous.elan],
    ["PATH", previous.path],
    ["LAX_CAPTURE_REGISTRY_URL", previous.registry],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Fresh spies each time: a second report in one test starts from nothing. */
function quiet(): Array<{ mock: { calls: unknown[][] } }> {
  vi.restoreAllMocks();
  return [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  ];
}

function printed(log: Array<{ mock: { calls: unknown[][] } }>): string {
  return log.flatMap((spy) => spy.mock.calls.map(([line]) => String(line))).join("\n");
}

// ── the archive copy ─────────────────────────────────────────────────────

const EUCLID: ProofEntry = {
  id: "Lax42Proofs.euclid",
  path: "proofs/Lax42Proofs/Primes.lean",
  levelParams: ["u"],
  telescope: {
    hypotheses: [{ statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [] }],
    conclusion: { statement: "Lax42.Primes.InfinitelyManyPrimes", levels: ["u"] },
  },
  conclusion: "Lax42.Primes.InfinitelyManyPrimes",
  assumptions: ["Lax42.Primes.ExistsPrimeDivisor"],
  description: "Euclid's argument.",
};

const DIVISOR: ProofEntry = {
  id: "Lax261Proofs.existsPrimeDivisor",
  path: "proofs/Lax261Proofs/Divisor.lean",
  levelParams: [],
  telescope: { hypotheses: [], conclusion: { statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [] } },
  conclusion: "Lax42.Primes.ExistsPrimeDivisor",
  assumptions: [],
  description: "From mathlib.",
};

interface RecordInput {
  id: string;
  environment?: string;
  repository: string;
  statements?: Array<{ id: string; levelParams: string[] }>;
  proofs?: ProofEntry[];
  requiredByConcepts?: string[];
  requiredByProofs?: string[];
  /** The stored certificate; absent for a record without proofs. Set
   * `challenge` to store something other than the regeneration. */
  certificate?: { digest?: string; registryBlob?: string; challenge?: string };
  specVersion?: "1" | "2";
}

/** Each record's capture tar by digest: its two packages' sources, as the
 * trusted pipeline seals them (`<kind>/package/…`), for --run to build. */
const captures = new Map<string, Buffer>();

function captureOf(number: string): Record<string, unknown> {
  const members = [
    { name: `concepts/package/Lax${number}.lean`, content: Buffer.from(`-- Lax${number}\n`) },
    { name: "concepts/package/lakefile.toml", content: Buffer.from(`name = "Lax${number}"\n`) },
    { name: `proofs/package/Lax${number}Proofs.lean`, content: Buffer.from(`-- Lax${number}Proofs\n`) },
    { name: "proofs/package/lakefile.toml", content: Buffer.from(`name = "Lax${number}Proofs"\n`) },
  ];
  const sealed = sealTar(members);
  captures.set(sealed.digest, sealed.tar);
  return {
    formatVersion: 1,
    digest: sealed.digest,
    registryBlob: `ghcr.io/${CAPTURES_REPOSITORY}@sha256:${sealed.digest}`,
    sourceCommit: number.padStart(40, "0"),
    bytes: sealed.tar.length,
    fileCount: members.length,
    // the references layer, never fetched here
    references: { digest: "e".repeat(64), bytes: 1, registryBlob: `ghcr.io/${CAPTURES_REPOSITORY}@sha256:${"e".repeat(64)}` },
  };
}

/** The fake registry, serving every capture written so far. */
async function serveCaptures(): Promise<FakeGhcr> {
  ghcr = await startFakeGhcr();
  process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;
  for (const [digest, tar] of captures) ghcr.state.blobs.set(`sha256:${digest}`, tar);
  return ghcr;
}

function writeRecord(input: RecordInput): void {
  const directory = path.join(home, "lax-database", input.id);
  fs.mkdirSync(directory, { recursive: true });
  const number = input.id.slice("lax-".length);
  fs.writeFileSync(
    path.join(directory, "record.json"),
    JSON.stringify({
      specVersion: "1",
      id: input.id,
      state: "registered",
      createdAt: "2026-01-01T00:00:00Z",
      source: { repository: input.repository, commit: number.padStart(40, "0"), folder: "." },
    }),
  );
  const proofs = input.proofs ?? [];
  const stored = proofs.map(({ conclusion: _c, assumptions: _a, ...proof }) => proof);
  const certificate =
    input.certificate === undefined
      ? undefined
      : {
          // the stored shape: the judge's toolchain is the row's, filled on read
          judge: { selfTest: { passed: true, probes: [...SELF_TEST_PROBES] }, tools: fakeToolDigests() },
          kernels: ["lean"],
          bundle: {
            formatVersion: 1,
            digest: input.certificate.digest ?? "c".repeat(64),
            ...(input.certificate.registryBlob === undefined ? {} : { registryBlob: input.certificate.registryBlob }),
          },
          challengeExportSha256: "e".repeat(64),
          challenge: input.certificate.challenge ?? challengeText(proofs.map(certifiedProof)),
        };
  fs.writeFileSync(
    path.join(directory, "build-output.json"),
    JSON.stringify({
      id: input.id,
      specVersion: "1",
      inputs: {
        manifest: { specVersion: input.specVersion ?? "2", leanVersion: input.environment ?? SPEC2.id, title: input.id, authors: [] },
        abstract: "",
      },
      requiredByConcepts: input.requiredByConcepts ?? [],
      requiredByProofs: input.requiredByProofs ?? [],
      concepts: [
        {
          id: `Lax${number}.Primes`,
          path: `concepts/Lax${number}/Primes.lean`,
          title: "Primes",
          type: "theorem",
          description: "",
          imports: [],
          mathlibImports: [],
          sourceText: "",
          statements: (input.statements ?? []).map((statement) => ({ ...statement, signature: `${statement.id} : Prop`, body: "True" })),
        },
      ],
      proofs: stored,
      capture: captureOf(number),
      ...(certificate === undefined ? {} : { certificate }),
    }),
  );
}

/** lax-42 states two statements and proves the polymorphic one from the
 * other; lax-261 requires Lax42 and proves the other outright. */
function writeChain(): void {
  writeRecord({
    id: "lax-42",
    repository: "https://github.com/alice/primes",
    statements: [
      { id: "Lax42.Primes.ExistsPrimeDivisor", levelParams: [] },
      { id: "Lax42.Primes.InfinitelyManyPrimes", levelParams: ["u"] },
    ],
    proofs: [EUCLID],
    certificate: {},
  });
  writeRecord({
    id: "lax-261",
    repository: "https://github.com/alice/divisor",
    statements: [{ id: "Lax261.Primes.Unused", levelParams: [] }],
    proofs: [DIVISOR],
    requiredByProofs: ["Lax42"],
    certificate: {},
  });
}

/** The warm store of the spec-2 row as the regenerated manifest reads it. */
function seedWarmStore(): void {
  const environment = withTestEnvironments([SPEC2], () => environmentById(SPEC2.id)!);
  const warm = warmDir(environment);
  for (const name of ["LaxCore", "mathlib"]) fs.mkdirSync(path.join(warm, ".lake", "packages", name), { recursive: true });
  const entry = (name: string, url: string, rev: string): Record<string, unknown> => ({
    url, type: "git", subDir: null, scope: "", rev, name, manifestFile: "lake-manifest.json", inputRev: rev, inherited: false, configFile: "lakefile.toml",
  });
  fs.writeFileSync(
    path.join(warm, "lake-manifest.json"),
    JSON.stringify({
      version: "1.2.0",
      packagesDir: ".lake/packages",
      packages: [entry("LaxCore", "https://github.com/lax-archive/lax-core", process.env.LAX_LAXCORE_REV!), entry("mathlib", "https://github.com/leanprover-community/mathlib4", environment.mathlibCommit)],
    }),
  );
  fs.writeFileSync(path.join(warm, ".lax-warm-ok"), "");
}

/** The bundle files a folder holds: a record's five, or a relative
 * certificate's six (typed as the larger shape for the tests' reads). */
function bundleIn(directory: string): RelativeBundle {
  return Object.fromEntries(
    BUNDLE_FILES.filter((name) => fs.existsSync(path.join(directory, name))).map((name) => [name, fs.readFileSync(path.join(directory, name), "utf8")]),
  ) as RelativeBundle;
}

/** A toolchain directory with a `lake` that answers `comparator` (and the
 * Challenge's `build`) as scripted, a `leanexport` that prints a stand-in
 * export, and `git`/`bwrap` stand-ins on PATH — the `bwrap` one logs its
 * command line and runs what follows `--` — so --run reaches the verdict
 * parser. With `inspector`, the environment's inspector is already built and
 * writes that report: the Challenge is held; without, building it fails and
 * the Challenge's meaning goes unchecked. */
function fakeToolchain(
  comparator: string,
  tools: { git?: boolean; bwrap?: boolean; build?: string; inspector?: InspectorReport } = {},
): void {
  const mangled = TOOLCHAIN.replace("/", "--").replace(":", "---");
  const bin = path.join(home, "elan", "toolchains", mangled, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "lean"), "");
  fs.writeFileSync(
    path.join(bin, "lake"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(home, "lake-args"))}\ncase "$1" in comparator) ${comparator} ;; build) ${tools.build ?? "true"} ;; esac\necho "Lake version 5.0.0"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "leanexport"), "#!/bin/sh\necho 'the Challenge export'\n", { mode: 0o755 });
  const fake = path.join(home, "bin");
  fs.mkdirSync(fake);
  if (tools.git !== false) fs.writeFileSync(path.join(fake, "git"), "#!/bin/sh\necho 'git version 2.43.0'\n", { mode: 0o755 });
  if (tools.bwrap !== false) {
    fs.writeFileSync(
      path.join(fake, "bwrap"),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 'bubblewrap 0.9.0'; exit 0; fi\n` +
        `echo "$@" >> ${JSON.stringify(path.join(home, "bwrap-args"))}\n` +
        `while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
  }
  if (tools.inspector !== undefined) {
    const version = (JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { version: string }).version;
    const key = withTestEnvironments([SPEC2], () => `${version}-${inspectorSourceHash(environmentById(SPEC2.id)!)}`);
    const tool = path.join(home, "tools", key, "src", ".lake", "build", "bin");
    fs.mkdirSync(tool, { recursive: true });
    // the inspector's argument shape: --spec 2 <report> Challenge
    fs.writeFileSync(path.join(tool, "laxinspector"), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(tools.inspector)}' > "$3"\n`, { mode: 0o755 });
  }
  // the capture cache extracts with the system's tar
  const tar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8", env: { PATH: previous.path ?? "" } }).stdout.trim();
  if (tar !== "") fs.symlinkSync(tar, path.join(fake, "tar"));
  // the fake dir alone: a real git or bwrap on the machine must not stand in
  process.env.PATH = fake;
}

/** The inspector's reading of lax-42's Challenge: Euclid's edge as stated,
 * or — a global macro's work — something else under the same name. */
function challengeReport(rewritten = false): InspectorReport {
  return {
    modules: [{ name: "Challenge", imports: ["Lax42"], moduleDocs: [], declCount: 1, globalSyntax: [] }],
    declarations: [
      {
        name: EUCLID.id,
        kind: "theorem",
        module: "Challenge",
        axioms: ["sorryAx"],
        usedConstants: [],
        userName: EUCLID.id,
        origin: { kind: "authored" },
        laxStatement: false,
        isProp: false,
        levelParams: ["u"],
        telescope: rewritten
          ? { hypotheses: [], conclusion: { const: "True", levels: [] } }
          : {
              hypotheses: [{ const: "Lax42.Primes.ExistsPrimeDivisor", levels: [] }],
              conclusion: { const: "Lax42.Primes.InfinitelyManyPrimes", levels: [["param", "u"]] },
            },
      },
    ],
  };
}

describe("lax certify", () => {
  it("regenerates a record's bundle from its telescopes and holds the Challenge to the stored one", async () => {
    writeChain();
    seedWarmStore();
    const log = quiet();
    const out = path.join(work, "certificate-lax-42");

    const code = await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out }));

    expect(code).toBe(0);
    const files = bundleIn(out);
    expect(files["Challenge.lean"]).toBe(challengeText([certifiedProof(EUCLID)]));
    // no Solution: the proof package is the solution module, its proof the theorem
    expect(Object.keys(files)).toEqual(["Challenge.lean", "comparator.json", "lake-manifest.json", "lakefile.toml", "lean-toolchain"]);
    expect(files["Challenge.lean"]).toContain("theorem Lax42Proofs.euclid.{«u»}\n");
    expect(JSON.parse(files["comparator.json"])).toMatchObject({ solution_module: "Lax42Proofs", theorem_names: ["Lax42Proofs.euclid"] });
    expect(files["lakefile.toml"]).toContain('defaultTargets = ["Challenge"]');
    expect(files["lakefile.toml"]).not.toContain('name = "Solution"');
    expect(files["lakefile.toml"]).toContain('name = "LaxCore"');
    expect(files["lakefile.toml"]).toContain(`name = "Lax42"\ngit = "https://github.com/alice/primes"\nrev = "${"42".padStart(40, "0")}"\nsubDir = "concepts"`);
    expect(files["lakefile.toml"]).toContain('name = "Lax42Proofs"\ngit = "https://github.com/alice/primes"');
    expect(files["lakefile.toml"]).not.toContain("Lax261");
    const manifest = JSON.parse(files["lake-manifest.json"]) as { packages: Array<{ name: string }> };
    expect(manifest.packages.map((pkg) => pkg.name)).toEqual(["Lax42", "Lax42Proofs", "LaxCore", "mathlib"]);
    // the toolchain is a sealed bundle file, so elan picks it in the folder
    expect(files["lean-toolchain"]).toBe(`${TOOLCHAIN}\n`);
    const output = printed(log);
    expect(output).toContain("Certificate for lax-42");
    expect(output).toContain("Regenerated the bundle");
    expect(output).toContain("lake comparator --config comparator.json");
    expect(output).toContain("the bare comparator clones the records' packages from their authors' repositories and does not check what");
    expect(output).toContain("(the bundle's lean-toolchain names leanprover/lean4:");
    // the stored digest is a placeholder, so the note says the bundle is not the archive's
    expect(output).toContain("The regenerated bundle's digest is not the archive's (cccccccccccc).");
    expect(output).toContain("lax certify lax-42 --fetch");

    // with the real digest stored, the detail says so and no note is printed
    const sealed = sealBundle(files);
    writeRecord({
      id: "lax-42",
      repository: "https://github.com/alice/primes",
      statements: [{ id: "Lax42.Primes.ExistsPrimeDivisor", levelParams: [] }, { id: "Lax42.Primes.InfinitelyManyPrimes", levelParams: ["u"] }],
      proofs: [EUCLID],
      certificate: { digest: sealed.digest },
    });
    const again = quiet();
    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out }))).toBe(0);
    expect(printed(again)).toContain(`1 edge · bundle ${sealed.digest.slice(0, 12)}, the archive's`);
    expect(printed(again)).not.toContain("is not the archive's");
  });

  it("refuses a record whose stored Challenge is not the regeneration", async () => {
    writeChain();
    seedWarmStore();
    writeRecord({
      id: "lax-42",
      repository: "https://github.com/alice/primes",
      statements: [{ id: "Lax42.Primes.ExistsPrimeDivisor", levelParams: [] }, { id: "Lax42.Primes.InfinitelyManyPrimes", levelParams: ["u"] }],
      proofs: [EUCLID],
      certificate: { challenge: "theorem Lax42Proofs.euclid : True := sorry\n" },
    });
    quiet();
    await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: path.join(work, "c") }))).rejects.toThrow(
      /differs from the one its record stores — the archive's record is inconsistent; report it/u,
    );
    expect(fs.existsSync(path.join(work, "c"))).toBe(false);
  });

  it("fetches the stored bundle by digest and refuses bytes that do not hash to it", async () => {
    writeChain();
    seedWarmStore();
    quiet();
    const regenerated = path.join(work, "regenerated");
    await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: regenerated }));
    const sealed = sealBundle(bundleIn(regenerated));
    ghcr = await startFakeGhcr();
    process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;
    ghcr.state.blobs.set(`sha256:${sealed.digest}`, sealed.tar);
    const stored = (digest: string): void =>
      writeRecord({
        id: "lax-42",
        repository: "https://github.com/alice/primes",
        statements: [{ id: "Lax42.Primes.ExistsPrimeDivisor", levelParams: [] }, { id: "Lax42.Primes.InfinitelyManyPrimes", levelParams: ["u"] }],
        proofs: [EUCLID],
        certificate: { digest, registryBlob: `ghcr.io/${CAPTURES_REPOSITORY}@sha256:${digest}` },
      });
    stored(sealed.digest);
    const log = quiet();
    const fetched = path.join(work, "fetched");

    const code = await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: fetched, fetch: true }));

    expect(code).toBe(0);
    expect(bundleIn(fetched)).toEqual(bundleIn(regenerated));
    expect(printed(log)).toContain(`Fetched the bundle`);
    expect(printed(log)).toContain(`digest ${sealed.digest.slice(0, 12)} verified`);
    expect(fs.existsSync(path.join(home, "certificates", `${sealed.digest}.tar`))).toBe(true);

    // tampered: the registry answers other bytes under the recorded digest
    const tampered = sealBundle({ ...bundleIn(regenerated), "comparator.json": "{}\n" });
    ghcr.state.blobs.set(`sha256:${tampered.digest}`, sealed.tar);
    stored(tampered.digest);
    quiet();
    await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: path.join(work, "tampered"), fetch: true }))).rejects.toThrow(
      /or its bytes did not hash to the recorded digest/u,
    );
    // and a fetched bundle is still held to the stored Challenge
    ghcr.state.blobs.set(`sha256:${tampered.digest}`, tampered.tar);
    writeRecord({
      id: "lax-42",
      repository: "https://github.com/alice/primes",
      statements: [{ id: "Lax42.Primes.ExistsPrimeDivisor", levelParams: [] }, { id: "Lax42.Primes.InfinitelyManyPrimes", levelParams: ["u"] }],
      proofs: [EUCLID],
      certificate: { digest: tampered.digest, registryBlob: `ghcr.io/${CAPTURES_REPOSITORY}@sha256:${tampered.digest}`, challenge: "theorem Lax42Proofs.euclid : True := sorry\n" },
    });
    await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: path.join(work, "tampered2"), fetch: true }))).rejects.toThrow(
      /fetched bundle's Challenge\.lean is not the one lax-42's record stores/u,
    );
  });

  it("certifies one edge for a proof id", async () => {
    writeChain();
    seedWarmStore();
    const log = quiet();
    const out = path.join(work, "edge");

    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("Lax261Proofs.existsPrimeDivisor", { out }))).toBe(0);

    const files = bundleIn(out);
    expect(files["Challenge.lean"]).toContain("import Lax42\n");
    expect(files["Challenge.lean"]).toContain("theorem Lax261Proofs.existsPrimeDivisor : _root_.Lax42.Primes.ExistsPrimeDivisor := sorry");
    expect(files["Solution.lean"]).toBeUndefined();
    expect(JSON.parse(files["comparator.json"])).toMatchObject({ solution_module: "Lax261Proofs", theorem_names: ["Lax261Proofs.existsPrimeDivisor"] });
    expect(files["lakefile.toml"]).toContain('name = "Lax261"\n');
    expect(files["lakefile.toml"]).toContain('name = "Lax42"\n');
    expect(files["lakefile.toml"]).toContain('name = "Lax261Proofs"\n');
    const manifest = JSON.parse(files["lake-manifest.json"]) as { packages: Array<{ name: string }> };
    expect(manifest.packages.map((pkg) => pkg.name)).toEqual(["Lax261", "Lax261Proofs", "Lax42", "LaxCore", "mathlib"]);
    expect(printed(log)).toContain("Generated the edge's bundle");
    expect(printed(log)).toContain("1 edge of lax-261");
  });

  it("composes a relative certificate along the witness forest, outright and relative to a statement", async () => {
    writeChain();
    seedWarmStore();
    const log = quiet();
    const outright = path.join(work, "outright");

    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("Lax42.Primes.InfinitelyManyPrimes", { out: outright }))).toBe(0);

    const files = bundleIn(outright);
    expect(files["Challenge.lean"]).toContain("import Lax42\n\ntheorem Cert.Lax42.Primes.InfinitelyManyPrimes.{«u»} : _root_.Lax42.Primes.InfinitelyManyPrimes.{«u»} := sorry\n");
    expect(files["Solution.lean"]).toContain(
      "import Lax261Proofs\nimport Lax42Proofs\n\n" +
        "theorem Cert.Lax42.Primes.InfinitelyManyPrimes.{«u»} : _root_.Lax42.Primes.InfinitelyManyPrimes.{«u»} := " +
        "@_root_.Lax42Proofs.euclid.{«u»} (@_root_.Lax261Proofs.existsPrimeDivisor)\n",
    );
    expect(JSON.parse(files["comparator.json"])).toMatchObject({ theorem_names: ["Cert.Lax42.Primes.InfinitelyManyPrimes"] });
    // concept packages first, then the proof packages on the path
    expect(files["lakefile.toml"].match(/^name = "(Lax[0-9]+[^"]*)"/gmu)).toEqual(['name = "Lax42"', 'name = "Lax261Proofs"', 'name = "Lax42Proofs"']);
    expect(printed(log)).toContain("Cert.Lax42.Primes.InfinitelyManyPrimes · 2 proofs applied: Lax42Proofs.euclid, Lax261Proofs.existsPrimeDivisor");

    const relative = path.join(work, "relative");
    expect(
      await withTestEnvironmentsAsync([SPEC2], () =>
        certify("Lax42.Primes.InfinitelyManyPrimes", { out: relative, relativeTo: ["Lax42.Primes.ExistsPrimeDivisor"] }),
      ),
    ).toBe(0);
    const relativeFiles = bundleIn(relative);
    expect(relativeFiles["Challenge.lean"]).toContain(
      "theorem Cert.Lax42.Primes.InfinitelyManyPrimes.{«u»}\n    (h₁ : _root_.Lax42.Primes.ExistsPrimeDivisor)\n    : _root_.Lax42.Primes.InfinitelyManyPrimes.{«u»} := sorry\n",
    );
    expect(relativeFiles["Solution.lean"]).toContain(":= @_root_.Lax42Proofs.euclid.{«u»} h₁\n");
    expect(relativeFiles["Solution.lean"]).not.toContain("Lax261Proofs");
    expect(JSON.parse(relativeFiles["comparator.json"])).toMatchObject({ solution_module: "Solution" });
    expect(relativeFiles["lakefile.toml"]).toContain('defaultTargets = ["Challenge", "Solution"]');

    // the folder reused for the record: the relative Solution.lean goes, so
    // the folder holds exactly the record's five files
    quiet();
    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: relative }))).toBe(0);
    expect(fs.existsSync(path.join(relative, "Solution.lean"))).toBe(false);
    expect(Object.keys(bundleIn(relative))).toHaveLength(5);
  });

  it("refuses what it cannot certify, in the author's words", async () => {
    writeChain();
    seedWarmStore();
    writeRecord({ id: "lax-7", repository: "https://github.com/alice/old", environment: epoch().id, specVersion: "1", statements: [{ id: "Lax7.Old.Claim", levelParams: [] }] });
    writeRecord({ id: "lax-8", repository: "https://github.com/alice/empty", statements: [{ id: "Lax8.Primes.Lonely", levelParams: [] }] });
    quiet();
    const run = (target: string, options: Parameters<typeof certify>[1] = {}) =>
      withTestEnvironmentsAsync([SPEC2], () => certify(target, { out: path.join(work, "refused"), ...options }));

    await expect(run("lax-7")).rejects.toThrow(`certificates exist for spec-2 environments only; lax-7 is in ${epoch().id} (spec 1)`);
    await expect(run("lax-9")).rejects.toThrow("lax-9 has no draft or registered record in the local archive copy");
    await expect(run("Lax42.Primes.Nothing")).rejects.toThrow(/is neither a record id \(lax-N\), a proof id, nor a statement id/u);
    await expect(run("lax-8")).rejects.toThrow("lax-8 has no proofs, so the archive certified nothing for it: there is no bundle");
    await expect(run("Lax8.Primes.Lonely")).rejects.toThrow(
      /Lax8\.Primes\.Lonely is not proven by the v4\.35\.0 proof network: no proof of it has every hypothesis proven/u,
    );
    await expect(run("Lax42.Primes.InfinitelyManyPrimes", { relativeTo: ["Lax42.Primes.Nothing"] })).rejects.toThrow(
      "Lax42.Primes.Nothing is not a statement of a v4.35.0 record in the local archive copy",
    );
    await expect(run("Lax42.Primes.InfinitelyManyPrimes", { relativeTo: ["Lax42.Primes.InfinitelyManyPrimes"] })).rejects.toThrow(
      "is among the given statements; nothing is left to prove",
    );
    await expect(run("lax-42", { relativeTo: ["Lax42.Primes.ExistsPrimeDivisor"] })).rejects.toThrow("--relative-to applies to a statement target");
    await expect(run("Lax42Proofs.euclid", { fetch: true })).rejects.toThrow("--fetch pulls a record's stored bundle; name the record");
    fs.mkdirSync(path.join(work, "taken"));
    fs.writeFileSync(path.join(work, "taken", "notes.txt"), "");
    await expect(run("lax-42", { out: path.join(work, "taken") })).rejects.toThrow(/holds notes\.txt; a certificate folder holds the bundle/u);
    // without the warm store there is no manifest to write
    removeTree(path.join(home, "warm"));
    await expect(run("lax-42")).rejects.toThrow(/the v4\.35\.0 workspace is not on this machine/u);
    // and the proof network never crosses environments: a statement's island is its row's
    removeTree(path.join(home, "lax-database"));
    fs.mkdirSync(path.join(home, "lax-database"));
    await expect(run("lax-42")).rejects.toThrow(/there is no local copy of the archive/u);
  });

  it("--run builds both modules from the captures in a fresh project, holds the Challenge, and judges the two exports", async () => {
    writeChain();
    seedWarmStore();
    await serveCaptures();
    fakeToolchain('echo "Your solution is okay!"; exit 0', { inspector: challengeReport() });
    const log = quiet();
    const out = path.join(work, "run");

    const code = await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }));

    expect(code).toBe(0);
    const output = printed(log);
    expect(output).toContain("✓ Packages from the archive");
    expect(output).toContain("2 record packages from verified captures, built from source · libraries from the v4.35.0 workspace");
    expect(output).toContain("✓ Challenge states the edges");
    expect(output).toContain("1 theorem read by the v4.35.0 inspector");
    expect(output).toContain("✓ Certified");
    expect(output).toContain(`${TOOLCHAIN} · kernels: lean`);
    expect(output).toContain("lax-42 is certified: lake comparator --config comparator.json accepted it, against a Challenge that states the edges.");
    // nothing resolved: the Challenge, then the proof package, built; the
    // comparator handed both exports, so it builds nothing
    const lakeArgs = fs.readFileSync(path.join(home, "lake-args"), "utf8").split("\n");
    expect(lakeArgs.slice(0, 2)).toEqual(["build Challenge", "build Lax42Proofs"]);
    expect(lakeArgs[2]).toMatch(/^comparator --config comparator\.json --challenge-from-export \S+\/challenge\.export --solution-from-export \S+\/solution\.export$/u);
    // five sandboxed steps, none with a network; only the two builds have
    // the run project's `.lake` writable, and the run project is not the folder
    const sandboxed = fs.readFileSync(path.join(home, "bwrap-args"), "utf8").trim().split("\n");
    expect(sandboxed).toHaveLength(5);
    expect(sandboxed.some((line) => line.includes("--share-net"))).toBe(false);
    expect(sandboxed.map((line) => /--bind \S+\/project\/\.lake /u.test(line))).toEqual([true, false, false, true, false]);
    // the proof package's copy lies beside the project: read-only while the
    // Challenge — the concept packages' code — builds, writable only for its
    // own build (A1: nothing of any proof package is writable there)
    expect(sandboxed.map((line) => /--bind \S+\/proofs \S+\/proofs /u.test(line))).toEqual([false, false, false, true, false]);
    expect(sandboxed[0]).toMatch(/--ro-bind \S+\/proofs \S+\/proofs /u);
    expect(sandboxed[4]).toMatch(/LEAN_PATH \S+:\S+\/proofs\/Lax42Proofs\/\.lake\/build\/lib\/lean/u);
    expect(sandboxed.some((line) => line.includes(out))).toBe(false);
    expect(sandboxed[1]).toContain("leanexport Challenge -- Quot Quot.mk Quot.lift Quot.ind Lax42Proofs.euclid propext");
    expect(sandboxed[2]).toMatch(/laxinspector --spec 2 \S+\/challenge-report\.json Challenge$/u);
    expect(sandboxed[4]).toContain("leanexport Lax42Proofs -- Quot Quot.mk Quot.lift Quot.ind Lax42Proofs.euclid propext");
    // the search path: the run project's tree, the captured packages' copies, the warm store's
    expect(sandboxed[2]).toMatch(/LEAN_PATH \S+\/project\/\.lake\/build\/lib\/lean:\S+\/project\/\.lake\/sources\/Lax42\/\.lake\/build\/lib\/lean:/u);
    // the captures are in lax's own store, verified, and nothing went to the folder but the bundle
    expect(fs.readdirSync(path.join(home, "captures")).sort()).toEqual(["lax-42"]);
    expect(fs.readdirSync(out).sort()).toEqual(["Challenge.lean", "comparator.json", "lake-manifest.json", "lakefile.toml", "lean-toolchain"]);

    // an older CLI's cache beside the current one is removed on the next pull
    fs.mkdirSync(path.join(home, "prooftree-captures", "lax-7", "a".repeat(64)), { recursive: true });

    // a refusal is a finding on the certificate phase, with the comparator's words
    fs.rmSync(path.join(home, "bin"), { recursive: true });
    fakeToolchain(`echo "error: Illegal axiom detected: 'sorryAx'" >&2; exit 1`, { inspector: challengeReport() });
    const refused = quiet();
    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true, paranoid: true }))).toBe(1);
    const refusal = printed(refused);
    expect(refusal).toContain("✗ Refused");
    expect(refusal).toContain("certificate · illegal-axiom");
    expect(refusal).toContain("rest on the axiom sorryAx");
    expect(fs.existsSync(path.join(home, "prooftree-captures"))).toBe(false);
    expect(fs.readdirSync(path.join(home, "captures"))).toEqual(["lax-42"]);
    // --paranoid went to the comparator's command line
    expect(fs.readFileSync(path.join(home, "lake-args"), "utf8")).toMatch(/comparator --config comparator\.json --challenge-from-export \S+ --solution-from-export \S+ --paranoid\n/u);
  });

  it("--run never runs a host tool in the folder's `.lake`: a planted core.fsmonitor stays unfired (S1)", async () => {
    writeChain();
    seedWarmStore();
    await serveCaptures();
    // a real git beside the fakes: the trap below fires under any host
    // `git status` in the checkout
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8", env: { PATH: previous.path ?? "" } }).stdout.trim();
    expect(realGit).not.toBe("");
    fakeToolchain('echo "Your solution is okay!"; exit 0', { inspector: challengeReport(), git: false });
    process.env.PATH = `${process.env.PATH}${path.delimiter}${path.dirname(realGit)}`;
    const out = path.join(work, "planted");
    const checkout = path.join(out, ".lake", "packages", "Lax42");
    fs.mkdirSync(checkout, { recursive: true });
    const git = (...args: string[]) =>
      spawnSync(realGit, args, { cwd: checkout, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(git("init", "-q").status).toBe(0);
    // what a previous run's proof code could have written, HEAD and tree clean
    const marker = path.join(home, "fsmonitor-fired");
    expect(git("config", "core.fsmonitor", `touch ${marker}; false`).status).toBe(0);
    quiet();

    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }))).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    // the folder's `.lake` is left as it was: neither read nor cleaned
    expect(fs.existsSync(path.join(checkout, ".git", "config"))).toBe(true);
    // and the trap is live: one host `git status` there fires it
    git("status", "--porcelain");
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("--run takes a record package only from a capture of the commit the bundle pins", async () => {
    writeChain();
    seedWarmStore();
    await serveCaptures();
    fakeToolchain('echo "Your solution is okay!"; exit 0', { inspector: challengeReport() });
    quiet();
    // the record's capture is of another commit than its source
    const output = path.join(home, "lax-database", "lax-42", "build-output.json");
    const stored = JSON.parse(fs.readFileSync(output, "utf8")) as { capture: { sourceCommit: string } };
    stored.capture.sourceCommit = "f".repeat(40);
    fs.writeFileSync(output, JSON.stringify(stored));
    await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: path.join(work, "run"), run: true }))).rejects.toThrow(
      /lax-42's capture is of f{40}, its record of 0{38}42 — the archive's record is inconsistent/u,
    );
    // and a capture the registry does not hold is named, not built around
    writeChain();
    ghcr!.state.blobs.clear();
    removeTree(path.join(home, "captures"));
    await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: path.join(work, "run"), run: true }))).rejects.toThrow(
      /could not take lax-42's capture [0-9a-f]{12} from the registry/u,
    );
    expect(fs.existsSync(path.join(home, "lake-args"))).toBe(false);
  });

  it("--run refuses a Challenge that elaborated to something else, before the comparator runs", async () => {
    writeChain();
    seedWarmStore();
    await serveCaptures();
    fakeToolchain('echo "Your solution is okay!"; exit 0', { inspector: challengeReport(true) });
    const log = quiet();
    const out = path.join(work, "run");

    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }))).toBe(1);
    const output = printed(log);
    expect(output).toContain("✗ Refused");
    expect(output).toContain("challenge-mismatch");
    expect(output).toContain("Lax42Proofs.euclid states the edge {Lax42.Primes.ExistsPrimeDivisor} → Lax42.Primes.InfinitelyManyPrimes.{u}.{u}");
    expect(output).toContain("elaborated to {} → True");
    // neither the proof package built nor the comparator run
    expect(fs.readFileSync(path.join(home, "lake-args"), "utf8")).toBe("build Challenge\n");

    // a Challenge that does not build is the translation's finding, not a run failure
    fs.rmSync(path.join(home, "bin"), { recursive: true });
    fs.rmSync(path.join(home, "lake-args"));
    fakeToolchain('echo "Your solution is okay!"; exit 0', { inspector: challengeReport(), build: 'echo "error: unknown constant" >&2; exit 1' });
    const broken = quiet();
    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }))).toBe(1);
    expect(printed(broken)).toContain("challenge-build");
    expect(fs.readFileSync(path.join(home, "lake-args"), "utf8")).not.toContain("comparator");

    // a proof package that does not build from its captured sources is the
    // translation's finding too, and the comparator never runs
    fs.rmSync(path.join(home, "bin"), { recursive: true });
    fs.rmSync(path.join(home, "lake-args"));
    fakeToolchain('echo "Your solution is okay!"; exit 0', {
      inspector: challengeReport(),
      build: 'if [ "$2" = Lax42Proofs ]; then echo "error: unknown identifier" >&2; exit 1; fi',
    });
    const solution = quiet();
    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }))).toBe(1);
    expect(printed(solution)).toContain("solution-build");
    expect(printed(solution)).toContain("the solution module Lax42Proofs did not build from the records' captured sources");
    expect(fs.readFileSync(path.join(home, "lake-args"), "utf8")).not.toContain("comparator");
  });

  it("--run without an inspector says the Challenge's meaning was not checked, never certified", async () => {
    writeChain();
    seedWarmStore();
    await serveCaptures();
    fakeToolchain('echo "Your solution is okay!"; exit 0');
    const log = quiet();
    const out = path.join(work, "run");

    expect(await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }))).toBe(0);
    const output = printed(log);
    expect(output).toContain("! Challenge meaning not checked");
    expect(output).toContain("✓ Comparator accepted");
    expect(output).toContain("lax-42: comparator accepted; Challenge meaning not checked.");
    expect(output).not.toContain("is certified");
    expect(output).toContain("the v4.35.0 inspector could not be built here");
    // the inspector's failed build, then both modules, then the comparator over both exports
    const lakeArgs = fs.readFileSync(path.join(home, "lake-args"), "utf8").trim().split("\n");
    expect(lakeArgs.slice(0, 3)).toEqual(["build", "build Challenge", "build Lax42Proofs"]);
    expect(lakeArgs[3]).toMatch(/^comparator --config comparator\.json --challenge-from-export \S+ --solution-from-export \S+$/u);
  });

  it("--run insists on bubblewrap and on the toolchain", async () => {
    writeChain();
    seedWarmStore();
    quiet();
    const out = path.join(work, "run");
    await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }))).rejects.toThrow(
      `the v4.35.0 toolchain is not installed — run lax doctor --env v4.35.0`,
    );
    fakeToolchain("exit 0", { bwrap: false });
    await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }))).rejects.toThrow(
      /needs a tool it cannot find:\nbwrap — every build, export and kernel of the run is confined by bubblewrap/u,
    );
    // the preflight checks the bubblewrap the run would start: COMPARATOR_BWRAP
    // when set, whatever PATH holds
    const alternative = path.join(home, "alt", "bwrap");
    process.env.COMPARATOR_BWRAP = alternative;
    try {
      await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true }))).rejects.toThrow(
        `needs a tool it cannot find:\n${alternative} — every build, export and kernel of the run is confined by bubblewrap, which is what makes the rerun trustworthy; COMPARATOR_BWRAP names it, and it did not run`,
      );
      fs.mkdirSync(path.dirname(alternative));
      fs.writeFileSync(alternative, "#!/bin/sh\necho 'bubblewrap 0.9.0'\n", { mode: 0o755 });
      const outcome = await withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out, run: true })).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(outcome).not.toContain("cannot find");
    } finally {
      delete process.env.COMPARATOR_BWRAP;
    }
    // the bundle was still written: the author can run it elsewhere
    expect(readBundle(sealBundle(bundleIn(out)).tar).size).toBe(5);
  });

  it("names a cache-only fetch failure when the registry is unreachable", async () => {
    writeChain();
    writeRecord({
      id: "lax-42",
      repository: "https://github.com/alice/primes",
      statements: [{ id: "Lax42.Primes.ExistsPrimeDivisor", levelParams: [] }, { id: "Lax42.Primes.InfinitelyManyPrimes", levelParams: ["u"] }],
      proofs: [EUCLID],
      certificate: { digest: createHash("sha256").update("x").digest("hex"), registryBlob: `ghcr.io/${CAPTURES_REPOSITORY}@sha256:${createHash("sha256").update("x").digest("hex")}` },
    });
    process.env.LAX_CAPTURE_REGISTRY_URL = "http://127.0.0.1:9";
    quiet();
    await expect(withTestEnvironmentsAsync([SPEC2], () => certify("lax-42", { out: path.join(work, "f"), fetch: true }))).rejects.toThrow(
      /could not fetch lax-42's bundle/u,
    );
  });
});
