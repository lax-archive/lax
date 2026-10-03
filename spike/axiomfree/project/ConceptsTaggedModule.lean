module
public import LaxCore

-- The same question for a `module` file, where the exporter filters private
-- declarations out of the `.olean` (exported) level.

namespace ConceptsTaggedModule

@[lax_statement] public def Visible : Prop := True

@[lax_statement_unchecked] public def VisibleUnchecked : Prop := True

@[lax_statement_unchecked] private def Hidden : Prop := True

@[lax_statement_unchecked] def NotPublic : Prop := True

end ConceptsTaggedModule
