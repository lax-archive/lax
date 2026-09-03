import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PLACEHOLDER_SUBMISSION_ID } from "../shared/constants.js";
import { normalizeSubmissionId, validateNewSubmissionId } from "../shared/validation.js";

export function generateSubmissionId(
  draw: (minimum: number, maximum: number) => number = randomInt,
): string {
  return validateNewSubmissionId(`lax-${draw(100_000, 1_000_000)}`);
}

/** Catch identity drift before an issue is created and rekeying becomes expensive. */
export function validateScaffoldIdentity(root: string, idInput: string): void {
  const id = normalizeSubmissionId(idInput, { placeholder: true });
  if (id !== PLACEHOLDER_SUBMISSION_ID) validateNewSubmissionId(id);
  const digits = id.slice("lax-".length);
  const packageName = `Lax${digits}`;
  const expected = [
    path.join(root, "concepts", "lakefile.toml"),
    path.join(root, "proofs", "lakefile.toml"),
    path.join(root, "concepts", `${packageName}.lean`),
    path.join(root, "proofs", `${packageName}Proofs.lean`),
  ];
  for (const filename of expected) {
    if (!fs.existsSync(filename)) {
      throw new Error(
        `submission id ${id} does not match the generated package layout; missing ${filename}`,
      );
    }
  }
  const concepts = fs.readFileSync(expected[0]!, "utf8");
  const proofs = fs.readFileSync(expected[1]!, "utf8");
  if (!new RegExp(`^name = ["']${packageName}["']$`, "mu").test(concepts)) {
    throw new Error(`submission id ${id} does not match the concepts package name`);
  }
  if (
    !new RegExp(`^name = ["']${packageName}Proofs["']$`, "mu").test(proofs) ||
    !new RegExp(`^name = ["']${packageName}["']$`, "mu").test(proofs)
  ) {
    throw new Error(`submission id ${id} does not match the proofs package names`);
  }
}
