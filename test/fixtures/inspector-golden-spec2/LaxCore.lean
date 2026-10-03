import Lean

/-!
A hook-less twin of `LaxCore` (test/fixtures/laxcore/LaxCore.lean) for the
spec-2 inspector golden: the same persistent extension under the same name,
`LaxCore.laxStatementAttr`, with no validation hook. The real library refuses
a tagged theorem, a tagged `Type`, binders, and `private` at the author's
elaboration; this twin lets every one of those shapes into an olean, which is
exactly the workspace the validator must judge from the inspector's facts
alone ("the hook is never trusted"). The inspector reads the tag by extension
name and never imports either module, so it cannot tell the two apart — which
is the point.
-/

open Lean

namespace LaxCore

/-- The tag, hook-less. -/
initialize laxStatementAttr : TagAttribute ←
  registerTagAttribute `lax_statement "marks a Lax statement (golden twin, no hook)"

end LaxCore
