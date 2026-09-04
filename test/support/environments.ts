// Injecting an archive environment into a test run. The table is compiled in
// and only grows (src/submission-validation/environments.ts); LAX_TEST_ENVIRONMENTS
// is its test seam, read at call time, so a test can add an environment for the
// length of one block. Entries borrow the installed toolchain unless they name
// another, which is what makes a second environment testable on a machine with
// one Lean install.

export interface TestEnvironmentInput {
  id: string;
  mathlibCommit?: string;
  leanToolchain?: string;
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
