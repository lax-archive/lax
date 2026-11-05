import { describe, expect, it } from "vitest";
import { parseCommand, parseRoutedCommand } from "../../src/shared/commands.js";
import { MAX_THREAD_CAP, validateSource } from "../../src/shared/validation.js";
import { DEFAULT_LIMITS, limitsFor } from "../../src/submission-validation/config.js";
import { validationRequestFromUnknown } from "../../src/submission-validation/contracts.js";
import { epoch } from "../../src/submission-validation/environments.js";

const source = {
  repository: "https://github.com/example/work",
  commit: "a".repeat(40),
  folder: ".",
};
const submit = (argument: object): ReturnType<typeof parseCommand> =>
  parseCommand(`/lax submit ${JSON.stringify(argument)}`);
const request = {
  requestVersion: 1,
  id: "lax-123456",
  source,
  archiveSha: "b".repeat(40),
};

describe("submit thread caps", () => {
  it("leaves a plain submit exactly as it was", () => {
    expect(submit(source)).toEqual({ action: "submit", ...source });
  });

  it("accepts each cap on its own", () => {
    expect(submit({ ...source, maxReplayThreads: 1 })).toEqual({
      action: "submit",
      ...source,
      maxReplayThreads: 1,
    });
    expect(submit({ ...source, maxCompileThreads: 2 })).toEqual({
      action: "submit",
      ...source,
      maxCompileThreads: 2,
    });
  });

  it.each([0, -1, 1.5, MAX_THREAD_CAP + 1, "1", null, true])("refuses %j", (cap) => {
    expect(() => submit({ ...source, maxReplayThreads: cap })).toThrow(/maxReplayThreads must be an integer/u);
    expect(() => submit({ ...source, maxCompileThreads: cap })).toThrow(/maxCompileThreads must be an integer/u);
  });

  it("survives the routed form real comments use", () => {
    const body = `/lax submit lax-123456 ${JSON.stringify({ ...source, maxReplayThreads: 1 })}`;
    expect(parseRoutedCommand(body, "lax-999999").command).toEqual({
      action: "submit",
      ...source,
      maxReplayThreads: 1,
    });
  });

  it("still refuses any other key", () => {
    expect(() => submit({ ...source, maxThreads: 1 })).toThrow();
  });

  it("keeps caps out of a recorded source", () => {
    expect(() => validateSource({ ...source, maxReplayThreads: 1 })).toThrow();
  });

  it("round-trips through the validation request", () => {
    const capped = { ...request, maxCompileThreads: 3, maxReplayThreads: 1 };
    expect(validationRequestFromUnknown(capped)).toEqual(capped);
    expect(validationRequestFromUnknown(request)).toEqual(request);
    expect(() => validationRequestFromUnknown({ ...request, maxReplayThreads: 0 })).toThrow();
  });
});

describe("limitsFor", () => {
  const environment = epoch();

  it("keeps the budgets without caps", () => {
    expect(limitsFor(environment)).toEqual({ ...DEFAULT_LIMITS, ...environment.limits });
    expect(limitsFor(environment, request as object)).toEqual(limitsFor(environment));
  });

  it("lowers each budget independently", () => {
    const limits = limitsFor(environment, { maxReplayThreads: 1 });
    expect(limits.leanThreads).toBe(1);
    expect(limits.compileLeanThreads).toBe(DEFAULT_LIMITS.compileLeanThreads);
    const compile = limitsFor(environment, { maxCompileThreads: 1 });
    expect(compile.compileLeanThreads).toBe(1);
    expect(compile.leanThreads).toBe(DEFAULT_LIMITS.leanThreads);
  });

  it("never raises a budget", () => {
    const limits = limitsFor(environment, { maxCompileThreads: MAX_THREAD_CAP, maxReplayThreads: MAX_THREAD_CAP });
    expect(limits.leanThreads).toBe(DEFAULT_LIMITS.leanThreads);
    expect(limits.compileLeanThreads).toBe(DEFAULT_LIMITS.compileLeanThreads);
  });

  it("names a maximum no budget exceeds", () => {
    expect(Math.max(DEFAULT_LIMITS.leanThreads, DEFAULT_LIMITS.compileLeanThreads)).toBeLessThanOrEqual(MAX_THREAD_CAP);
  });
});
