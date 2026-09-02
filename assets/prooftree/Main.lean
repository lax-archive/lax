import Lean

/-!
The local Lax proof-tree composer.

It imports captured submission modules without running their initializers,
extracts the selected theorem bodies, and creates replacement theorems in
bottom-up order.  Whenever a replacement theorem for a statement already
exists, occurrences of that statement axiom are rewritten to the replacement.
Helpers whose transitive axiom set contains a replaced statement are inlined
and rewritten as well.

This is deliberately a local, best-effort composition tool.  Every declaration
it emits is nevertheless checked by Lean's kernel, and its final axiom set is
reported from the checked environment.
-/

open Lean

structure ComposeEntry where
  statement : String
  proof : String
  generated : String
  assumptions : Array String := #[]
  deriving FromJson

structure ComposeRequest where
  moduleName : String
  outputOlean : String
  outputReport : String
  conceptModules : Array String := #[]
  entries : Array ComposeEntry
  deriving FromJson

structure ComposeResultEntry where
  statement : String
  proof : String
  generated : String
  axioms : Array String
  clean : Bool
  deriving ToJson

structure ComposeResult where
  moduleName : String
  outputOlean : String
  theorems : Array ComposeResultEntry
  deriving ToJson

def backgroundAxioms : NameSet :=
  NameSet.empty.insert `propext |>.insert `Classical.choice |>.insert `Quot.sound

def unlimitedOptions : Options := maxHeartbeats.set {} 0

structure RewriteContext where
  sourceEnv : Environment
  outputEnv : IO.Ref Environment
  copied : IO.Ref (NameMap Name)
  memo : IO.Ref (ExprMap Expr)
  helperPrefix : Name
  maxHeartbeats : USize

mutual

partial def rewriteExpr
    (ctx : RewriteContext)
    (replacements : NameMap Name)
    (copying : NameSet)
    (expr : Expr) : IO Expr := do
  if let some rewritten := (← ctx.memo.get).get? expr then return rewritten
  let rewritten ← rewriteExprCore ctx replacements copying expr
  ctx.memo.modify fun values => values.insert expr rewritten
  return rewritten

partial def rewriteExprCore
    (ctx : RewriteContext)
    (replacements : NameMap Name)
    (copying : NameSet)
    (expr : Expr) : IO Expr := do
  match expr with
  | .const name levels =>
      if let some replacement := replacements.find? name then
        return .const replacement levels
      if (← ctx.outputEnv.get).contains name then
        return expr
      if let some copied := (← ctx.copied.get).find? name then
        return .const copied levels
      if copying.contains name then
        throw <| IO.userError s!"cannot copy the recursive proof helper {name}"
      let some info := ctx.sourceEnv.find? name
        | throw <| IO.userError s!"cannot find proof helper {name}"
      if info.levelParams.length != levels.length then
        throw <| IO.userError s!"universe arity mismatch while copying {name}"
      match info with
      | .inductInfo value =>
        copyInductive ctx replacements copying value.name
        let some generatedName := (← ctx.copied.get).find? name
          | throw <| IO.userError s!"copied inductive {name} was not recorded"
        return .const generatedName levels
      | .ctorInfo value =>
        copyInductive ctx replacements copying value.induct
        let some generatedName := (← ctx.copied.get).find? name
          | throw <| IO.userError s!"copied constructor {name} was not recorded"
        return .const generatedName levels
      | .recInfo value =>
        let some inductiveName := value.all.head?
          | throw <| IO.userError s!"recursor {name} does not name its inductive family"
        copyInductive ctx replacements copying inductiveName
        let some generatedName := (← ctx.copied.get).find? name
          | throw <| IO.userError s!"copied recursor {name} was not recorded"
        return .const generatedName levels
      | .quotInfo _ =>
        throw <| IO.userError s!"proof helper {name} is an unsupported quotient declaration"
      | _ => pure ()
      let generatedName := ctx.helperPrefix ++ name
      let copying := copying.insert name
      let rewrittenType ← rewriteExpr ctx replacements copying info.type
      let declaration ← match info with
        | .defnInfo value => do
          let rewrittenValue ← rewriteExpr ctx replacements copying value.value
          pure <| Declaration.defnDecl {
            value with
            name := generatedName
            type := rewrittenType
            value := rewrittenValue
            all := [generatedName]
          }
        | .thmInfo value => do
          let rewrittenValue ← rewriteExpr ctx replacements copying value.value
          pure <| Declaration.thmDecl {
            value with
            name := generatedName
            type := rewrittenType
            value := rewrittenValue
            all := [generatedName]
          }
        | .opaqueInfo value => do
          let rewrittenValue ← rewriteExpr ctx replacements copying value.value
          pure <| Declaration.opaqueDecl {
            value with
            name := generatedName
            type := rewrittenType
            value := rewrittenValue
            all := [generatedName]
          }
        | .axiomInfo _ =>
          throw <| IO.userError s!"proof helper {name} is an unresolved axiom"
        | _ => unreachable!
      let env ← ctx.outputEnv.get
      let env ← match Environment.addDeclCore env ctx.maxHeartbeats declaration none with
        | .ok checked => pure checked
        | .error _ => throw <| IO.userError s!"kernel rejected copied proof helper {generatedName}"
      ctx.outputEnv.set env
      ctx.copied.modify fun values => values.insert name generatedName
      return .const generatedName levels
  | .app fn arg =>
      return expr.updateApp!
        (← rewriteExpr ctx replacements copying fn)
        (← rewriteExpr ctx replacements copying arg)
  | .lam _ domain body binderInfo =>
      return expr.updateLambda! binderInfo
        (← rewriteExpr ctx replacements copying domain)
        (← rewriteExpr ctx replacements copying body)
  | .forallE _ domain body binderInfo =>
      return expr.updateForall! binderInfo
        (← rewriteExpr ctx replacements copying domain)
        (← rewriteExpr ctx replacements copying body)
  | .letE _ type value body nonDep =>
      return expr.updateLet!
        (← rewriteExpr ctx replacements copying type)
        (← rewriteExpr ctx replacements copying value)
        (← rewriteExpr ctx replacements copying body)
        nonDep
  | .mdata _ body =>
      return expr.updateMData! (← rewriteExpr ctx replacements copying body)
  | .proj typeName index body =>
      let rewrittenTypeName ←
        if let some replacement := replacements.find? typeName then
          pure replacement
        else if (← ctx.outputEnv.get).contains typeName then
          pure typeName
        else if let some copied := (← ctx.copied.get).find? typeName then
          pure copied
        else
          let some info := ctx.sourceEnv.find? typeName
            | throw <| IO.userError s!"cannot find projected proof helper {typeName}"
          let levels := info.levelParams.map Level.param
          match ← rewriteExpr ctx replacements copying (.const typeName levels) with
          | .const rewritten _ => pure rewritten
          | _ => throw <| IO.userError s!"could not rewrite projected proof helper {typeName}"
      let rewrittenBody ← rewriteExpr ctx replacements copying body
      if rewrittenTypeName == typeName then
        return expr.updateProj! rewrittenBody
      return .proj rewrittenTypeName index rewrittenBody
  | _ => return expr

partial def copyInductive
    (ctx : RewriteContext)
    (replacements : NameMap Name)
    (copying : NameSet)
    (inductiveName : Name) : IO Unit := do
  if (← ctx.copied.get).contains inductiveName then return
  if copying.contains inductiveName then
    throw <| IO.userError s!"cannot copy the recursive proof helper {inductiveName}"
  let some (.inductInfo root) := ctx.sourceEnv.find? inductiveName
    | throw <| IO.userError s!"cannot find proof-local inductive {inductiveName}"
  let infos ← root.all.mapM fun name =>
    match ctx.sourceEnv.find? name with
    | some (.inductInfo value) => pure value
    | _ => throw <| IO.userError s!"cannot find mutual proof-local inductive {name}"
  for info in infos do
    if info.numNested != 0 then
      throw <| IO.userError s!"nested proof-local inductive {info.name} is unsupported"
    if info.levelParams != root.levelParams || info.numParams != root.numParams ||
        info.isUnsafe != root.isUnsafe then
      throw <| IO.userError s!"inconsistent proof-local inductive family containing {info.name}"

  -- Record the whole family before rewriting constructor types so recursive
  -- occurrences resolve to their generated names.
  for info in infos do
    let generatedType := ctx.helperPrefix ++ info.name
    ctx.copied.modify fun values => values.insert info.name generatedType
    ctx.copied.modify fun values =>
      values.insert (info.name.appendCore `rec) (generatedType.appendCore `rec)
    for constructor in info.ctors do
      ctx.copied.modify fun values => values.insert constructor (ctx.helperPrefix ++ constructor)

  let types ← infos.mapM fun info => do
    let rewrittenType ← rewriteExpr ctx replacements (copying.insert info.name) info.type
    let constructors ← info.ctors.mapM fun constructorName => do
      let some (.ctorInfo constructor) := ctx.sourceEnv.find? constructorName
        | throw <| IO.userError s!"cannot find constructor {constructorName}"
      let rewrittenConstructorType ←
        rewriteExpr ctx replacements (copying.insert constructorName) constructor.type
      pure ({
        name := ctx.helperPrefix ++ constructor.name
        type := rewrittenConstructorType
      } : Constructor)
    pure ({
      name := ctx.helperPrefix ++ info.name
      type := rewrittenType
      ctors := constructors
    } : InductiveType)

  let declaration := Declaration.inductDecl root.levelParams root.numParams types root.isUnsafe
  let env ← ctx.outputEnv.get
  let env ← match Environment.addDeclCore env ctx.maxHeartbeats declaration none with
    | .ok checked => pure checked
    | .error _ =>
      throw <| IO.userError s!"kernel rejected copied proof-local inductive {inductiveName}"
  ctx.outputEnv.set env

end

def readRequest (filename : String) : IO ComposeRequest := do
  let contents ← IO.FS.readFile filename
  let json ← match Json.parse contents with
    | .ok value => pure value
    | .error error => throw <| IO.userError s!"invalid request JSON: {error}"
  match fromJson? json with
  | .ok request => pure request
  | .error error => throw <| IO.userError s!"invalid proof-tree request: {error}"

unsafe def main (args : List String) : IO UInt32 := do
  let (requestPath, modules) ← match args with
    | requestPath :: modules@(_ :: _) => pure (requestPath, modules)
    | _ =>
      IO.eprintln "usage: lean --run Main.lean <request.json> <module> [<module>...]"
      return 1
  let request ← readRequest requestPath
  initSearchPath (← findSysroot)
  let proofImports := modules.toArray.map fun moduleName =>
    ({ module := moduleName.toName } : Import)
  let conceptImports := request.conceptModules.map fun moduleName =>
    ({ module := moduleName.toName } : Import)
  let sourceEnv ← importModules proofImports {} (trustLevel := 1024) (loadExts := false)
  let outputEnv ← importModules conceptImports {} (trustLevel := 1024) (loadExts := false)
  let outputEnv ← IO.mkRef (outputEnv.setMainModule request.moduleName.toName)
  let copied ← IO.mkRef ({} : NameMap Name)
  let memo ← IO.mkRef ({} : ExprMap Expr)
  let rewriteContext : RewriteContext := {
    sourceEnv
    outputEnv
    copied
    memo
    helperPrefix := request.moduleName.toName ++ `_proofTreeHelpers
    maxHeartbeats := (Core.getMaxHeartbeats unlimitedOptions).toUSize
  }
  let mut replacements : NameMap Name := {}
  let mut axiomDependencies : NameMap NameSet := {}
  let mut results : Array ComposeResultEntry := #[]

  for entry in request.entries do
    IO.println s!"  composing {entry.statement}"
    memo.set {}
    let statementName := entry.statement.toName
    let proofName := entry.proof.toName
    let generatedName := entry.generated.toName
    let some statementInfo := sourceEnv.find? statementName
      | throw <| IO.userError s!"statement {statementName} was not found"
    let some proofInfo := sourceEnv.find? proofName
      | throw <| IO.userError s!"proof {proofName} was not found"
    match statementInfo with
    | .axiomInfo _ => pure ()
    | _ => throw <| IO.userError s!"conclusion {statementName} is not an axiom"
    match proofInfo with
    | .thmInfo _ => pure ()
    | _ => throw <| IO.userError s!"selected proof {proofName} is not a theorem"
    if proofInfo.levelParams.length != statementInfo.levelParams.length then
      throw <| IO.userError
        s!"proof {proofName} and statement {statementName} have different universe arities"

    let targetLevels := statementInfo.levelParams.map Level.param
    let proofType := proofInfo.type.instantiateLevelParams proofInfo.levelParams targetLevels
    match Kernel.isDefEq sourceEnv {} proofType statementInfo.type with
    | .ok true => pure ()
    | .ok false => throw <| IO.userError s!"proof {proofName} is not definitionally equal to {statementName}"
    | .error _ => throw <| IO.userError s!"could not compare {proofName} with {statementName}"

    let proofValue := proofInfo.value! (allowOpaque := true)
      |>.instantiateLevelParams proofInfo.levelParams targetLevels
    let rewritten ← rewriteExpr rewriteContext replacements {} proofValue
    let declaration := Declaration.thmDecl {
      name := generatedName
      levelParams := statementInfo.levelParams
      type := statementInfo.type
      value := rewritten
    }
    let env ← outputEnv.get
    let env ← match Environment.addDeclCore env rewriteContext.maxHeartbeats declaration none with
      | .ok checked => pure checked
      | .error _ =>
        throw <| IO.userError s!"kernel rejected generated theorem {generatedName}"
    outputEnv.set env
    replacements := replacements.insert statementName generatedName

    -- Published proof metadata already contains the proof's transitive Lax
    -- assumptions.  Propagate that small dependency graph through the
    -- replacements instead of asking `collectAxioms` to re-walk gigantic
    -- kernel terms.  The latter can consume many gigabytes even though all
    -- imported Mathlib declarations have already been validated.
    let mut axioms := backgroundAxioms
    for assumptionString in entry.assumptions do
      let assumption := assumptionString.toName
      if let some inherited := axiomDependencies.find? assumption then
        for ax in inherited do axioms := axioms.insert ax
      else
        axioms := axioms.insert assumption
    axiomDependencies := axiomDependencies.insert statementName axioms
    let reportedAxioms := axioms.toArray.qsort Name.lt
    let clean := reportedAxioms.all fun ax => backgroundAxioms.contains ax
    results := results.push {
      statement := entry.statement
      proof := entry.proof
      generated := entry.generated
      axioms := reportedAxioms.map Name.toString
      clean
    }

  if let some parent := (System.FilePath.mk request.outputOlean).parent then
    IO.FS.createDirAll parent
  let env ← outputEnv.get
  let emptyEntries : OLeanEntries (Array (Name × Array EnvExtensionEntry)) :=
    OLeanEntries.uniform #[]
  let moduleData ← mkModuleData env .private (some emptyEntries)
  saveModuleData request.outputOlean env.mainModule moduleData
  let report : ComposeResult := {
    moduleName := request.moduleName
    outputOlean := request.outputOlean
    theorems := results
  }
  IO.FS.writeFile request.outputReport (toJson report |>.pretty 100)
  return 0
