import { describe, expect, it } from "vitest";
import { FindingCollector } from "../../src/submission-validation/findings.js";
import { isValidBibtex } from "../../src/submission-validation/validators/bibtex.js";
import { validateManifest } from "../../src/submission-validation/validators/manifest.js";
import { manifest, RUNTIME } from "../support/submission-validation.js";

// Every entry below was run through bibtex 0.99d and biber 2.19 while this
// suite was written: the accepted ones parse without a diagnostic, and the
// rejected ones make both readers report an error and skip the entry. The
// validator gates structure, so on that question it stays on the readers'
// side of the line — an entry a reader would take must not be refused here,
// because the author has no way to argue with the refusal.
const accepted = [
  // A value is delimited by braces or by double quotes, so inside a braced
  // value a quote is an ordinary character: an inch mark needs no escape and
  // there is nothing for a second one to pair with.
  '@misc{nail, title = {A 5" nail}, year = 2020}',
  '@misc{plate, title = {A 5" by 3" plate}, year = 2020}',
  '@misc{said, note = {He said "hi}, year = 2020}',
  // Braces are how a quoted value hides a quote, so the braced run in the
  // middle here is text and the value ends at the last quote, not the third.
  '@misc{deep, note = "a {5" nail} thing", year = 2020}',
  '@misc{quoted, title = "Quoted value", year = 2020}',
  '@misc{braced, title = "a {quoted} value", year = 2020}',
  '@misc{brace, title = {The {"}quoted{"} word}, year = 2020}',
  '@article{nested, title = {A {Nested} {{Deeply}} Title}, year = 2026}',
  "@misc{escaped, title = {Set \\{1,2\\}}, year = 2020}",
  "@article{trailing,\n  title = {Trailing comma},\n  year = 2026,\n}",
  "@misc(paren, title = {Paren delimited}, year = 2020)",
  '@string{journal = "Journal of Tests"}',
  '@misc{concatenated, title = journal # " Supplement", year = 2020}',
  '@preamble{"\\newcommand{\\noop}[1]{}"}',
  // No reader parses a comment body as fields, so nothing in it delimits
  // anything: an apostrophe, an inch mark, a brace the two readers place
  // differently, an `@`, and a whole entry all leave both of them content.
  '@comment{Jan\'s 5" note}',
  '@comment{Use "}" to close a group}',
  '@comment{"}"}',
  '@comment{a "b} c"}',
  "@comment{unbalanced } brace}",
  "@comment{mail ann@example.org today}",
  "@comment{@misc{k, title = {T}, year = 2020}}",
  '@comment{Use "}" here}\n@misc{k, title = {T}, year = 2020}',
  "@comment{a} @comment{b} @misc{k, title = {T}, year = 2020}",
  "% a stray line comment\n@misc{first, title = {One}, year = 2020}\n@misc{second, title = {Two}, year = 2021}\n",
];

const rejected = [
  '@misc{unterminated, title = "never closed, year = 2020}',
  "@misc{unclosed, title = {never closed, year = 2020}",
  // A quoted value counts braces too, so this one drops below its own depth,
  // which is the "Unbalanced braces" error bibtex reports.
  '@misc{unbalanced, note = "a}b", year = 2020}',
  "@article{key, title}",
  "@misc{key, {title} = {A Title}, year = 2020}",
  '@string{journal = "Journal", other = "Other"}',
];

// The readers are unbothered by these: bibtex skips whatever lies outside an
// entry and reads a field-less entry as an empty one. A bibEntries string is
// a bibliography rather than a document, so prose the reader would silently
// drop, and an entry carrying nothing to cite, are worth a finding instead.
const refusedThoughReadersSkipThem = [
  "not BibTeX",
  "",
  "@article{keyless}",
  "@misc{key, title = {A Title}, year = 2020} trailing text",
];

describe("BibTeX entry validation", () => {
  it("accepts the entry shapes bibtex and biber accept", () => {
    expect(accepted.filter((entry) => !isValidBibtex(entry))).toEqual([]);
  });

  it("rejects the entry shapes bibtex and biber refuse", () => {
    expect(rejected.filter((entry) => isValidBibtex(entry))).toEqual([]);
  });

  it("refuses a string that is not entries all the way through", () => {
    expect(refusedThoughReadersSkipThem.filter((entry) => isValidBibtex(entry))).toEqual([]);
  });

  it("counts a quote inside a braced value as text at every depth", () => {
    // The quote is the same character at every one of these depths; only the
    // brace nesting around it changes, and none of it may end the entry.
    for (const depth of [0, 1, 2, 3]) {
      const braced = "{".repeat(depth) + '5" nail' + "}".repeat(depth);
      expect([depth, isValidBibtex(`@misc{key, title = {${braced}}, year = 2020}`)]).toEqual([
        depth,
        true,
      ]);
    }
  });

  it("still refuses a quoted value that the entry never closes", () => {
    // Accepting an odd quote inside braces must not cost the reader its grip
    // on an actual quoted value: the fields after an unclosed one are text
    // inside it, so the entry has no structure left to check.
    expect(isValidBibtex('@misc{key, title = "open, year = 2020}')).toBe(false);
    expect(isValidBibtex('@misc{key, title = "open}')).toBe(false);
    expect(isValidBibtex('@misc{key, title = "open')).toBe(false);
    expect(isValidBibtex('@misc{key, title = "a {b" c, year = 2020}')).toBe(false);
    expect(isValidBibtex('@preamble{"open}')).toBe(false);
    expect(isValidBibtex('@string{journal = "open}')).toBe(false);
  });

  it("keeps checking the entries a comment is followed by", () => {
    // Comment text runs to the next `@`, which is the price of not knowing
    // where the body ends — but the entry that `@` opens is still an entry,
    // and biber reports every one of these.
    expect(isValidBibtex('@comment{Use "}" here}\n@misc{broken')).toBe(false);
    expect(isValidBibtex("@comment{ok} @misc{k, title = {T} year = 2020}")).toBe(false);
    expect(isValidBibtex("@comment{ok} @misc{k, title = {T}, year = 2020")).toBe(false);
    // A comment whose group is never closed is the author losing a brace, not
    // a reading the readers share: biber stops at the end of the input.
    expect(isValidBibtex("@comment{unclosed")).toBe(false);
  });

  it("takes an inch mark through the manifest that carries bibliography entries", () => {
    const entry = '@misc{nail, title = {A 5" nail}, author = {Ann O\'Neill}, year = {2020}}';
    const findings = new FindingCollector("static");
    const parsed = validateManifest(
      manifest("lax-261").replace("bibEntries: []", `bibEntries:\n  - ${JSON.stringify(entry)}`),
      "lax-261",
      RUNTIME,
      findings,
    );
    expect(findings.violations).toEqual([]);
    expect(parsed?.bibEntries).toEqual([entry]);
  });

  it("reports the unfinishable bibliography entry against the manifest", () => {
    const findings = new FindingCollector("static");
    validateManifest(
      manifest("lax-261").replace(
        "bibEntries: []",
        `bibEntries:\n  - ${JSON.stringify('@misc{key, title = "open, year = 2020}')}`,
      ),
      "lax-261",
      RUNTIME,
      findings,
    );
    expect(findings.violations.map((finding) => finding.message)).toEqual([
      "manifest.yaml: bibEntries[0] must contain one or more complete BibTeX entries",
    ]);
  });
});
