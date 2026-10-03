import Lean

/-!
# LaxCore

The one module every spec-2 Lax environment pins beside mathlib: the
`lax_statement` tag attribute that marks a definition as a *statement* of a
Lax concept package — an edge endpoint of the archive's proof network.

```lean
@[lax_statement] def InfinitelyManyPrimes : Prop := ∀ n, ∃ p, n < p ∧ p.Prime
```

A statement is a definition-kind declaration whose type is literally `Prop`
(the raw `Sort 0`, no reduction), with no binders — parameters go inside
with `∀` — and not `private`. The hook below rejects everything else at the
author's elaboration with a message naming the rule. The archive's validator
re-judges every rule from the inspector's facts and never trusts the hook:
this module is a convenience for the author and a marker for the reader,
not a gate. Universe parameters are allowed.

The attribute is a plain tag attribute: Lean refuses it on a declaration of
an imported module. The tagged names persist in each module's olean as the
entries (of type `Name`) of the persistent extension named after the
`initialize` declaration below, `LaxCore.laxStatementAttr` — *that
declaration name is the interface the archive reads by name*: the
inspector looks the extension up in every module's `ModuleData.entries`
without running this module's initializer. Renaming it, or making it
private, breaks every spec-2 environment. (Lean drops private
declarations from the exported entries only in `module` files; a
header-less concept file exports a tagged `private def` too, which is why
the hook rejects `private` and the archive re-judges it from the name.)

This file is deliberately header-less (`import Lean`, no `module`): a
`module` file cannot import a header-less library, and spec-2 packages are
header-less.
-/

open Lean

namespace LaxCore

/-- Every rejection starts the same way, so it is recognisable in a build log. -/
private def reject (declName : Name) (reason : MessageData) : AttrM Unit :=
  throwError m!"invalid `@[lax_statement]` on `{privateToUserName declName}`: {reason}"

/-- The rule, applied after type checking: the declaration is a definition
(not a theorem, axiom, opaque constant, inductive type, or constructor), it
is not private, and its stored type is literally `Sort 0` — no binders, no
reduction. -/
private def validateStatement (declName : Name) : AttrM Unit := do
  if isPrivateName declName then
    reject declName "a statement cannot be `private`; the archive reads statements by name"
  let info ← getConstInfo declName
  match info with
  | .defnInfo _ => pure ()
  | .thmInfo _ =>
    reject declName "a statement is a `def`, not a `theorem`: a theorem proves, a statement claims"
  | .axiomInfo _ =>
    reject declName "a statement is a `def`, not an `axiom`: nothing in a spec-2 archive declares axioms"
  | .opaqueInfo _ => reject declName "a statement is a `def`, not an `opaque` constant"
  | _ => reject declName "a statement is a `def`; this declaration is not a definition"
  match info.type.consumeMData with
  | .sort .zero => pure ()
  | .forallE .. =>
    reject declName
      "a statement takes no binders and is not a function: quantify inside the body with `∀`, as in `def X : Prop := ∀ n, …`"
  | type =>
    reject declName
      m!"a statement's type must be literally `Prop` (`Sort 0`), not a term that merely reduces to it; this declaration has type{indentExpr type}"

/-- Marks a definition as a statement of a Lax concept package. -/
initialize laxStatementAttr : TagAttribute ←
  registerTagAttribute `lax_statement
    "marks a Lax statement: a `def` of type `Prop` with no binders, not private"
    (validate := validateStatement)

/-- Whether `declName` carries `@[lax_statement]` in `env`. -/
def isLaxStatement (env : Environment) (declName : Name) : Bool :=
  laxStatementAttr.hasTag env declName

end LaxCore
