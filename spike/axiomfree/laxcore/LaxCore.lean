/-
Scratch `LaxCore` for stage 0 of the axiom-free program: the `lax_statement`
tag attribute with its validation hook. Imports only `Lean`, so one commit
serves every environment. The hook runs at the author's elaboration; the
archive validator re-judges every rule from the inspector's facts and never
trusts it.
-/
import Lean

open Lean

namespace LaxCore

def kindName : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .defnInfo _ => "def"
  | .thmInfo _ => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "constructor"
  | .recInfo _ => "recursor"

/-- A statement is a definition-kind declaration whose stored type, metadata
stripped, is literally `Sort 0`, with no binders, and not `private`. -/
def validateStatement (decl : Name) : AttrM Unit := do
  if isPrivateName decl then
    throwError "@[lax_statement]: `{decl}` is private; a statement must be visible to the packages that depend on it"
  let info ← getConstInfo decl
  let .defnInfo d := info
    | throwError "@[lax_statement]: `{decl}` is a {kindName info}; a statement must be a `def` of type `Prop`"
  match d.type.consumeMData with
  | .sort .zero => pure ()
  | .forallE .. =>
    throwError "@[lax_statement]: `{decl}` has binders; a statement takes no parameters (quantify inside with `∀`)"
  | t =>
    throwError "@[lax_statement]: `{decl}` has type `{t}`; a statement must have type `Prop`"

initialize laxStatementAttr : TagAttribute ←
  registerTagAttribute `lax_statement
    "marks a Lax statement: a `def` of type `Prop` that proofs assume as a hypothesis or conclude"
    (validate := validateStatement)

/-- Spike-only: the same tag without the hook, to see what the olean exporter
does with a `private` tagged definition. Never part of the real LaxCore. -/
initialize laxStatementUncheckedAttr : TagAttribute ←
  registerTagAttribute `lax_statement_unchecked "spike-only: lax_statement without validation"

end LaxCore
