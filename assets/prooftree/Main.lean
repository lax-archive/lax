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

def runCoreIO (env : Environment) (x : CoreM α) : IO α := do
  let coreCtx : Core.Context := {
    fileName := "<lax-prooftree>"
    fileMap := default
    options := unlimitedOptions
  }
  let (value, _) ← x.toIO coreCtx { env }
  return value

structure RewriteContext where
  sourceEnv : Environment
  outputEnv : IO.Ref Environment
  copied : IO.Ref (NameMap Name)
  helperPrefix : Name
  maxHeartbeats : USize

partial def rewriteExpr
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
        | _ =>
          throw <| IO.userError s!"proof helper {name} has an unsupported declaration kind"
      let env ← ctx.outputEnv.get
      let env ← match Environment.addDeclCore env ctx.maxHeartbeats declaration none with
        | .ok checked => pure checked
        | .error _ => throw <| IO.userError s!"kernel rejected copied proof helper {generatedName}"
      ctx.outputEnv.set env
      ctx.copied.modify fun values => values.insert name generatedName
      return .const generatedName levels
  | .app fn arg =>
      return .app
        (← rewriteExpr ctx replacements copying fn)
        (← rewriteExpr ctx replacements copying arg)
  | .lam name domain body binderInfo =>
      return .lam name
        (← rewriteExpr ctx replacements copying domain)
        (← rewriteExpr ctx replacements copying body)
        binderInfo
  | .forallE name domain body binderInfo =>
      return .forallE name
        (← rewriteExpr ctx replacements copying domain)
        (← rewriteExpr ctx replacements copying body)
        binderInfo
  | .letE name type value body nonDep =>
      return .letE name
        (← rewriteExpr ctx replacements copying type)
        (← rewriteExpr ctx replacements copying value)
        (← rewriteExpr ctx replacements copying body)
        nonDep
  | .mdata data body =>
      return .mdata data (← rewriteExpr ctx replacements copying body)
  | .proj typeName index body =>
      return .proj typeName index (← rewriteExpr ctx replacements copying body)
  | _ => return expr

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
  let rewriteContext : RewriteContext := {
    sourceEnv
    outputEnv
    copied
    helperPrefix := request.moduleName.toName ++ `_proofTreeHelpers
    maxHeartbeats := (Core.getMaxHeartbeats unlimitedOptions).toUSize
  }
  let mut replacements : NameMap Name := {}
  let mut results : Array ComposeResultEntry := #[]

  for entry in request.entries do
    IO.println s!"  composing {entry.statement}"
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

    let axioms ← runCoreIO env (collectAxioms generatedName)
    let clean := axioms.all fun ax => backgroundAxioms.contains ax
    results := results.push {
      statement := entry.statement
      proof := entry.proof
      generated := entry.generated
      axioms := axioms.map Name.toString
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
