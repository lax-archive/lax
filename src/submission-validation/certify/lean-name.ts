// Emitting a Lean name into generated source. Every name the certificate
// generator writes — statement constants, proof constants, package root
// modules, the `Cert.…` theorem names, and the names handed to `leanexport`
// and `lake comparator`, which read Lean's name syntax too — goes through
// `leanName`, which splits a canonical dotted name into its components and
// brackets with `«»` every component Lean would not read back as the same
// plain identifier: a reserved word, or a component whose characters fall
// outside Lean's identifier grammar (the archive admits any `\p{L}` in a
// canonical name, Lean's `isIdFirst`/`isIdRest` admit far less). The rules
// below transcribe `Lean.isLetterLike`, `isSubScriptAlnum`, `isIdFirst` and
// `isIdRest` of the pinned toolchain; a bracketed component is always legal,
// so a conservative escaper can only ever bracket too much, never too little.
//
// One name representation (codex review 2026-10-03, finding 4): the inspector
// writes a spec-2 report's names in the canonical form — dot-separated,
// nothing escaped (`Name.toString (escape := false)`, lean/inspector/Main.lean)
// — the validator compares them as such, and this module is the one place
// they are quoted again. Nothing between the two ever escapes or unescapes.

/** Lean's own reserved words and the command/term keywords a bare component
 * must never collide with. A superset is harmless (`«fun»` reads as `fun`). */
const RESERVED = new Set([
  "abbrev", "at", "attribute", "axiom", "by", "calc", "class", "deriving", "do", "else", "end",
  "example", "export", "extends", "fun", "from", "have", "if", "import", "in", "inductive",
  "infix", "infixl", "infixr", "instance", "let", "local", "macro", "match", "mutual",
  "namespace", "noncomputable", "notation", "opaque", "open", "partial", "postfix", "prefix",
  "private", "protected", "scoped", "section", "set_option", "show", "structure", "syntax",
  "termination_by", "then", "theorem", "universe", "unsafe", "variable", "where", "with",
  "def", "λ", "Π", "Σ", "sorry", "Prop", "Type", "Sort",
]);

function isLetterLike(code: number): boolean {
  return (
    (code >= 0x3b1 && code <= 0x3c9 && code !== 0x3bb) || // lower Greek, but λ
    (code >= 0x391 && code <= 0x3a9 && code !== 0x3a0 && code !== 0x3a3) || // upper Greek, but Π and Σ
    (code >= 0x3ca && code <= 0x3fb) || // Coptic
    (code >= 0x1f00 && code <= 0x1ffe) || // polytonic Greek
    (code >= 0x2100 && code <= 0x214f) || // letterlike block
    (code >= 0x1d49c && code <= 0x1d59f) // script, double-struck, fraktur Latin
  );
}

function isSubScriptAlnum(code: number): boolean {
  return (
    (code >= 0x2080 && code <= 0x2089) ||
    (code >= 0x2090 && code <= 0x209c) ||
    (code >= 0x1d62 && code <= 0x1d6a)
  );
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isIdFirst(code: number): boolean {
  return isAsciiAlpha(code) || code === 0x5f || isLetterLike(code);
}

function isIdRest(code: number): boolean {
  return (
    isAsciiAlpha(code) ||
    isAsciiDigit(code) ||
    code === 0x5f || // _
    code === 0x27 || // '
    code === 0x21 || // !
    code === 0x3f || // ?
    isLetterLike(code) ||
    isSubScriptAlnum(code)
  );
}

/** Whether Lean reads `component` back as this very identifier, unbracketed.
 * `_` alone is a hole, never an identifier. */
export function isPlainIdentifier(component: string): boolean {
  if (component === "" || component === "_" || RESERVED.has(component)) return false;
  const codes = [...component].map((character) => character.codePointAt(0)!);
  if (!isIdFirst(codes[0]!)) return false;
  return codes.slice(1).every(isIdRest);
}

/**
 * A name component the generator cannot write at all. Lean's `«…»` quotes
 * any component but these: the empty one; `_`, which Lean's own printer
 * leaves bare and the parser reads as a hole; one carrying a guillemet (the
 * quote's own delimiters); and one carrying whitespace or a control
 * character (a newline would end the line). The phases turn this into a
 * `certify` violation that names the component; nothing else in lax throws
 * it.
 */
export class LeanNameError extends Error {
  constructor(
    readonly component: string,
    readonly canonical: string,
  ) {
    super(
      `cannot write the Lean name ${JSON.stringify(canonical)} into the certificate: its component ` +
        `${JSON.stringify(component)} cannot be quoted with «»`,
    );
    this.name = "LeanNameError";
  }
}

/** Whether `«component»` is a legal, unambiguous Lean identifier. */
export function isQuotable(component: string): boolean {
  return component !== "" && component !== "_" && !/[«»\s\p{Cc}]/u.test(component);
}

/**
 * A dotted canonical name as Lean source: each component plain where Lean
 * reads it back as that very identifier, `«…»` otherwise — the escaper
 * quotes conservatively, since a quoted plain identifier is the same name.
 * The input is the archive's canonical form (contracts.ts LEAN_NAME_PATTERN:
 * non-empty dot-separated components, the inspector's own unescaped
 * serialization), so a component never contains a dot; a component the
 * quotes cannot carry is refused (LeanNameError) rather than emitted.
 */
export function leanName(canonical: string): string {
  if (canonical === "") throw new LeanNameError("", canonical);
  return canonical
    .split(".")
    .map((component) => {
      if (!isQuotable(component)) throw new LeanNameError(component, canonical);
      return isPlainIdentifier(component) ? component : `«${component}»`;
    })
    .join(".");
}
