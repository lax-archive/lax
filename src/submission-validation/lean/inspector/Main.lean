import Lean

/-!
The Lax inspector: loads a package's oleans and reports environment facts as
one JSON file. Core-only, an executable, never an elaborated command: it
executes no code originating outside its own binary and Lean core (module
`initialize` blocks stay disabled). It decides nothing about validity — the
CLI is the sole emitter of violations; parse problems and failed kernel facts
are reported as facts.

Usage: laxinspector <out.json> <module> [<module>...]
The module list is the package's file-derived inventory, root included.
-/

open Lean

def strim (s : String) : String := s.trimAscii.toString

-- ## Frontmatter parsing (fixed minimal yaml subset, see spec "Annotations")

structure ParsedDoc where
  hasFrontmatter : Bool := false
  scalars : Array (String × String) := #[]
  lists : Array (String × Array String) := #[]
  description : String := ""
  error? : Option String := none

def validKey (s : String) : Bool :=
  match s.toList with
  | [] => false
  | c :: _ => c.isAlpha && s.toList.all Char.isAlphanum

inductive FmLine
  | item (val : String)
  | keyval (key val : String) -- val empty means a list opener
  | fence
  | blank
  | other (msg : String)

def classifyFmLine (t : String) : FmLine :=
  if t.isEmpty then .blank
  else if t == "---" then .fence
  else if t.startsWith "- " then .item (strim (t.drop 2).toString)
  else
    match t.splitOn ":" with
    | key :: rest@(_ :: _) =>
      let key := strim key
      if validKey key then .keyval key (strim (":".intercalate rest))
      else .other s!"frontmatter: invalid key `{key}`"
    | _ => .other s!"frontmatter: expected `key: value`, got `{t}`"

/--
Parse a *persisted* docstring into frontmatter and description.

Lean strips a leading line of dashes from docstrings when persisting them, so
an authored opening `---` fence never reaches the olean: an authored
frontmatter arrives as grammar lines followed by the closing `---` line. We
detect both shapes (fenced, in case the behavior changes; fence-less as the
normal case). A fence-less prefix that fails the grammar is a plain
description, since it is indistinguishable from prose above a markdown rule.
-/
def parseDoc (text : String) : ParsedDoc := Id.run do
  let lines := (text.splitOn "\n").toArray
  let mut start := 0
  while start < lines.size && (strim lines[start]!).isEmpty do
    start := start + 1
  if start ≥ lines.size then
    return { description := strim text }

  -- determine the frontmatter extent [fmStart, fmEnd)
  let mut fmStart := start
  let mut fmEnd : Option Nat := none
  if strim lines[start]! == "---" then
    fmStart := start + 1
    let mut j := fmStart
    let mut found := false
    while j < lines.size && !found do
      if strim lines[j]! == "---" then found := true else j := j + 1
    if !found then
      return { hasFrontmatter := true, description := "",
               error? := some "frontmatter: missing closing ---" }
    fmEnd := some j
  else
    let mut j := start
    let mut ok := true
    let mut found := false
    while j < lines.size && ok && !found do
      match classifyFmLine (strim lines[j]!) with
      | .fence => found := true
      | .item _ | .keyval _ _ => j := j + 1
      | .blank | .other _ => ok := false
    if ok && found then
      fmEnd := some j

  let some endIdx := fmEnd
    | return { description := strim text }

  let mut scalars : Array (String × String) := #[]
  let mut lists : Array (String × Array String) := #[]
  let mut curList : Option Nat := none
  let mut err : Option String := none
  for k in [fmStart:endIdx] do
    if err.isSome then
      break
    match classifyFmLine (strim lines[k]!) with
    | .item v =>
      match curList with
      | some j => lists := lists.modify j fun (key, vs) => (key, vs.push v)
      | none => err := some s!"frontmatter: list item without a preceding list key: `{v}`"
    | .keyval key value =>
      if value.isEmpty then
        lists := lists.push (key, #[])
        curList := some (lists.size - 1)
      else
        scalars := scalars.push (key, value)
        curList := none
    | .fence => pure () -- unreachable within the extent
    | .blank => err := some "frontmatter: blank line inside frontmatter"
    | .other msg => err := some msg
  let desc := strim (String.intercalate "\n" (lines.toList.drop (endIdx + 1)))
  return { hasFrontmatter := true, scalars, lists, description := desc, error? := err }

def jsonOfParsedDoc (d : ParsedDoc) : Json :=
  Json.mkObj <|
    [("hasFrontmatter", Json.bool d.hasFrontmatter),
     ("scalars", Json.arr (d.scalars.map fun (k, v) => Json.arr #[Json.str k, Json.str v])),
     ("lists", Json.arr (d.lists.map fun (k, vs) =>
        Json.arr #[Json.str k, Json.arr (vs.map Json.str)])),
     ("description", Json.str d.description)] ++
    (match d.error? with
     | some e => [("error", Json.str e)]
     | none => [])

-- ## Environment facts

def kindOf : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .defnInfo _ => "def"
  | .thmInfo _ => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "ctor"
  | .recInfo _ => "rec"

/-- The reserved-name shapes of `Lean.Meta.Match.MatchEqs` (`isMatchEqName?`,
`isMatchCongrEqName?`), decided against an inspector-built matcher set
instead of `Lean.Meta.isMatcherCore` — see `userLevelName?` for why the
latter is unavailable here. -/
def isMatcherRealization (matchers : NameSet) (n : Name) : Bool :=
  match n with
  | .str p s =>
    (s == "splitter" || Meta.isEqnReservedNameSuffix s
      || Meta.Match.isCongrEqnReservedNameSuffix s)
    && (matchers.contains p || matchers.contains ((privateToUserName? p).getD p))
  | _ => false

/-- User-level names in the sense of the spec's primer: internal details are
flagged, private names un-mangled.

Reserved names (`<fn>.congr_simp`, `<fn>.eq_def`, `<fn>.unfold`,
`<fn>.hcongr_<n>`, …) are compiler-realized: simp and friends persist them
beside the rewritten function's namespace, not the package's, so they must
not reach namespace enforcement. The distinction is provenance-aware, not a
name pattern: the elaborator refuses author declarations of reserved names
(`Lean.Elab.checkNotAlreadyDeclared`), and the predicate set comes from this
binary's own initialization — never from imported code, which stays disabled
(`loadExts := false`). An authored `Foo.congr_simp` whose parent `Foo` does
not exist is not reserved and stays visible to the namespace rule.

Two gaps keep a bare `isReservedName` from matching what the elaborator
refused, so the test here is wider:

* Core predicates match the exact persisted form, private prefix included
  (see the "including the private prefix" remark on the predicate in
  `Lean.Meta.Eqns`). Cross-module realizations arrive both mangled
  (`_private.<mod>.0.<fn>.match_<n>.splitter`) and un-mangled
  (`<fn>.match_<n>.congr_eq_<idx>`), so reservedness is tested on the raw
  name and on its un-mangled form.
* The matcher-family predicates guard on `Lean.Meta.isMatcherCore`, which
  reads the `Match.Extension` environment extension — empty under
  `loadExts := false`. `matcherNamesOf` recovers the matcher set inertly
  from the raw olean entries, and `isMatcherRealization` replays the
  `Lean.Meta.Match.MatchEqs` predicates against it.

The matcher entries read from a submission's own olean are untrusted data: a
forged entry can at worst exempt names shaped like matcher internals
(`<matcher>.splitter`, `<matcher>.congr_eq_<n>`, …) from the namespace rule.
That is hygiene-only — axiom classification and the proof checks never
consult this filter. -/
def userLevelName? (env : Environment) (matchers : NameSet) (n : Name) : Option Name :=
  if isReservedName env n then none
  else
    let u := (privateToUserName? n).getD n
    if u.isInternalDetail then none
    else if isReservedName env u then none
    else if isMatcherRealization matchers n || isMatcherRealization matchers u then none
    else some u

def runCoreIO (env : Environment) (x : CoreM α) : IO α := do
  let coreCtx : Core.Context := { fileName := "<laxinspector>", fileMap := default }
  let (a, _) ← x.toIO coreCtx { env }
  return a

/-!
`Lean.collectAxioms` starts a fresh traversal for every call. That is ideal for
an interactive query, but quadratic in practice here: the inspector asks for
every declaration in a package and their dependency closures overlap heavily.

Lean 4.30 also persists precomputed axiom closures in an environment extension.
We deliberately do not consume those entries: submission oleans are untrusted,
and Replay kernel-checks constants, not arbitrary extension payloads. Instead
this is the same body traversal as `collectAxioms`, with its exact results kept
in one inspector-owned cache across declarations.
-/
structure AxiomCacheState where
  seen : NameMap (Array Name) := {}
  /-- constants whose traversal is still open, at their DFS stack depth -/
  inProgress : NameMap Nat := {}
  axioms : NameSet := {}

abbrev AxiomCacheM := ReaderT Environment (StateM AxiomCacheState)

def insertAxioms (s : NameSet) (axs : Array Name) : NameSet :=
  axs.foldl (init := s) fun acc ax => acc.insert ax

def minLow : Option Nat → Option Nat → Option Nat
  | none, b => b
  | a, none => a
  | some a, some b => some (min a b)

/--
Returns the smallest stack depth of any still-open constant the subtree
reached (Tarjan's lowlink), `none` when the subtree closed on its own.

A constant finished while it can still see an open ancestor sits inside that
ancestor's dependency cycle (mutual inductives and their constructors): its
accumulated set is missing whatever the ancestor has not yet traversed, so it
is merged into the caller but never memoized. The constant where the cycle
closes traverses the entire cycle itself, memoizes its complete set, and a
later query recomputes the other members against that entry.
-/
partial def collectAxiomsCached (c : Name) (depth : Nat := 0) : AxiomCacheM (Option Nat) := do
  let s ← get
  if let some axs := s.seen.find? c then
    modify fun s => { s with axioms := insertAxioms s.axioms axs }
    return none
  if let some d := s.inProgress.find? c then
    return some d

  let savedAxioms := s.axioms
  modify fun s => { s with axioms := {}, inProgress := s.inProgress.insert c depth }
  let collectExpr (low : Option Nat) (e : Expr) : AxiomCacheM (Option Nat) :=
    e.getUsedConstants.foldlM (init := low) fun acc n =>
      return minLow acc (← collectAxiomsCached n (depth + 1))
  let env ← read
  let low ← match env.checked.get.find? c with
    | some (.axiomInfo v) => do
        modify fun s => { s with axioms := s.axioms.insert c }
        collectExpr none v.type
    | some (.defnInfo v) => do collectExpr (← collectExpr none v.type) v.value
    | some (.thmInfo v) => do collectExpr (← collectExpr none v.type) v.value
    | some (.opaqueInfo v) => do collectExpr (← collectExpr none v.type) v.value
    | some (.quotInfo _) => pure none
    | some (.ctorInfo v) => collectExpr none v.type
    | some (.recInfo v) => collectExpr none v.type
    | some (.inductInfo v) => do
        let low ← collectExpr none v.type
        v.ctors.foldlM (init := low) fun acc n =>
          return minLow acc (← collectAxiomsCached n (depth + 1))
    | none => pure none

  let result := (← get).axioms.toArray.qsort Name.lt
  -- open constants are exactly the ancestors and c itself, so a lowlink
  -- below depth means an open ancestor: the set is incomplete for c
  let cacheable := match low with
    | none => true
    | some d => depth ≤ d
  modify fun s => {
    seen := if cacheable then s.seen.insert c result else s.seen
    inProgress := s.inProgress.erase c
    axioms := insertAxioms savedAxioms result
  }
  -- a cycle closing at c is resolved here; only deeper taint propagates
  return match low with
    | some d => if d < depth then some d else none
    | none => none

def axiomsOfCached (env : Environment) (state : AxiomCacheState) (n : Name) :
    Array Name × AxiomCacheState :=
  let state := { state with axioms := {} }
  let (_, state) := (collectAxiomsCached n).run env |>.run state
  (state.seen.find? n).getD #[] |> fun axs => (axs, state)

/-- Pretty-print with core notation only: delaborators are imported code, and
we never run imported code. -/
def ppType (env : Environment) (e : Expr) : IO String := do
  let fmt ← runCoreIO env (Meta.ppExpr e).run'
  return fmt.pretty

/-!
## Shape guards for the persisted extension entries

The three readers below reinterpret raw olean extension entries with
`unsafeCast`. That is a cast of memory, not of values: when a core type changes
shape the cast still compiles and the inspector silently reports nonsense. So
each reader is preceded by an elaboration-time guard that resolves the entry
type's constructor and compares its signature with the text recorded beside the
reader. A Lean release that changes one of them fails the inspector *build* —
which is what the admission run watches — instead of the report.

The rendering is deliberately notation-free: delaborators, notation, and the
pretty-printer's layout are all free to change between releases, so the guards
pin the raw term structure instead. The recorded texts were taken on 2026-09-04
and are identical under `leanprover/lean4:v4.30.0` and `v4.33.0`.
-/

namespace ShapeGuard
open Lean Elab Command

def binderShape : BinderInfo → String
  | .default => "explicit"
  | .implicit => "implicit"
  | .strictImplicit => "strictImplicit"
  | .instImplicit => "instImplicit"

/-- A notation-free rendering of a term: every constant fully qualified, every
binder named and tagged with its binder info, nothing hidden. -/
partial def exprShape (e : Expr) : String :=
  match e with
  | .bvar i => s!"#{i}"
  | .fvar _ => "<fvar>"
  | .mvar _ => "<mvar>"
  | .sort _ => "Sort"
  | .const n _ => n.toString
  | .app f a => s!"({exprShape f} {exprShape a})"
  | .lam n t b _ => s!"(fun ({n} : {exprShape t}) => {exprShape b})"
  | .forallE n t b bi => s!"({binderShape bi} {n} : {exprShape t}) -> {exprShape b}"
  | .letE n t v b _ => s!"(let {n} : {exprShape t} := {exprShape v}; {exprShape b})"
  | .lit (.natVal v) => toString v
  | .lit (.strVal s) => s!"\"{s}\""
  | .mdata _ b => exprShape b
  | .proj s i b => s!"({exprShape b}.{s}.{i})"

/-- The constructors of an inductive type, one `name : signature` per line, in
declaration order. -/
def declShape (env : Environment) (typeName : Name) : Except String String := do
  match env.find? typeName with
  | none => throw s!"{typeName} does not exist under this toolchain"
  | some (.inductInfo info) => do
      let mut lines : Array String := #[]
      for ctor in info.ctors do
        match env.find? ctor with
        | some ci => lines := lines.push s!"{ctor} : {exprShape ci.type}"
        | none => throw s!"constructor {ctor} of {typeName} does not exist"
      return String.intercalate "\n" lines.toList
  | some _ => throw s!"{typeName} is not an inductive type any more"

def drifted (reader what expected actual : String) : String :=
  "lax inspector shape guard: " ++ what ++ " changed shape under this toolchain, so the "
    ++ "unsafeCast in `" ++ reader ++ "` is no longer sound.\n  recorded: " ++ expected
    ++ "\n  found:    " ++ actual
    ++ "\nUpdate the reader and the recorded shape together; see \"The inspector\" in "
    ++ "environments-plan.md before admitting this environment."

/-- Fail elaboration unless `typeName` is still an inductive whose constructors
have exactly the recorded signatures. -/
def checkType (reader : String) (typeName : Name) (expected : String) : CommandElabM Unit := do
  match declShape (← getEnv) typeName with
  | .error e => throwError "lax inspector shape guard (`{reader}`): {e}"
  | .ok actual =>
    if actual != expected then
      let msg := drifted reader s!"the persisted entry type {typeName}" expected actual
      throwError "{msg}"

/-- Fail elaboration unless a constant still has the recorded type. Used for an
extension itself, whose type is what fixes the shape of its persisted entries. -/
def checkConst (reader : String) (name : Name) (expected : String) : CommandElabM Unit := do
  let some info := (← getEnv).find? name
    | throwError "lax inspector shape guard (`{reader}`): {name} does not exist under this toolchain"
  let actual := exprShape info.type
  if actual != expected then
    let msg := drifted reader s!"the type of {name}" expected actual
    throwError "{msg}"

end ShapeGuard

-- `moduleDocsOf` casts each `Lean.moduleDocExt` entry to `ModuleDoc` and reads
-- its first field. (The extension itself is private to `Lean.DocString.Extension`
-- and cannot be named here, so only the entry type is guarded.)
run_cmd do
  ShapeGuard.checkType "moduleDocsOf" `Lean.ModuleDoc
    "Lean.ModuleDoc.mk : (explicit doc : String) -> (explicit declarationRange : Lean.DeclarationRange) -> Lean.ModuleDoc"

/-- Module docstrings, read from the raw olean extension entries. We import
with `loadExts := false` — loading extensions would require enabling
initializer execution, i.e. running imported code — so we read the persisted
`moduleDocExt` entries directly; this is the same pure-data deserialization
the extension loader performs. -/
unsafe def moduleDocsOf (data : ModuleData) : Array ModuleDoc := Id.run do
  let mut out := #[]
  for (extName, entries) in data.entries do
    if (privateToUserName? extName).getD extName == `Lean.moduleDocExt then
      for e in entries do
        out := out.push (unsafeCast e : ModuleDoc)
  return out

-- `declarationRangesOf` casts each `Lean.declRangeExt` entry to
-- `Name × DeclarationRanges` and reads two line numbers out of it. The
-- extension's own type is guarded as well: `MapDeclarationExtension α` is what
-- makes its persisted entries `Name × α`.
run_cmd do
  ShapeGuard.checkConst "declarationRangesOf" `Lean.declRangeExt
    "(Lean.MapDeclarationExtension Lean.DeclarationRanges)"
  ShapeGuard.checkType "declarationRangesOf" `Lean.DeclarationRanges
    "Lean.DeclarationRanges.mk : (explicit range : Lean.DeclarationRange) -> (explicit selectionRange : Lean.DeclarationRange) -> Lean.DeclarationRanges"
  ShapeGuard.checkType "declarationRangesOf" `Lean.DeclarationRange
    "Lean.DeclarationRange.mk : (explicit pos : Lean.Position) -> (explicit charUtf16 : Nat) -> (explicit endPos : Lean.Position) -> (explicit endCharUtf16 : Nat) -> Lean.DeclarationRange"
  ShapeGuard.checkType "declarationRangesOf" `Lean.Position
    "Lean.Position.mk : (explicit line : Nat) -> (explicit column : Nat) -> Lean.Position"

/-- Declaration ranges are persisted extension data too. Inspect keeps
imported extension initialization disabled, so read only these inert olean
entries, just as `moduleDocsOf` does for module documentation. -/
unsafe def declarationRangesOf (data : ModuleData) : NameMap DeclarationRanges := Id.run do
  let mut out : NameMap DeclarationRanges := {}
  for (extName, entries) in data.entries do
    if (privateToUserName? extName).getD extName == `Lean.declRangeExt then
      for e in entries do
        let (name, ranges) := (unsafeCast e : Name × DeclarationRanges)
        out := out.insert name ranges
  return out

-- `matcherNamesOf` casts each `Lean.Meta.Match.Extension.extension` entry to
-- `Meta.Match.Extension.Entry` and reads its first field. (The extension itself
-- is private to `Lean.Meta.Match.MatcherInfo`; only the entry type is guarded.)
run_cmd do
  ShapeGuard.checkType "matcherNamesOf" `Lean.Meta.Match.Extension.Entry
    "Lean.Meta.Match.Extension.Entry.mk : (explicit name : Lean.Name) -> (explicit info : Lean.Meta.Match.MatcherInfo) -> Lean.Meta.Match.Extension.Entry"

/-- Matcher names, read from the raw `Match.Extension` olean entries of every
loaded module — upstream and submission alike. Inspect keeps imported
extension initialization disabled, so read only these inert olean entries,
just as `moduleDocsOf` does; the entry type is
`Lean.Meta.Match.Extension.Entry` (a matcher `name` and its `MatcherInfo`).
Each name is kept in its persisted form and its un-mangled form. -/
unsafe def matcherNamesOf (datas : Array ModuleData) : NameSet := Id.run do
  let mut out : NameSet := {}
  for data in datas do
    for (extName, entries) in data.entries do
      if (privateToUserName? extName).getD extName == `Lean.Meta.Match.Extension.extension then
        for e in entries do
          let entry := (unsafeCast e : Meta.Match.Extension.Entry)
          out := out.insert entry.name
          out := out.insert ((privateToUserName? entry.name).getD entry.name)
  return out

unsafe def main (args : List String) : IO UInt32 := do
  let (outPath, mods) ←
    match args with
    | outPath :: mods@(_ :: _) => pure (outPath, mods)
    | _ =>
      IO.eprintln "usage: laxinspector <out.json> <module> [<module>...]"
      return 1
  initSearchPath (← findSysroot)
  let modNames := mods.map String.toName
  let imports := modNames.toArray.map fun m => ({ module := m } : Import)
  let env ← importModules imports {} (trustLevel := 1024) (loadExts := false)

  let allNames := env.header.moduleNames
  let datas := env.header.moduleData
  let matchers := matcherNamesOf datas
  let mut idxMap : Std.HashMap Name Nat := {}
  for i in [0:allNames.size] do
    idxMap := idxMap.insert allNames[i]! i

  -- reachability over the module import graph, cached per start module
  let mut reachCache : Std.HashMap Nat (Array Bool) := {}
  let reach (cache : Std.HashMap Nat (Array Bool)) (idxMap : Std.HashMap Name Nat)
      (start : Nat) : Array Bool × Std.HashMap Nat (Array Bool) := Id.run do
    if let some r := cache[start]? then
      return (r, cache)
    let mut visited := Array.replicate allNames.size false
    visited := visited.set! start true
    let mut stack := #[start]
    while !stack.isEmpty do
      let cur := stack.back!
      stack := stack.pop
      for imp in datas[cur]!.imports do
        if let some j := idxMap[imp.module]? then
          if !visited[j]! then
            visited := visited.set! j true
            stack := stack.push j
    return (visited, cache.insert start visited)

  let mut moduleJsons : Array Json := #[]
  let mut declJsons : Array Json := #[]
  let mut axiomCache : AxiomCacheState := {}

  for m in modNames do
    let some idx := idxMap[m]?
      | IO.eprintln s!"module {m} not found in the built environment"
        return 2
    let data := datas[idx]!
    let importsJson := Json.arr <| data.imports.map fun imp => Json.str imp.module.toString
    let moduleDocs := moduleDocsOf data
    let declarationRanges := declarationRangesOf data
    let moduleDocsJson := Json.arr <| moduleDocs.map fun d => jsonOfParsedDoc (parseDoc d.doc)
    moduleJsons := moduleJsons.push <| Json.mkObj
      [("name", Json.str m.toString),
       ("imports", importsJson),
       ("moduleDocs", moduleDocsJson),
       ("declCount", toJson data.constNames.size)]

    for declName in data.constNames do
      let some ci := env.find? declName
        | IO.eprintln s!"constant {declName} of module {m} not found"
          return 2
      let (axioms, axiomCache') := axiomsOfCached env axiomCache declName
      axiomCache := axiomCache'
      let doc? ← findDocString? env declName
      let parsed? := doc?.map parseDoc
      let mut fields : List (String × Json) :=
        [("name", Json.str declName.toString),
         ("kind", Json.str (kindOf ci)),
         ("module", Json.str m.toString),
         ("axioms", Json.arr (axioms.map fun a => Json.str a.toString))]
      if let some u := userLevelName? env matchers declName then
        fields := fields ++ [("userName", Json.str u.toString)]
      if let some ranges := declarationRanges.find? declName then
        fields := fields ++ [
          ("startLine", toJson ranges.range.pos.line),
          ("endLine", toJson ranges.range.endPos.line)]
      if let some parsed := parsed? then
        fields := fields ++ [("doc", jsonOfParsedDoc parsed)]
        -- kernel facts for candidate proofs: any frontmatter with a `conclusion`
        if let some (_, conclStr) := parsed.scalars.find? (·.1 == "conclusion") then
          let cn := conclStr.toName
          let mut resolves := false
          let mut isAxiom := false
          let mut originModule : Option Name := none
          let mut originReachable := false
          let mut defeq := false
          if let some target := env.find? cn then
            resolves := true
            if let .axiomInfo _ := target then
              isAxiom := true
            if let some oidx := env.getModuleIdxFor? cn then
              originModule := some allNames[oidx.toNat]!
              let (visited, cache') := reach reachCache idxMap idx
              reachCache := cache'
              originReachable := visited[oidx.toNat]!
            defeq :=
              match Kernel.isDefEq env {} ci.type target.type with
              | .ok b => b
              | .error _ => false
          let mut cf : List (String × Json) :=
            [("resolves", Json.bool resolves),
             ("isAxiom", Json.bool isAxiom),
             ("originReachable", Json.bool originReachable),
             ("defeq", Json.bool defeq)]
          if let some om := originModule then
            cf := cf ++ [("originModule", Json.str om.toString)]
          fields := fields ++ [("conclusionFacts", Json.mkObj cf)]
      if let .axiomInfo _ := ci then
        let sig ← ppType env ci.type
        fields := fields ++ [("signature", Json.str sig)]
      declJsons := declJsons.push (Json.mkObj fields)

  let report := Json.mkObj
    [("modules", Json.arr moduleJsons),
     ("declarations", Json.arr declJsons)]
  IO.FS.writeFile outPath (report.pretty 100)
  return 0
