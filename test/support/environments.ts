// Injecting an archive environment into a test run. The table is compiled in
// and only grows (src/submission-validation/environments.ts); LAX_TEST_ENVIRONMENTS
// is its test seam, read at call time, so a test can add an environment for the
// length of one block. Entries borrow the installed toolchain unless they name
// another, which is what makes a second environment testable on a machine with
// one Lean install.

import { SPEC2_TOOLCHAIN } from "../paths.js";

export interface TestEnvironmentInput {
  id: string;
  mathlibCommit?: string;
  leanToolchain?: string;
  /** 1 (the default) or 2; see environments.ts testEnvironments. */
  specVersion?: 1 | 2;
  /** A spec-2 entry's libraries beyond mathlib (LaxCore required, cslib
   * allowed unless `required` says otherwise), at a full commit each. */
  libraries?: { name: "LaxCore" | "cslib"; commit: string; required?: boolean }[];
}

/**
 * The spec-2 fake environment of the fast suite: the next Lean minor under
 * the rehearsal toolchain, pinning the fake mathlib (through
 * LAX_MATHLIB_REV, like every injected entry) and the fixture LaxCore at
 * the commit setup-env.ts put in LAX_LAXCORE_REV. Inject it with
 * `withTestEnvironmentsAsync([spec2TestEnvironment()], …)`; the e2e that
 * does so skips itself when the toolchain is not installed (ci.yml installs
 * it). The id is what `v4.35.0` will be once admitted; the two never
 * coexist, because injection ignores an id the table has.
 */
export function spec2TestEnvironment(): TestEnvironmentInput {
  const laxCore = process.env.LAX_LAXCORE_REV;
  if (laxCore === undefined || laxCore === "")
    throw new Error("the spec-2 test environment needs LAX_LAXCORE_REV (set by test/setup-env.ts)");
  return {
    id: "v4.35.0",
    leanToolchain: SPEC2_TOOLCHAIN,
    specVersion: 2,
    libraries: [{ name: "LaxCore", commit: laxCore }],
  };
}

/**
 * The ids `LAX_TEST_ENVIRONMENTS` currently injects, in order, or an empty
 * list. The drivers that provision exactly *one* environment — the container
 * smoke, whose warm mathlib workspace is 7.5 GB — read it to follow an
 * admission run's candidate instead of the epoch; the drivers that check every
 * installed environment (the golden test, the proof-tree smoke) never need it.
 */
export function injectedEnvironmentIds(): string[] {
  const raw = process.env.LAX_TEST_ENVIRONMENTS;
  if (raw === undefined || raw === "") return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LAX_TEST_ENVIRONMENTS must be a JSON list");
  return parsed.map((entry) => {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") throw new Error("a LAX_TEST_ENVIRONMENTS entry has no id");
    return id;
  });
}

/** Run `body` with these extra environments admitted, then restore the seam. */
export function withTestEnvironments<T>(entries: TestEnvironmentInput[], body: () => T): T {
  const previous = process.env.LAX_TEST_ENVIRONMENTS;
  process.env.LAX_TEST_ENVIRONMENTS = JSON.stringify(entries);
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.LAX_TEST_ENVIRONMENTS;
    else process.env.LAX_TEST_ENVIRONMENTS = previous;
  }
}

/** The async form: the seam is restored when the promise settles. */
export async function withTestEnvironmentsAsync<T>(
  entries: TestEnvironmentInput[],
  body: () => Promise<T>,
): Promise<T> {
  const previous = process.env.LAX_TEST_ENVIRONMENTS;
  process.env.LAX_TEST_ENVIRONMENTS = JSON.stringify(entries);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.LAX_TEST_ENVIRONMENTS;
    else process.env.LAX_TEST_ENVIRONMENTS = previous;
  }
}

/**
 * Run `body` against the compiled table alone. The admission workflow sets
 * LAX_TEST_ENVIRONMENTS for its whole test run, so a test that asserts the
 * table's *own* shape has to clear the seam first rather than assume it.
 */
export function withoutTestEnvironments<T>(body: () => T): T {
  const previous = process.env.LAX_TEST_ENVIRONMENTS;
  delete process.env.LAX_TEST_ENVIRONMENTS;
  try {
    return body();
  } finally {
    if (previous !== undefined) process.env.LAX_TEST_ENVIRONMENTS = previous;
  }
}

/** The async form of `withoutTestEnvironments`. */
export async function withoutTestEnvironmentsAsync<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.LAX_TEST_ENVIRONMENTS;
  delete process.env.LAX_TEST_ENVIRONMENTS;
  try {
    return await body();
  } finally {
    if (previous !== undefined) process.env.LAX_TEST_ENVIRONMENTS = previous;
  }
}
