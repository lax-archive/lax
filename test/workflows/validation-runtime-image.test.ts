import fs from "node:fs";
import { describe, expect, it } from "vitest";

const containerfile = fs.readFileSync(
  new URL("../../src/submission-validation/runtime/Containerfile", import.meta.url),
  "utf8",
);
const workflow = fs.readFileSync(
  new URL("../../.github/workflows/validation-runtime.yml", import.meta.url),
  "utf8",
);
const checkRunner = fs.readFileSync(
  new URL("../../src/submission-validation/runtime/run-check.mjs", import.meta.url),
  "utf8",
);

describe("validation runtime image", () => {
  it("makes the root-built warm cache readable by the validation user", () => {
    expect(containerfile).toContain("chmod -R a+rX /opt/lax-runtime/warm");
  });

  it("pulls the pushed digest before exercising it", () => {
    const pull = workflow.indexOf("name: Ensure the built runtime is local");
    const smoke = workflow.indexOf("name: Exercise the validation pipeline against the built runtime");

    expect(pull).toBeGreaterThan(0);
    expect(pull).toBeLessThan(smoke);
    expect(workflow.slice(pull, smoke)).toContain('docker pull "$IMAGE"');
  });

  it("honors the bounded Lean worker count supplied by the host", () => {
    expect(checkRunner).toContain("const leanNumThreads = process.env.LEAN_NUM_THREADS");
    expect(checkRunner).toContain("LEAN_NUM_THREADS: leanNumThreads");
    expect(checkRunner).not.toContain('LEAN_NUM_THREADS: "4"');
  });
});
