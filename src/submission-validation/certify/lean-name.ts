// Emitting a Lean name into generated source. Every name the certificate
// generator writes — statement constants, proof constants, package root
// modules, the `Cert.…` theorem names — goes through `leanName`, which splits
// a canonical dotted name into its components and brackets with `«»` every
// component Lean would not read back as the same plain identifier: a reserved
// word, or a component whose characters fall outside Lean's identifier
// grammar (the archive admits any `\p{L}` in a canonical name, Lean's
// `isIdFirst`/`isIdRest` admit far less). The rules below transcribe
// `Lean.isLetterLike`, `isSubScriptAlnum`, `isIdFirst` and `isIdRest` of the
// pinned toolchain; a bracketed component is always legal, so a conservative
// escaper can only ever bracket too much, never too little.

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

/** Whether Lean reads `component` back as this very identifier, unbracketed. */
export function isPlainIdentifier(component: string): boolean {
  if (component === "" || RESERVED.has(component)) return false;
  const codes = [...component].map((character) => character.codePointAt(0)!);
  if (!isIdFirst(codes[0]!)) return false;
  return codes.slice(1).every(isIdRest);
}

/**
 * A dotted canonical name as Lean source: each component plain where Lean
 * admits it, `«…»` otherwise. The input is the archive's canonical form
 * (contracts.ts LEAN_NAME_PATTERN: non-empty dot-separated components, no
 * brackets), so a component never contains a dot or a guillemet; anything
 * else is a programming error and is refused rather than emitted.
 */
export function leanName(canonical: string): string {
  if (canonical === "") throw new Error("cannot emit an empty Lean name");
  return canonical
    .split(".")
    .map((component) => {
      if (component === "" || /[«»\s]/u.test(component))
        throw new Error(`cannot emit the Lean name component ${JSON.stringify(component)}`);
      return isPlainIdentifier(component) ? component : `«${component}»`;
    })
    .join(".");
}
