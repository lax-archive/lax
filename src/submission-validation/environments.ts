// The archive environments: the table of Lean toolchain + library-pin rows a
// submission may be built in, and the one this year's archive recommends (the
// *epoch*). One environment per Lean minor version, pinned at mathlib's
// `vX.Y.0` release tag, identified by that version string — which is also the
// manifest's `leanVersion`, so an author needs no new vocabulary.
//
// A row also fixes the *content spec* its records follow (`specVersion`): the
// spec-1 rows pin mathlib alone; a spec-2 row (axiomfree-plan.md, "Environment
// libraries") pins a *set* of libraries — mathlib and `LaxCore` required,
// CSLib allowed — under one rule, each a repository from pins.ts plus the
// commit the row pins. `librariesOf()` is the one reading of that set: the
// warm workspace requires it, the lakefile rule is keyed by it, and a spec-1
// row needs no new field for it.
//
// The table only grows. An entry is never edited except to add `limits` or
// `closedAt`: a record built in an environment stays valid forever, and the
// trusted workflow, the CLI, and the website all resolve a record's pins by
// looking its `manifest.leanVersion` up here. A new environment therefore
// reaches authors with the next CLI release, and a record in an environment
// the installed CLI does not know says exactly that.
//
// Trust rule 2 applies to every id that arrives from a manifest or a report:
// it is only ever a lookup key. Directory names, cache keys, and mount
// sources derive from the *entry* this module returns, never from the input
// string.
//
// Test/dev seam: LAX_MATHLIB_URL/LAX_MATHLIB_REV substitute a small local
// "mathlib" for the real one (see pins.ts), LAX_LAXCORE_REV and LAX_CSLIB_REV
// do the same for the other two libraries of a spec-2 row, and
// LAX_TEST_ENVIRONMENTS adds fake environments sharing the installed
// toolchain. All are read at call time, so a test may set them after this
// module is imported. Never set in production.

import type { ValidationLimits } from "./config.js";
import type { ValidationRuntimeIdentity } from "./contracts.js";
import { cslibUrl, laxCoreUrl, mathlibUrl } from "./pins.js";

/** The Lake package names of the libraries an environment can pin. The name
 * is what a submission's `[[require]]` says and what Lake checks against the
 * dependency's own `lakefile.toml` (`cslib`, lower case, is CSLib's). */
export type LibraryName = "mathlib" | "LaxCore" | "cslib";

/** The libraries this module knows how to pin, and where each one lives. A
 * name outside this set is never a library: it is a submission's package. */
export const LIBRARY_URLS: Readonly<Record<LibraryName, () => string>> = {
  mathlib: mathlibUrl,
  LaxCore: laxCoreUrl,
  cslib: cslibUrl,
};

/** The root module of each library: what the warm workspace imports to build
 * it (host/warmstore.ts), and the import prefix a package that requires the
 * library may use (phases/inspect.ts). */
export const LIBRARY_ROOT_MODULES: Readonly<Record<LibraryName, string>> = {
  mathlib: "Mathlib",
  LaxCore: "LaxCore",
  cslib: "Cslib",
};

/** One library of an environment's pinned set. `url` is a function so the
 * test seams in pins.ts are read when the pin is used, not when the table is
 * declared. `required`: every package of the environment must require it
 * directly (mathlib, LaxCore); otherwise a package may (CSLib). */
export interface PinnedLibrary {
  name: LibraryName;
  url: () => string;
  commit: string;
  required: boolean;
}

/** What every row carries, whichever content spec it follows. */
interface EnvironmentRow {
  /** Lean version and mathlib tag name: "v4.30.0". The only author-facing id. */
  id: string;
  /** "leanprover/lean4:v4.30.0" — mathlib's own lean-toolchain at the tag. */
  leanToolchain: string;
  /** ISO date of admission (the environments.yml run, or the go-live pin). */
  admittedAt: string;
  /** Inspector source directory under src/submission-validation/lean/. */
  inspector: "inspector" | string;
  /** Measured overrides of DEFAULT_LIMITS (leanThreads, memoryBytes, and
   * compileLeanThreads — the admission script writes the first two; the
   * compile count is lowered by hand when a `lake build` outgrows the cap). */
  limits?: Partial<Pick<ValidationLimits, "leanThreads" | "compileLeanThreads" | "memoryBytes">>;
  /** UTC date on which newly created Archive records stop being accepted.
   * Older records, including init stubs which submit later, remain valid. */
  closedAt?: string;
}

/**
 * A row as the table declares it. A spec-1 row pins mathlib in
 * `mathlibCommit`, as it always has; a spec-2 row pins its whole library set
 * in `libraries` — mathlib among them — and nothing else, so one pin is
 * written once. `environments()` turns either into an ArchiveEnvironment.
 */
export type ArchiveEnvironmentRow =
  | (EnvironmentRow & {
      specVersion: 1;
      /** The commit mathlib's tag pointed to when admitted. Tags can move; this cannot. */
      mathlibCommit: string;
    })
  | (EnvironmentRow & {
      specVersion: 2;
      /** The pinned set, mathlib first; see PinnedLibrary. */
      libraries: readonly PinnedLibrary[];
    });

/**
 * An admitted environment as every consumer sees it: the row, plus
 * `mathlibCommit` on a spec-2 row as well (its mathlib library's commit), so
 * the runtime identity, the capture provenance, the store directories, and
 * every other reader of mathlib's pin stay one shape across both specs.
 */
export type ArchiveEnvironment = ArchiveEnvironmentRow & { mathlibCommit: string };

/** The environment the archive recommends this year. Exactly one at a time;
 * moved once a year by the epoch-bump runbook, never by an admission. */
export const EPOCH = "v4.33.0";

/** An environment id is a Lean version string and nothing else. Enforced on
 * the injected test entries too, so no id can ever carry a path separator. */
const ID_PATTERN = /^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u;

/**
 * The admitted environments, oldest first. `v4.30.0` is the floor: the
 * package-overrides and artifact-cache behaviour the warm store relies on did
 * not exist in earlier Lake versions, so nothing older will be admitted. No
 * spec-2 row yet: the first one is `v4.35.0`, admitted by hand once mathlib's
 * tag exists (axiomfree-plan.md, stage 6).
 */
const TABLE: readonly ArchiveEnvironmentRow[] = [
  {
    id: "v4.30.0",
    specVersion: 1,
    leanToolchain: "leanprover/lean4:v4.30.0",
    mathlibCommit: "c5ea00351c28e24afc9f0f84379aa41082b1188f",
    // the go-live pin (history/go-live.md), not an admission run
    admittedAt: "2026-08-06",
    inspector: "inspector",
    // Every production record present at closure predates 2026-09-12. Keep
    // these pins for those records, but do not let a new record join this
    // environment after v4.33.0 became the epoch.
    closedAt: "2026-09-12",
  },
  {
    id: "v4.33.0",
    specVersion: 1,
    leanToolchain: "leanprover/lean4:v4.33.0",
    mathlibCommit: "db584cd6d46c92f209a44c0f1c829460d327499d",
    // the admission run (2026-09-04, run 33870950217) measured a 1.15 GiB
    // heaviest-span peak over the smoke fixtures, which import little of
    // mathlib: a fixture figure, not a submission budget, so the entry
    // inherits DEFAULT_LIMITS like the epoch (environments.yml, "Record the
    // measurement", and the plan's admission checklist)
    admittedAt: "2026-09-04",
    inspector: "inspector",
  },
];

/**
 * Every admitted environment. Read at call time so the library test seams can
 * be set after this module is imported: LAX_MATHLIB_REV substitutes the fake
 * mathlib's commit for the real one (LAX_LAXCORE_REV and LAX_CSLIB_REV the
 * same for a spec-2 row's other libraries), and LAX_TEST_ENVIRONMENTS appends
 * whole fake entries that share the installed toolchain.
 */
export function environments(): readonly ArchiveEnvironment[] {
  const table = TABLE.map(resolveRow);
  return [...table, ...testEnvironments(table)];
}

/** The commit a seam substitutes for a library's, or undefined. */
function seamRev(name: LibraryName): string | undefined {
  const raw = process.env[
    { mathlib: "LAX_MATHLIB_REV", LaxCore: "LAX_LAXCORE_REV", cslib: "LAX_CSLIB_REV" }[name]
  ];
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * A declared row as consumers see it: the seams applied, and a spec-2 row's
 * `mathlibCommit` filled in from its mathlib library. A spec-2 row that pins
 * no mathlib, or pins a library twice, is a table bug and fails here, at the
 * first read, rather than in a provisioning run.
 */
function resolveRow(row: ArchiveEnvironmentRow): ArchiveEnvironment {
  if (row.specVersion === 1) {
    const rev = seamRev("mathlib");
    return rev === undefined ? row : { ...row, mathlibCommit: rev };
  }
  const libraries = row.libraries.map((library) => {
    const rev = seamRev(library.name);
    return rev === undefined ? library : { ...library, commit: rev };
  });
  const names = libraries.map((library) => library.name);
  if (new Set(names).size !== names.length)
    throw new Error(`environment ${row.id} pins a library twice`);
  const mathlib = libraries.find((library) => library.name === "mathlib");
  if (mathlib === undefined || !mathlib.required)
    throw new Error(`environment ${row.id} must pin mathlib as a required library`);
  return { ...row, libraries, mathlibCommit: mathlib.commit };
}

/**
 * The pinned library set of an environment, mathlib first: the whole set a
 * warm workspace requires and the lakefile rule is keyed by. A spec-1 row's
 * set is mathlib alone, synthesised from its `mathlibCommit`, so the two
 * specs share every consumer.
 */
export function librariesOf(entry: ArchiveEnvironment): readonly PinnedLibrary[] {
  if (entry.specVersion === 2) return entry.libraries;
  return [{ name: "mathlib", url: mathlibUrl, commit: entry.mathlibCommit, required: true }];
}

/**
 * The set a *run's* lakefile rule is keyed by: the entry's libraries, with
 * mathlib's pin read from the runtime identity like every other pin check of
 * the static phase. The two agree whenever the runtime came from the table
 * (pins.ts hostValidationRuntime); only the fixed-runtime seam — the local
 * `options.runtime` and the unit tests — holds a run to a runtime the table
 * row may not match, and there the runtime wins, as it does for the toolchain
 * and `mathlibVersion` checks.
 */
export function runtimeLibraries(
  entry: ArchiveEnvironment,
  runtime: ValidationRuntimeIdentity,
): readonly PinnedLibrary[] {
  return librariesOf(entry).map((library) =>
    library.name === "mathlib"
      ? { ...library, url: () => runtime.mathlibRepository, commit: runtime.mathlibCommit }
      : library,
  );
}

/**
 * The short form of an environment's library pins, for the names of what is
 * provisioned from them: the warm store directory and the host cache key.
 * Twelve characters of each commit in set order — a spec-1 row's is its
 * mathlib commit's, exactly as before there were sets, so no existing store
 * or cache entry moves.
 */
export function libraryPinKey(entry: ArchiveEnvironment): string {
  return librariesOf(entry)
    .map((library) => library.commit.slice(0, 12))
    .join("-");
}

/** Environments available to newly created Archive records. Closed rows stay
 * in `environments()` because existing records must remain reproducible. */
export function activeEnvironments(): readonly ArchiveEnvironment[] {
  return environments().filter((entry) => entry.closedAt === undefined);
}

/** The entry an id names, or undefined. The id is untrusted input everywhere
 * it is called from, and this is the only thing that is ever done with it. */
export function environment(id: string): ArchiveEnvironment | undefined {
  if (!ID_PATTERN.test(id)) return undefined;
  return environments().find((entry) => entry.id === id);
}

/** The epoch's entry. Present by construction: EPOCH names a table row. */
export function epoch(): ArchiveEnvironment {
  const entry = environments().find((candidate) => candidate.id === EPOCH);
  if (entry === undefined) throw new Error(`the epoch ${EPOCH} is not in the environment table`);
  if (entry.closedAt !== undefined) throw new Error(`the epoch ${EPOCH} is closed to new submissions`);
  return entry;
}

/** Every admitted environment with the epoch first and every other entry in
 * table order. The table itself stays oldest-first: admission scripts append
 * to it, while author-facing lists lead with the current recommendation. */
export function environmentsEpochFirst(): readonly ArchiveEnvironment[] {
  const admitted = environments();
  const index = admitted.findIndex((entry) => entry.id === EPOCH);
  if (index <= 0) return admitted;
  return [admitted[index]!, ...admitted.slice(0, index), ...admitted.slice(index + 1)];
}

/** Active environments in author-facing order. This is the set `lax init`
 * and `lax port` may target; it is deliberately smaller than the set the
 * validator and host provisioner know how to reproduce. */
export function activeEnvironmentsEpochFirst(): readonly ArchiveEnvironment[] {
  const active = activeEnvironments();
  const index = active.findIndex((entry) => entry.id === EPOCH);
  if (index <= 0) return active;
  return [active[index]!, ...active.slice(0, index), ...active.slice(index + 1)];
}

/** The admitted ids for an author-facing message, epoch first and marked. */
export function admittedEnvironmentList(): string {
  return environmentsEpochFirst()
    .map((entry) => {
      const status = [
        ...(entry.id === EPOCH ? ["epoch"] : []),
        ...(entry.closedAt === undefined ? [] : ["closed"]),
      ];
      return status.length === 0 ? entry.id : `${entry.id} (${status.join(", ")})`;
    })
    .join(", ");
}

/** The ids new submissions may select, with the epoch marked. */
export function activeEnvironmentList(): string {
  return activeEnvironmentsEpochFirst()
    .map((entry) => (entry.id === EPOCH ? `${entry.id} (epoch)` : entry.id))
    .join(", ");
}

/** Whether a table row accepts a record with this already-schema-validated
 * UTC creation timestamp. A closure starts at 00:00 UTC on `closedAt`; this
 * makes the rule stable for an init stub no matter when its first build lands. */
export function environmentAcceptsRecord(
  entry: ArchiveEnvironment,
  recordCreatedAt: string,
): boolean {
  return entry.closedAt === undefined || recordCreatedAt < `${entry.closedAt}T00:00:00Z`;
}

/**
 * The environment a published capture was built in, found by its recorded
 * pins rather than by an id it does not carry. Undefined when no admitted
 * environment matches — a capture from before an entry was written, or from
 * an environment newer than this CLI's table.
 */
export function environmentOfPins(
  leanToolchain: string,
  mathlibCommit: string,
): ArchiveEnvironment | undefined {
  return environments().find(
    (entry) => entry.leanToolchain === leanToolchain && entry.mathlibCommit === mathlibCommit,
  );
}

/**
 * How the static phase turns the environment a manifest names into the run's
 * runtime identity. The pipelines pass their own builder — the host one or
 * the container one — so selection is a change in *where the runtime comes
 * from*, not in the checks. A fixed identity is the pinned form: it ignores
 * the table and holds the run to one runtime, which is what the local
 * `options.runtime` seam and the unit tests want.
 */
export type RuntimeSource =
  | ValidationRuntimeIdentity
  | ((environment: ArchiveEnvironment) => ValidationRuntimeIdentity);

export function resolveRuntime(
  source: RuntimeSource,
  selected: ArchiveEnvironment,
): ValidationRuntimeIdentity {
  return typeof source === "function" ? source(selected) : source;
}

/**
 * Fake environments injected by LAX_TEST_ENVIRONMENTS, a JSON list of
 * `{ id, mathlibCommit?, leanToolchain?, admittedAt?, specVersion?,
 * libraries? }`. Each shares the installed toolchain and the active mathlib
 * commit unless it says otherwise, so a test can prove the multi-environment
 * paths without a second Lean install. `specVersion: 2` makes a spec-2 row:
 * its set is mathlib (required, at the entry's mathlib commit) plus every
 * `libraries` entry `{ name, commit, required? }` — LaxCore required and
 * cslib allowed unless said otherwise — resolved through the same seams as a
 * table row. Ids are held to the same pattern as the real ones and duplicates
 * are ignored.
 */
function testEnvironments(table: readonly ArchiveEnvironment[]): ArchiveEnvironment[] {
  const raw = process.env.LAX_TEST_ENVIRONMENTS;
  if (raw === undefined || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`LAX_TEST_ENVIRONMENTS is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("LAX_TEST_ENVIRONMENTS must be a JSON list");
  const installed = table.find((entry) => entry.id === EPOCH) ?? table[0];
  if (installed === undefined) throw new Error("LAX_TEST_ENVIRONMENTS needs a real entry to borrow from");
  const known = new Set(table.map((entry) => entry.id));
  const extra: ArchiveEnvironment[] = [];
  for (const value of parsed) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("LAX_TEST_ENVIRONMENTS entries must be JSON objects");
    const entry = value as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id))
      throw new Error("LAX_TEST_ENVIRONMENTS entries need an id shaped like v4.30.0");
    if (known.has(id)) continue;
    known.add(id);
    const shared: EnvironmentRow = {
      id,
      leanToolchain:
        typeof entry.leanToolchain === "string" ? entry.leanToolchain : installed.leanToolchain,
      admittedAt: typeof entry.admittedAt === "string" ? entry.admittedAt : installed.admittedAt,
      inspector: "inspector",
    };
    const mathlibCommit =
      typeof entry.mathlibCommit === "string" ? entry.mathlibCommit : installed.mathlibCommit;
    if (entry.specVersion === undefined || entry.specVersion === 1) {
      extra.push({ ...shared, specVersion: 1, mathlibCommit });
      continue;
    }
    if (entry.specVersion !== 2)
      throw new Error("LAX_TEST_ENVIRONMENTS entries carry specVersion 1 or 2");
    const libraries: PinnedLibrary[] = [
      { name: "mathlib", url: mathlibUrl, commit: mathlibCommit, required: true },
    ];
    const declared = entry.libraries ?? [];
    if (!Array.isArray(declared)) throw new Error("LAX_TEST_ENVIRONMENTS libraries must be a JSON list");
    for (const item of declared) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        throw new Error("LAX_TEST_ENVIRONMENTS libraries entries must be JSON objects");
      const library = item as Record<string, unknown>;
      const name = library.name;
      if (name !== "LaxCore" && name !== "cslib")
        throw new Error("LAX_TEST_ENVIRONMENTS libraries name LaxCore or cslib (mathlib is implied)");
      if (typeof library.commit !== "string" || !/^[0-9a-f]{40}$/u.test(library.commit))
        throw new Error(`LAX_TEST_ENVIRONMENTS: ${name} needs a full commit`);
      libraries.push({
        name,
        url: LIBRARY_URLS[name],
        commit: library.commit,
        required: typeof library.required === "boolean" ? library.required : name === "LaxCore",
      });
    }
    // through resolveRow so a seam set after injection still applies, and so
    // a duplicate name fails the same way a table row's would
    extra.push(resolveRow({ ...shared, specVersion: 2, libraries }));
  }
  return extra;
}
