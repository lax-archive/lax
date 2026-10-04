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
  /** What Lean's import says when a package's own oleans cannot be loaded
   * together, and what the inspector says when an olean lists a constant it
   * does not carry — the author's, under spec 2 (phases/inspect-runner.ts
   * inspectorExitFailure). Kept to the shapes only a submission's own olean
   * *content* can cause: a constant two of its modules both declare
   * (`finalizeImport`'s refusal) and a constant a module lists but does not
   * carry (the inspector's). The shapes a truncated capture, a toolchain
   * mismatch or a missing companion file produce — `failed to read file`,
   * `invalid header`, `incompatible header`, `not a valid .olean`, a missing
   * data file — stay the archive's: they arise as readily from the
   * archive's own handling of the bytes as from the author's build
   * (verification review 2026-10-04). */
  oleanRefusalPattern: RegExp;
  /** `Lake version 5.0.0 (Lean version 4.30.0)` → the two numbers. */
  parseLakeBanner: (raw: string) => { lean?: string; lake?: string };
  /** The constants `lake comparator` exports from both modules beside the
   * named theorems and the permitted axioms, because the kernel assumes them
   * (`Lake/CLI/Check.lean`, `primitiveTargets` — "git grep
   * new_persistent_expr_const src/kernel/"), plus the `Quot` four it adds when
   * `Quot.sound` is permitted (`builtinTargets`). Container A exports the
   * Challenge with exactly the comparator's own list, so the comparison in
   * container B finds every constant it looks up. */
  comparatorExportTargets: readonly string[];
  /** The checkers `--paranoid` adds beside Lean's kernel, in the order
   * `Lake/CLI/Check.lean` `bundledKernels` runs them, by the names the record
   * uses for them. */
  paranoidKernels: readonly ["leanchecker-paranoid", "lean4lean", "nanoda", "con-leche", "con-ron"];
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
  oleanRefusalPattern:
    /(?:import .* failed, environment already contains|constant .* of module .* not found)/iu,
  parseLakeBanner: (raw) => ({
    lean: /Lean version ([^\s)]+)/u.exec(raw)?.[1],
    lake: /Lake version (\S+)/u.exec(raw)?.[1],
  }),
  // Transcribed from the v4.35.0-rc3 toolchain's `Lake/CLI/Check.lean`
  // (`builtinTargets` ++ `primitiveTargets`); the theorem names and the
  // permitted axioms go between the two groups in the comparator's own list,
  // which is a set to the exporter.
  comparatorExportTargets: [
    "Quot", "Quot.mk", "Quot.lift", "Quot.ind",
    "Nat.add", "Nat.sub", "Nat.mul", "Nat.pow", "Nat.gcd", "Nat.div", "Nat.mod", "Nat.beq",
    "Nat.ble", "Nat.land", "Nat.lor", "Nat.xor", "Nat.shiftLeft", "Nat.shiftRight",
    "String.ofList", "Char.ofNat", "List", "eagerReduce", "Nat", "String", "String.mk", "Char",
    "optParam", "autoParam", "semiOutParam", "outParam",
  ],
  paranoidKernels: ["leanchecker-paranoid", "lean4lean", "nanoda", "con-leche", "con-ron"],
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
