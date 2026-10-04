// Emitting a Lean name into generated source. Every name the certificate
// generator writes — statement constants, proof constants, universe
// parameters, package root modules, the `Cert.…` theorem names, and the
// names handed to `leanexport` and `lake comparator`, which read Lean's name
// syntax too — goes through `leanName`.
//
// One name representation (ultracode review 2026-10-04, C3): the inspector
// writes every name with Lean's own escaped `Name.toString`, which reads
// back through `String.toName` (the function `lake comparator` parses
// `theorem_names` with); the classifier admits as an endpoint only an archive
// name — Lean printed it with no `«»` (contracts.ts LEAN_NAME_PATTERN) — and
// the schema holds every recorded name to the same grammar. So a recorded
// name is already Lean source, component by component. The one thing
// `Name.toString` leaves to its caller is the token table: it prints a
// keyword component bare (`Lax1.C.fun`), which Lean reads back inside a
// dotted identifier but not alone (a universe parameter `fun`). No fixed
// list holds every keyword — any imported `syntax` declares more (`forall`,
// `return`, Mathlib's `lemma`) — so a name that stands alone, a universe
// parameter, is always written quoted (`leanLevel`: `«u»` reads as `u`),
// and `RESERVED` only keeps a dotted name's familiar keyword components
// quoted for the reader. Nothing else is ever escaped or unescaped.

import { LEAN_NAME_PATTERN } from "../contracts.js";

/** Familiar Lean keywords, quoted inside a dotted name for the reader (Lean
 * would read them bare there). Not every keyword: a name standing alone
 * goes through `leanLevel`, which quotes whatever it is. */
const RESERVED = new Set([
  "abbrev", "at", "attribute", "axiom", "by", "calc", "class", "deriving", "do", "else", "end",
  "example", "export", "extends", "fun", "from", "have", "if", "import", "in", "inductive",
  "infix", "infixl", "infixr", "instance", "let", "local", "macro", "match", "mutual",
  "namespace", "noncomputable", "notation", "opaque", "open", "partial", "postfix", "prefix",
  "private", "protected", "scoped", "section", "set_option", "show", "structure", "syntax",
  "termination_by", "then", "theorem", "universe", "unsafe", "variable", "where", "with",
  "def", "sorry", "Prop", "Type", "Sort",
]);

/**
 * A name the generator cannot write: one outside the archive's name grammar.
 * The classifier and the schema refuse every such name before a record
 * reaches the generator, so this fires only on a record that bypassed them;
 * the phases turn it into a `certify` violation that names it, and nothing
 * else in lax throws it.
 */
export class LeanNameError extends Error {
  constructor(readonly leanName: string) {
    super(
      `cannot write the Lean name ${JSON.stringify(leanName)} into the certificate: it is not a plain ` +
        "dot-separated Lean identifier",
    );
    this.name = "LeanNameError";
  }
}

/**
 * An archive name as Lean source: as recorded, with a keyword component
 * quoted. Refuses (LeanNameError) a name outside the archive's grammar
 * rather than emitting it.
 */
export function leanName(name: string): string {
  if (!LEAN_NAME_PATTERN.test(name)) throw new LeanNameError(name);
  return name
    .split(".")
    .map((component) => (RESERVED.has(component) ? `«${component}»` : component))
    .join(".");
}

/**
 * A universe parameter as Lean source: always quoted. A level name stands
 * alone (`.{u}`, `universe u`), where Lean reads any keyword of the
 * Challenge's imports as that keyword, and the token table is open — so it
 * is written `«u»`, which Lean reads as `u` whatever the imports declare.
 */
export function leanLevel(name: string): string {
  if (!LEAN_NAME_PATTERN.test(name) || name.includes(".")) throw new LeanNameError(name);
  return `«${name}»`;
}
