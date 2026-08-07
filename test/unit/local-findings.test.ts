import { describe, expect, it } from "vitest";
import { formatFindings } from "../../src/cli/findings.js";

describe("local validation reporting", () => {
  it("aggregates findings once and groups them by phase and severity", () => {
    const duplicate = { phase: "static" as const, rule: "manifest", message: "title is missing" };
    expect(
      formatFindings(
        [{ phase: "dialect", rule: "gate", message: "local gate unavailable" }],
        [
          duplicate,
          duplicate,
          { phase: "static", rule: "license", message: "LICENSE is missing" },
          { phase: "resolution", rule: "dependency", message: "Lax2 is unavailable" },
        ],
      ),
    ).toBe(
      [
        "lax build: found 3 errors and 1 warning during local validation",
        "  errors:",
        "    static:",
        "      - [manifest] title is missing",
        "      - [license] LICENSE is missing",
        "    resolution:",
        "      - [dependency] Lax2 is unavailable",
        "  warnings:",
        "    dialect:",
        "      - [gate] local gate unavailable",
      ].join("\n"),
    );
  });

  it("returns no output when validation has no findings", () => {
    expect(formatFindings([], [])).toBeUndefined();
  });
});
