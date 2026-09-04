// Facts about a Lean/Lake release that lax hardcodes: the literals that would
// have to change if a future toolchain changed them, gathered in one place and
// keyed by environment id rather than copied to the call sites that need them.
//
// There is a single value today, shared by every admitted environment, because
// nothing in the table diverges yet; the point of the module is that a
// divergence is one row here instead of a hunt through the tree. Add a keyed
// entry when a release forces one, and leave the shared record as the default.
//
// Two copies deliberately stay outside this module because they cannot import
// it: `sandbox/tools/run-check.mjs` runs inside the container (its header says
// to keep it in step with config.ts), and
// `lean/inspector/lake-manifest.json` is a Lake input file shipped as source,
// carrying the same manifest schema version as `lakeManifestVersion` below.

import { EPOCH, type ArchiveEnvironment } from "./environments.js";

export interface LeanFacts {
  /** Schema version of a `lake-manifest.json` / `package-overrides.json`. */
  lakeManifestVersion: string;
  /** Lake's build tree inside a package: `<package>/.lake`. */
  lakeDir: string;
  /** Where lake puts a library's oleans: `<package>/.lake/build/lib/lean`. */
  lakeLibDir: readonly string[];
  /** Where lake puts an executable: `<package>/.lake/build/bin`. */
  lakeBinDir: readonly string[];
  /** Where lake materializes dependencies: `<workspace>/.lake/packages`. */
  lakePackagesDir: readonly string[];
  /** Where lake puts the C output the capture carries: `.lake/build/ir`. */
  lakeIrDir: readonly string[];
  /** The module roots a submission may import without declaring a dependency:
   * Lean's own core libraries and the archive's background mathlib. */
  coreImportRoots: readonly string[];
  /** The axioms a kernel-clean proof may still depend on. Duplicated nowhere
   * else: the inspect phase and the proof-tree composer both read it here. */
  backgroundAxioms: readonly string[];
  /** elan's toolchain directory naming: `leanprover/lean4:v4.30.0` becomes
   * `leanprover--lean4---v4.30.0` under `~/.elan/toolchains/`. */
  elanToolchainDirName: (toolchain: string) => string;
  /** What leanchecker and lean say when a module they were told to replay is
   * not on the composed LEAN_PATH — an archive bug, never an author's. */
  missingModulePattern: RegExp;
  /** `Lake version 5.0.0 (Lean version 4.30.0)` → the two numbers. */
  parseLakeBanner: (raw: string) => { lean?: string; lake?: string };
}

const SHARED: LeanFacts = {
  lakeManifestVersion: "1.2.0",
  lakeDir: ".lake",
  lakeLibDir: [".lake", "build", "lib", "lean"],
  lakeBinDir: [".lake", "build", "bin"],
  lakePackagesDir: [".lake", "packages"],
  lakeIrDir: [".lake", "build", "ir"],
  coreImportRoots: ["Init", "Std", "Lean", "Mathlib"],
  backgroundAxioms: ["propext", "Classical.choice", "Quot.sound"],
  elanToolchainDirName: (toolchain) => toolchain.replace("/", "--").replace(":", "---"),
  missingModulePattern:
    /(?:unknown module|object file.*(?:not found|does not exist)|cannot find.*\.olean)/iu,
  parseLakeBanner: (raw) => ({
    lean: /Lean version ([^\s)]+)/u.exec(raw)?.[1],
    lake: /Lake version (\S+)/u.exec(raw)?.[1],
  }),
};

/** Per-version overrides. Empty while every admitted environment agrees. */
const BY_VERSION: Readonly<Record<string, LeanFacts>> = {};

/**
 * The facts for an environment. The argument is an entry or its id; omitting
 * it means the epoch's, for the few callers that classify a transcript with no
 * environment in hand (failures.ts) — the wording is the same for every
 * admitted version today, and this is where a divergence would be recorded.
 */
export function leanFacts(environment: ArchiveEnvironment | string = EPOCH): LeanFacts {
  const id = typeof environment === "string" ? environment : environment.id;
  return BY_VERSION[id] ?? SHARED;
}
