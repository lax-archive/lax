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
