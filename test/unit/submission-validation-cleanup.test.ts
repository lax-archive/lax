import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeValidationWorkspace } from "../../src/submission-validation/workspace-cleanup.js";
import {
  cleanupTemporary,
  temporary,
  writeFile,
} from "../support/submission-validation.js";

afterEach(cleanupTemporary);

describe("validation workspace cleanup", () => {
  it("removes read-only dependency captures", () => {
    const workspace = temporary("lax-cleanup-");
    writeFile(workspace, "dependencies/lax-13/concepts/package/Lax13/Ram.lean", "axiom ram : True\n");
    makeReadOnly(workspace);

    removeValidationWorkspace(workspace);

    expect(fs.existsSync(workspace)).toBe(false);
  });
});

function makeReadOnly(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) makeReadOnly(filename);
    else fs.chmodSync(filename, 0o444);
  }
  fs.chmodSync(directory, 0o555);
}
