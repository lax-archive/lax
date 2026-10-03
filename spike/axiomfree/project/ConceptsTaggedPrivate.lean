-- Header-less file: does a `private` tagged def reach the olean's exported
-- entries? The hook refuses `private`, so the spike-only unchecked tag is used.
import LaxCore

namespace ConceptsTaggedPrivate

@[lax_statement] def Visible : Prop := True

@[lax_statement_unchecked] def VisibleUnchecked : Prop := True

@[lax_statement_unchecked] private def Hidden : Prop := True

end ConceptsTaggedPrivate
