// The archive environments: the table of Lean toolchain + mathlib commit
// pairs a submission may be built in, and the one this year's archive
// recommends (the *epoch*). One environment per Lean minor version, pinned at
// mathlib's `vX.Y.0` release tag, identified by that version string — which is
// also the manifest's `leanVersion`, so an author needs no new vocabulary.
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
// "mathlib" for the real one (see pins.ts), and LAX_TEST_ENVIRONMENTS adds
// fake environments sharing the installed toolchain. Both are read at call
// time, so a test may set them after this module is imported. Never set in
// production.

import type { ValidationLimits } from "./config.js";
import type { ValidationRuntimeIdentity } from "./contracts.js";

export interface ArchiveEnvironment {
  /** Lean version and mathlib tag name: "v4.30.0". The only author-facing id. */
  id: string;
  /** "leanprover/lean4:v4.30.0" — mathlib's own lean-toolchain at the tag. */
  leanToolchain: string;
  /** The commit mathlib's tag pointed to when admitted. Tags can move; this cannot. */
  mathlibCommit: string;
  /** ISO date of admission (the environments.yml run, or the go-live pin). */
  admittedAt: string;
  /** Inspector source directory under src/submission-validation/lean/. */
  inspector: "inspector" | string;
  /** Measured overrides of DEFAULT_LIMITS (leanThreads, memoryBytes). */
  limits?: Partial<Pick<ValidationLimits, "leanThreads" | "memoryBytes">>;
  /** Lever, unused so far: after this date new drafts are refused here. */
  closedAt?: string;
}

/** The environment the archive recommends this year. Exactly one at a time;
 * moved once a year by the epoch-bump runbook, never by an admission. */
export const EPOCH = "v4.30.0";

/** An environment id is a Lean version string and nothing else. Enforced on
 * the injected test entries too, so no id can ever carry a path separator. */
const ID_PATTERN = /^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u;

/**
 * The admitted environments, oldest first. `v4.30.0` is the floor: the
 * package-overrides and artifact-cache behaviour the warm store relies on did
 * not exist in earlier Lake versions, so nothing older will be admitted.
 */
const TABLE: readonly ArchiveEnvironment[] = [
  {
    id: "v4.30.0",
    leanToolchain: "leanprover/lean4:v4.30.0",
    mathlibCommit: "c5ea00351c28e24afc9f0f84379aa41082b1188f",
    // the go-live pin (history/go-live.md), not an admission run
    admittedAt: "2026-08-06",
    inspector: "inspector",
  },
  {
    id: "v4.33.0",
    leanToolchain: "leanprover/lean4:v4.33.0",
    mathlibCommit: "db584cd6d46c92f209a44c0f1c829460d327499d",
    admittedAt: "2026-09-04",
    inspector: "inspector",
    limits: { memoryBytes: 1235636224 },
  },
];

/**
 * Every admitted environment. Read at call time so the mathlib test seam can
 * be set after this module is imported: LAX_MATHLIB_REV substitutes the fake
 * mathlib's commit for the real one, and LAX_TEST_ENVIRONMENTS appends whole
 * fake entries that share the installed toolchain.
 */
export function environments(): readonly ArchiveEnvironment[] {
  const rev = process.env.LAX_MATHLIB_REV;
  const table =
    rev === undefined || rev === ""
      ? TABLE
      : TABLE.map((entry) => ({ ...entry, mathlibCommit: rev }));
  return [...table, ...testEnvironments(table)];
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
  return entry;
}

/** The admitted ids for an author-facing message, with the epoch marked. */
export function admittedEnvironmentList(): string {
  return environments()
    .map((entry) => (entry.id === EPOCH ? `${entry.id} (epoch)` : entry.id))
    .join(", ");
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
 * `{ id, mathlibCommit?, leanToolchain? }`. Each shares the installed
 * toolchain and the active mathlib commit unless it says otherwise, so a test
 * can prove the multi-environment paths without a second Lean install. Ids
 * are held to the same pattern as the real ones and duplicates are ignored.
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
    extra.push({
      id,
      leanToolchain:
        typeof entry.leanToolchain === "string" ? entry.leanToolchain : installed.leanToolchain,
      mathlibCommit:
        typeof entry.mathlibCommit === "string" ? entry.mathlibCommit : installed.mathlibCommit,
      admittedAt: typeof entry.admittedAt === "string" ? entry.admittedAt : installed.admittedAt,
      inspector: "inspector",
    });
  }
  return extra;
}
