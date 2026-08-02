import readline from "node:readline/promises";

/** Require an explicit acknowledgement before an irreversible issue command. */
export async function confirmTyped(options: {
  expected: string;
  warning: string;
  command: string;
}): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      `${options.command}: ${options.warning} — rerun with --yes to confirm non-interactively`,
    );
    return false;
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `${options.warning}. type ${options.expected} to confirm: `,
    );
    if (answer.trim() === options.expected) return true;
  } finally {
    prompt.close();
  }
  console.error(
    `${options.command}: confirmation did not match ${options.expected} — nothing happened`,
  );
  return false;
}
