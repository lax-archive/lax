import { describe, expect, it } from "vitest";
import {
  decodeUtf8,
  isPlaceholderSubmissionId,
  normalizeSubmissionId,
  normalizeTitle,
  submissionId,
  validateCommit,
  validateFolder,
  validateIdentity,
  validateRepositoryUrl,
  validateSource,
  validateSubmissionId,
} from "../../src/shared/validation.js";
import { packageNameForSubmission } from "../../src/submission-validation/contracts.js";

describe("shared input validation", () => {
  it("normalizes safe Unicode titles deterministically", () => {
    expect(normalizeTitle("  Cafe\u0301\u2002lemma  ")).toBe("Café lemma");
  });

  it("rejects multiline, bidi and zero-width title input", () => {
    expect(() => normalizeTitle("first\nsecond")).toThrow("one line");
    expect(() => normalizeTitle("safe\u202Eunsafe")).toThrow("control or formatting");
    expect(() => normalizeTitle("zero\u200Bwidth")).toThrow("control or formatting");
  });

  it("enforces title scalar and byte boundaries exactly", () => {
    expect(normalizeTitle("a".repeat(200))).toHaveLength(200);
    expect(() => normalizeTitle("a".repeat(201))).toThrow("200 Unicode");
    expect(normalizeTitle("😀".repeat(128))).toBe("😀".repeat(128));
    expect(() => normalizeTitle("😀".repeat(129))).toThrow("512 UTF-8 bytes");
  });

  it("checks both raw and normalized title representations", () => {
    const decomposedAtBoundary = "e\u0301".repeat(170);
    expect(Buffer.byteLength(decomposedAtBoundary, "utf8")).toBe(510);
    expect(normalizeTitle(decomposedAtBoundary)).toBe("é".repeat(170));
    expect(() => normalizeTitle("e\u0301".repeat(171))).toThrow("512 UTF-8 bytes");
    expect([...normalizeTitle("\u0344".repeat(100))]).toHaveLength(200);
    expect(() => normalizeTitle("\u0344".repeat(101))).toThrow("200 Unicode characters");
    expect(() => normalizeTitle(" \u2002 ")).toThrow("title must not be empty");
  });

  it("aggregates independent title failures", () => {
    expect(() => normalizeTitle(`${"a".repeat(513)}\n\u200B`)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("title exceeds 512 UTF-8 bytes"),
      }),
    );
    try {
      normalizeTitle(`${"a".repeat(513)}\n\u200B`);
    } catch (error) {
      expect((error as Error).message).toContain("title must be one line");
      expect((error as Error).message).toContain("control or formatting");
      expect((error as Error).message).toContain("200 Unicode");
    }
  });

  it("rejects unpaired surrogates and all line separators", () => {
    expect(() => normalizeTitle("bad\ud800title")).toThrow("unpaired surrogate");
    expect(() => normalizeTitle("one\rtwo")).toThrow("one line");
    expect(() => normalizeTitle("one\u2028two")).toThrow("one line");
    expect(() => normalizeTitle("one\u2029two")).toThrow("one line");
  });

  it("derives the only accepted id spelling from the issue number", () => {
    expect(submissionId(42)).toBe("lax-42");
    expect(packageNameForSubmission("lax-42")).toBe("Lax42");
    expect(() => submissionId(0)).toThrow("positive integer");
  });

  it("normalizes legacy source ids without relaxing canonical archive ids", () => {
    expect(normalizeSubmissionId("lax-42")).toBe("lax-42");
    expect(normalizeSubmissionId("Lax42")).toBe("lax-42");
    expect(() => normalizeSubmissionId("Lax-42")).toThrow("lax-<positive decimal>");
    expect(() => normalizeSubmissionId("lax-0")).toThrow("lax-<positive decimal>");
  });

  it("admits the offline placeholder only where a caller asks for it", () => {
    // `lax init --offline` scaffolds under lax-0. Refusing it stays the
    // default — every archive path keeps the two throws above — and opting in
    // buys exactly that one id, in the two spellings a manifest may use.
    expect(isPlaceholderSubmissionId("lax-0")).toBe(true);
    expect(isPlaceholderSubmissionId("Lax0")).toBe(true);
    expect(isPlaceholderSubmissionId("lax-42")).toBe(false);
    expect(() => validateSubmissionId("lax-0")).toThrow("lax-<positive decimal>");
    expect(validateSubmissionId("lax-0", { placeholder: true })).toBe("lax-0");
    expect(normalizeSubmissionId("lax-0", { placeholder: true })).toBe("lax-0");
    expect(normalizeSubmissionId("Lax0", { placeholder: true })).toBe("lax-0");
    expect(normalizeSubmissionId("Lax42", { placeholder: true })).toBe("lax-42");
    for (const near of ["lax-00", "lax-0x", "Lax00", "lax-", "lax-1_0"]) {
      expect(() => normalizeSubmissionId(near, { placeholder: true })).toThrow();
    }
    // the placeholder's package name is a plain name mapping, so it resolves
    expect(packageNameForSubmission("lax-0")).toBe("Lax0");
  });

  it("accepts canonical public repository URLs on the four supported hosts", () => {
    for (const repository of [
      "https://github.com/alice/repository",
      "https://gitlab.com/alice/repository",
      "https://gitlab.com/research/formalization/repository",
      "https://codeberg.org/alice/repository",
      "https://bitbucket.org/alice/repository",
    ]) expect(validateRepositoryUrl(repository)).toBe(repository);
    expect(() => validateRepositoryUrl("git@github.com:alice/repository.git")).toThrow();
    expect(() => validateRepositoryUrl("https://github.com/alice/repository.git")).toThrow();
    expect(() => validateRepositoryUrl("https://github.com/alice/repository?q=1")).toThrow();
    expect(() => validateRepositoryUrl("https://user@github.com/alice/repository")).toThrow();
    expect(() => validateRepositoryUrl("https://github.com:443/alice/repository")).toThrow();
    expect(() => validateRepositoryUrl("https://github.com/alice/repository#readme")).toThrow();
    expect(() => validateRepositoryUrl("https://github.com/alice%2Frepository/name")).toThrow();
    expect(() => validateRepositoryUrl("https://github.com/alice/repository/extra")).toThrow();
    expect(() => validateRepositoryUrl("https://example.com/alice/repository")).toThrow(
      "repository host must be one of",
    );
    expect(() => validateRepositoryUrl("https://constructor/alice/repository")).toThrow(
      "repository host must be one of",
    );
    expect(() => validateRepositoryUrl("https://gitlab.com/alice/repository/-/tree/main")).toThrow();
    expect(() => validateRepositoryUrl("https://GitLab.com/alice/repository")).toThrow(
      "canonical form",
    );
    for (const control of ["\n", "\r", "\t", "\u007f", "\u0085"]) {
      expect(() => validateRepositoryUrl(`https://github.com/alice/repository${control}`)).toThrow(
        "control character",
      );
    }
    const prefix = "https://github.com/a/";
    expect(validateRepositoryUrl(prefix + "r".repeat(2_048 - prefix.length))).toHaveLength(2_048);
    expect(() => validateRepositoryUrl(prefix + "r".repeat(2_049 - prefix.length))).toThrow("2,048");
  });

  it("rejects escaping or ambiguous folders", () => {
    expect(validateFolder(".")).toBe(".");
    expect(validateFolder("submissions/one")).toBe("submissions/one");
    expect(() => validateFolder("../secret")).toThrow();
    expect(() => validateFolder("one//two")).toThrow();
    expect(() => validateFolder("one\\two")).toThrow();
    expect(validateFolder("a".repeat(512))).toHaveLength(512);
    expect(() => validateFolder("a".repeat(513))).toThrow("512");
    expect(validateFolder(Array.from({ length: 32 }, () => "a").join("/"))).toBe(
      Array.from({ length: 32 }, () => "a").join("/"),
    );
    expect(() => validateFolder(Array.from({ length: 33 }, () => "a").join("/"))).toThrow("1-32");
    expect(() => validateFolder("/absolute")).toThrow("relative POSIX");
    expect(() => validateFolder("one/./two")).toThrow("without . or ..");
    expect(() => validateFolder("one/\u0001two")).toThrow("control");
  });

  it("enforces commit and GitHub identity boundaries", () => {
    expect(validateCommit("a".repeat(40))).toBe("a".repeat(40));
    for (const value of ["a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40)]) {
      expect(() => validateCommit(value)).toThrow("lowercase 40-character SHA");
    }
    expect(validateIdentity({ githubId: 1, handle: "a".repeat(39) })).toEqual({
      githubId: 1,
      handle: "a".repeat(39),
    });
    expect(validateIdentity({ githubId: 1, handle: "a" })).toEqual({ githubId: 1, handle: "a" });
    expect(() => validateIdentity({ githubId: 1, handle: "a".repeat(40) })).toThrow("invalid handle");
    expect(() => validateIdentity({ githubId: 1, handle: "alice-" })).toThrow("invalid handle");
    expect(() => validateIdentity({ githubId: 0, handle: `-${"a".repeat(39)}` })).toThrow(
      "numeric account id",
    );
    try {
      validateIdentity({ githubId: 0, handle: `-${"a".repeat(39)}` });
    } catch (error) {
      expect((error as Error).message).toContain("invalid handle");
    }
  });

  it("aggregates independent submit-source schema errors", () => {
    try {
      validateSource({ repository: "http://example.com/x", commit: "ABC", folder: "../x", extra: true });
      throw new Error("expected validation to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("must contain exactly");
      expect(message).toContain("canonical public HTTPS");
      expect(message).toContain("lowercase 40-character SHA");
      expect(message).toContain("without . or ..");
    }
  });

  it("uses fatal UTF-8 decoding", () => {
    expect(decodeUtf8(Uint8Array.from([0x66, 0x6f, 0x6f]))).toBe("foo");
    expect(() => decodeUtf8(Uint8Array.from([0xc3, 0x28]))).toThrow("not valid UTF-8");
    expect(() => decodeUtf8(Uint8Array.from([0xed, 0xa0, 0x80]))).toThrow("not valid UTF-8");
  });
});
