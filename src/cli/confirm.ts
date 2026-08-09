import readline from "node:readline/promises";
import * as ui from "./ui.js";

/**
 * Require an explicit acknowledgement before an irreversible command.
 *
 * The warning is not repeated here: the caller has already spent a paragraph
 * saying what is about to happen, and asking a second time in different words
 * only teaches the author to skim. All this asks for is the id.
 */
export async function confirmTyped(options: {
  expected: string;
  /** What is being confirmed, for the non-interactive refusal: `deleting lax-50`. */
  action: string;
}): Promise<boolean> {
  if (!process.stdin.isTTY) {
    ui.failure(
      `${options.action} needs a confirmation, and there is no terminal to ask on.\n` +
        "Rerun with --yes if you mean it.",
    );
    return false;
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `${ui.INDENT}Type ${ui.bold(options.expected)} to confirm ${ui.dim("›")} `,
    );
    if (answer.trim() === options.expected) return true;
  } finally {
    prompt.close();
  }
  ui.failure(`That is not ${options.expected} — nothing happened.`);
  return false;
}
