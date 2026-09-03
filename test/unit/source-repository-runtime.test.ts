import { describe, expect, it } from "vitest";
import { validateSourceRepositoryUrl } from "../../src/submission-validation/runtime/source-repository.mjs";
import { validateRepositoryUrl } from "../../src/shared/validation.js";

const accepted = [
  "https://github.com/alice/repository",
  "https://gitlab.com/alice/repository",
  "https://gitlab.com/group/subgroup/repository",
  "https://codeberg.org/alice/repository",
  "https://bitbucket.org/workspace/repository",
];

const rejected = [
  "http://github.com/alice/repository",
  "https://example.com/alice/repository",
  "https://constructor/alice/repository",
  "https://user@github.com/alice/repository",
  "https://github.com/alice/repository.git",
  "https://github.com/alice/repository/extra",
  "https://gitlab.com/group/repository/-/tree/main",
  "https://codeberg.org/alice/repository?q=1",
  "https://bitbucket.org:443/workspace/repository",
];

describe("validation-runtime source repository policy", () => {
  it("stays in conformance with the shared control-plane policy", () => {
    for (const repository of accepted) {
      expect(validateRepositoryUrl(repository)).toBe(repository);
      expect(validateSourceRepositoryUrl(repository)).toBe(repository);
    }
    for (const repository of rejected) {
      expect(() => validateRepositoryUrl(repository)).toThrow();
      expect(() => validateSourceRepositoryUrl(repository)).toThrow();
    }
  });
});
