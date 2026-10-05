import Lean

/-!
The Lax inspector: loads a package's oleans and reports environment facts as
one JSON file. Core-only, an executable, never an elaborated command: it
executes no code originating outside its own binary and Lean core (module
`initialize` blocks stay disabled). It decides nothing about validity — the
CLI is the sole emitter of violations; parse problems and failed kernel facts
are reported as facts.

Usage: laxinspector --spec <1|2> <out.json> <module> [<module>...]
The module list is the package's file-derived inventory, root included. The
spec version is the content spec of the archive environment the package was
built in (environments.ts `specVersion`); one inspector source serves both,
and the spec-1 report is byte-identical to what it was before spec 2 existed
— the spec-2 facts (`laxStatement`, `isProp`, `levelParams`, `telescope`,
and the signature/body of tagged definitions) appear only under `--spec 2`.
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

/-- Whether a name is reserved, in its persisted or its un-mangled form — the
two gaps `userLevelName?` documents. It is the evidence behind
`Origin.realized`: the validator exempts a realized *theorem* from the
namespace rule, since Lean's `finalizeImport` admits the same theorem from
two modules (identical name, type, and level parameters — `subsumesInfo`),
which is exactly what a realization regenerated in two records is; a
realized **definition** under an imported name (`bv_decide`'s
`<enum>.enumToBitVec`, the one public one in v4.35) is refused at import
when two records both carry it, and is a violation
(spike/axiomfree/namespace-review-20261004.md, B2). -/
def isReservedEither (env : Environment) (n : Name) : Bool :=
  isReservedName env n || isReservedName env ((privateToUserName? n).getD n)

/-- Where a spec-2 declaration came from, with the evidence, as the report
writes it under `origin` (decision 10; codex review 2 2026-10-04, finding 1).
Every validator rule that distinguishes authored content from what Lean
generated consults this one fact; `userName` is the display name and no
rule reads its presence. The cases, in the order they are decided:

* `scoped module` — a name carrying macro scopes (`hasMacroScopes`); the
  module is the one `extractMacroScopes` names (`scopeModule`).
  Decided first: such a name has numeric components whatever else it is.
* `private module parent?` — Lean's private mangling
  `_private.<module>.0.<rest>` (`privatePrefix?`); the module is the
  mangling's own evidence, and it settles ownership before anything Lean
  realized inside the name. Privacy alone does not say who wrote the name,
  so the case also carries the parent, un-mangled, when Lean generated it:
  no range, and reserved, a matcher realization, or under an own parent
  (by the mangled or the un-mangled name) — the nested proof of a
  `private def f` is `_private.M.0.f._proof_1` (ultracode review
  2026-10-04, I1 follow-up). An authored private name has its range and
  no parent.
* `realized parent` — a reserved name (`isReservedName`, persisted or
  un-mangled) or a matcher realization: a name Lean realizes under an
  existing constant and refuses an author (`checkNotAlreadyDeclared`);
  the parent is that constant. Theorem or not — the validator reads the
  kind beside it.
* `authored` — the declaration has a declaration range: it was elaborated
  from the module's own syntax (`declRangeExt`, read inertly).
* `auxiliary parent` — no range, and the nearest proper prefix is a
  constant of this package: a recursor, `casesOn`, `noConfusion`, a
  matcher, `sizeOf` lemmas, `mk.injEq`, an abstracted `proof_<n>` — every
  one extends the declaration it was generated for, which is the parent.
* `authored`, otherwise: a declaration without a range and without an own
  parent is held to the authored rules, the stricter reading.

The range and matcher entries come from the submission's own olean and
are untrusted data: a forged range makes a generated name authored
(stricter, harmless), a dropped range makes an authored name auxiliary
(never an endpoint, still held to its prefix). -/
inductive Origin where
  | authored
  | «private» (module : Name) (parent : Option Name)
  | scoped (module : Name)
  | realized (parent : Name)
  | auxiliary (parent : Name)

/-- `_private.M.0.rest` → `M`: the private prefix without its `_private`
root and its trailing number. -/
def privateModule? (n : Name) : Option Name := do
  let p ← privatePrefix? n
  let m := p.getPrefix
  some (m.replacePrefix `_private Name.anonymous)

/-- The nearest proper prefix that is a constant of the package. -/
partial def ownParent? (packageNames : NameSet) (n : Name) : Option Name :=
  let p := n.getPrefix
  if p.isAnonymous then none
  else if packageNames.contains p then some p
  else ownParent? packageNames p

/-- The module a macro-scoped name was elaborated in. `extractMacroScopes`
on `<name>._@.<module>.<hash>._hygCtx._hyg.<n>` (v4.35, probed) gives
`imported = <module>.<hash>` and `ctx = _hygCtx`; concatenated and
stripped of the trailing number and `_`-components, that is the module. -/
partial def scopeModule : Name → Name
  | .num p _ => scopeModule p
  | .str p s => if s.startsWith "_" then scopeModule p else .str p s
  | .anonymous => .anonymous

def originOf (env : Environment) (matchers : NameSet) (packageNames : NameSet)
    (ranges : NameMap DeclarationRanges) (n : Name) : Origin :=
  let u := (privateToUserName? n).getD n
  -- macro scopes first: a scoped name has numeric components by
  -- construction whatever else it is (a private `initFn` is both), and the
  -- scope's context names the module that elaborated it
  if n.hasMacroScopes then
    let v := extractMacroScopes n
    .scoped (scopeModule (v.imported ++ v.ctx))
  -- then privacy: the mangling settles ownership before anything Lean
  -- realized inside the private name (a matcher's `splitter` is a private
  -- *definition*, which realized-def rules would otherwise refuse)
  else if let some m := privateModule? n then
    let generated :=
      if ranges.contains n then none
      else if isReservedEither env n || isMatcherRealization matchers n || isMatcherRealization matchers u then
        some u.getPrefix
      else match ownParent? packageNames n with
        | some p => some ((privateToUserName? p).getD p)
        | none => ownParent? packageNames u
    .«private» m generated
  else if isReservedEither env n || isMatcherRealization matchers n || isMatcherRealization matchers u then
    .realized u.getPrefix
  else if ranges.contains n then .authored
  else if let some p := ownParent? packageNames n then .auxiliary p
  else .authored

def jsonOfOrigin : Origin → Json
  | .authored => Json.mkObj [("kind", Json.str "authored")]
  | .«private» m none => Json.mkObj [("kind", Json.str "private"), ("module", Json.str m.toString)]
  | .«private» m (some p) =>
    Json.mkObj [("kind", Json.str "private"), ("module", Json.str m.toString), ("parent", Json.str p.toString)]
  | .scoped m => Json.mkObj [("kind", Json.str "scoped"), ("module", Json.str m.toString)]
  | .realized p => Json.mkObj [("kind", Json.str "realized"), ("parent", Json.str p.toString)]
  | .auxiliary p => Json.mkObj [("kind", Json.str "auxiliary"), ("parent", Json.str p.toString)]

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
  /-- the axiom sets of the current module's own constants, which the walk
  resolves from that module's olean rather than from the merged
  environment: reset per module (`AxiomCacheCtx.local`) -/
  localSeen : NameMap (Array Name) := {}
  /-- constants whose traversal is still open, at their DFS stack depth -/
  inProgress : NameMap Nat := {}
  axioms : NameSet := {}

/-- What the walk resolves a constant against. `finalizeImport` keeps one
copy of a theorem two modules both declare (identical name, type, and level
parameters — `subsumesInfo`), so `env.find?` on such a name returns the
later module's body and the earlier module's copy, `sorry` and all, would
never be walked (codex review 2 2026-10-04, finding 4). The module's own
constants (`ModuleData.constants`, exactly what its olean stores) take
precedence over the merged environment, for the root and for everything the
walk reaches that this module declares; everything else is the merged
environment, which is what this module imported. -/
structure AxiomCacheCtx where
  env : Environment
  /-- the current module's constants by name -/
  «local» : Std.HashMap Name ConstantInfo

abbrev AxiomCacheM := ReaderT AxiomCacheCtx (StateM AxiomCacheState)

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
  let ctx ← read
  -- a constant this module declares is cached per module, since the merged
  -- environment may hold another module's copy of the same name
  let isLocal := ctx.local.contains c
  if let some axs := (if isLocal then s.localSeen else s.seen).find? c then
    modify fun s => { s with axioms := insertAxioms s.axioms axs }
    return none
  if let some d := s.inProgress.find? c then
    return some d

  let savedAxioms := s.axioms
  modify fun s => { s with axioms := {}, inProgress := s.inProgress.insert c depth }
  let collectExpr (low : Option Nat) (e : Expr) : AxiomCacheM (Option Nat) :=
    e.getUsedConstants.foldlM (init := low) fun acc n =>
      return minLow acc (← collectAxiomsCached n (depth + 1))
  let low ← match (ctx.local[c]? <|> ctx.env.checked.get.find? c) with
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
    seen := if cacheable && !isLocal then s.seen.insert c result else s.seen
    localSeen := if cacheable && isLocal then s.localSeen.insert c result else s.localSeen
    inProgress := s.inProgress.erase c
    axioms := insertAxioms savedAxioms result
  }
  -- a cycle closing at c is resolved here; only deeper taint propagates
  return match low with
    | some d => if d < depth then some d else none
    | none => none

def axiomsOfCached (ctx : AxiomCacheCtx) (state : AxiomCacheState) (n : Name) :
    Array Name × AxiomCacheState :=
  let state := { state with axioms := {} }
  let (_, state) := (collectAxiomsCached n).run ctx |>.run state
  let seen := if ctx.local.contains n then state.localSeen else state.seen
  (seen.find? n).getD #[] |> fun axs => (axs, state)

/-- Constants mentioned directly by a declaration's type or value. The
validator uses the package-local part of this graph to decide which helper
lemmas are reachable from an authored proof theorem. -/
def insertUsedConstants (used : NameSet) (e : Expr) : NameSet :=
  e.getUsedConstants.foldl (init := used) fun acc name => acc.insert name

def usedConstantsOf : ConstantInfo → NameSet
  | .axiomInfo v => insertUsedConstants {} v.type
  | .defnInfo v => insertUsedConstants (insertUsedConstants {} v.type) v.value
  | .thmInfo v => insertUsedConstants (insertUsedConstants {} v.type) v.value
  | .opaqueInfo v => insertUsedConstants (insertUsedConstants {} v.type) v.value
  | .quotInfo _ => {}
  | .ctorInfo v => insertUsedConstants {} v.type
  | .recInfo v => insertUsedConstants {} v.type
  | .inductInfo v =>
      v.ctors.foldl (init := insertUsedConstants {} v.type) fun used ctor => used.insert ctor

/-- Pretty-print with core notation only: delaborators are imported code, and
we never run imported code. -/
def ppType (env : Environment) (e : Expr) : IO String := do
  let fmt ← runCoreIO env (Meta.ppExpr e).run'
  return fmt.pretty

/-!
## Spec-2 facts (axiomfree-plan.md, "Inspector")

Under spec 2 a statement is a tagged definition and a proof is a theorem whose
type is a chain of statement constants, so the report carries four more facts
per declaration. All of them are syntactic reads of the stored type or of
persisted extension data: no reduction, no kernel work, no judgment — whether
a constant in a telescope *is* a statement is the validator's question.
-/

/-- Whether a name is canonical: Lean's escaped `Name.toString`, which every
report writes, reads back through `String.toName` — the function `lake
comparator` parses `theorem_names` with — as the same name, un-mangled
(`privateToUserName?`). The escaped printer is injective wherever this
holds: `Lax1.C.«A.B»` and `Lax1.C.A.B` print apart, as do `.str A "3"`
(`A.«3»`) and `.num A 3` (`A.3`), all verified on v4.35.0-rc3 (ultracode
review 2026-10-04, C3). It fails for a component carrying `»`, which the
printer cannot quote, and for a name it prints unescaped — inaccessible
(`x✝`, a trailing `_inaccessible`), macro-scoped, or rooted in `#`/`?`. A
declaration so named is flagged `nonCanonical`; the validator refuses an
authored one and lets Lean's own macro-scoped and auxiliary names pass. A
telescope link to such a constant is flagged too (`jsonOfLink`).
Whether a canonical name may be an *endpoint* is the validator's question
(contracts.ts `LEAN_NAME_PATTERN`). -/
def isCanonicalName (n : Name) : Bool :=
  let u := (privateToUserName? n).getD n
  u.toString.toName == u

/-- A universe level, structurally, as a JSON array tagged by its head:
`["zero"]`, `["succ", l]`, `["max", a, b]`, `["imax", a, b]`, and
`["param", "u"]` for a universe variable. A level metavariable never survives
into a stored type; `["mvar"]` keeps the encoding total. The validator's
universe rule admits `param` alone, so a build output only ever carries
parameter names. -/
partial def jsonOfLevel : Level → Json
  | .zero => Json.arr #[Json.str "zero"]
  | .succ l => Json.arr #[Json.str "succ", jsonOfLevel l]
  | .max a b => Json.arr #[Json.str "max", jsonOfLevel a, jsonOfLevel b]
  | .imax a b => Json.arr #[Json.str "imax", jsonOfLevel a, jsonOfLevel b]
  | .param n => Json.arr #[Json.str "param", Json.str n.toString]
  | .mvar _ => Json.arr #[Json.str "mvar"]

/-- One hypothesis of a telescope. The binder's name and kind are not part of
an edge and are not recorded: the certificate applies the proof with `@`, and
the kernel ignores binder info. -/
structure TelescopeBinder where
  const : Name
  levels : List Level

/-- The stored type as a chain of `∀`-binders over bare constants ending in a
bare constant — metadata stripped at every node, nothing reduced — or `none`
when any domain or the conclusion is anything else. A constant applied to
arguments is not a bare constant, so `∀ (h : P 1), Q` is `none`, as is a
type whose conclusion is a `Sort`. The walk is purely syntactic. -/
partial def telescopeOf (e : Expr) (acc : Array TelescopeBinder := #[]) :
    Option (Array TelescopeBinder × Name × List Level) :=
  match e.consumeMData with
  | .forallE _ d b _ =>
    match d.consumeMData with
    | .const n ls => telescopeOf b (acc.push { const := n, levels := ls })
    | _ => none
  | .const n ls => some (acc, n, ls)
  | _ => none

/-- One link of a telescope: the constant as printed, its level arguments,
and `nonCanonical` when the printed name does not read back as the constant
(`isCanonicalName`) — `Lax1.C.«A.B»._inaccessible` prints as
`Lax1.C.A.B._inaccessible`, the text of a different, canonical name. The
validator compares links by their printed names, so such a link is told
apart by the flag rather than by its text. -/
def jsonOfLink (c : Name) (ls : List Level) : Json :=
  Json.mkObj <|
    [("const", Json.str c.toString),
     ("levels", Json.arr (ls.toArray.map jsonOfLevel))] ++
    (if isCanonicalName c then [] else [("nonCanonical", Json.bool true)])

def jsonOfTelescope : Option (Array TelescopeBinder × Name × List Level) → Json
  | none => Json.null
  | some (binders, n, ls) =>
    Json.mkObj
      [("hypotheses", Json.arr (binders.map fun b => jsonOfLink b.const b.levels)),
       ("conclusion", jsonOfLink n ls)]

/-- The number of leading `∀`-binders of the stored type, metadata stripped:
what a tagged definition that is not `Prop` is told about (`def P (n : Nat) :
Prop` is stored as `∀ (n : Nat), Prop`). -/
partial def leadingBinders (e : Expr) (n : Nat := 0) : Nat :=
  match e.consumeMData with
  | .forallE _ _ b _ => leadingBinders b (n + 1)
  | _ => n

/-- The persistent extension `LaxCore`'s `@[lax_statement]` tag attribute
persists its tagged names under. It is the `initialize` declaration's name,
not the attribute's (`registerTagAttribute` passes `decl_name%` as the
extension's `name`), and it is the one piece of `LaxCore`'s interface the
archive reads by name — see the library's module docstring. -/
def laxStatementExtension : Name := `LaxCore.laxStatementAttr

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
    ++ "history/environments-plan.md before admitting this environment."

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
-- `Name × DeclarationRanges` and reads the range's start and end positions
-- (line and column) out of it. The extension's own type is guarded as well:
-- `MapDeclarationExtension α` is what makes its persisted entries `Name × α`.
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

-- `laxStatementsOf` casts each entry of the tag attribute's extension to
-- `Name`. The inspector never imports `LaxCore`, so the extension itself
-- cannot be guarded; what fixes its entry type is `Lean.TagAttribute`, whose
-- `ext` field is the `PersistentEnvExtension Name Name NameSet` every tag
-- attribute is built on.
run_cmd do
  ShapeGuard.checkType "laxStatementsOf" `Lean.TagAttribute
    "Lean.TagAttribute.mk : (explicit attr : Lean.AttributeImpl) -> (explicit ext : (((Lean.PersistentEnvExtension Lean.Name) Lean.Name) Lean.NameSet)) -> Lean.TagAttribute"

/-- The names tagged `@[lax_statement]` in every loaded module, read from the
raw olean entries as `moduleDocsOf` reads module docs: `LaxCore`'s
initializer never runs here and the attribute is never registered in this
process. The olean filter that drops `private` declarations from exported
entries is a module-system feature, and spec-2 files are header-less, so a
tagged `private def` *is* in the set; the validator re-judges `private` from
the name (stage-0 confirmation 2 in spike/axiomfree/REPORT.md). -/
unsafe def laxStatementsOf (datas : Array ModuleData) : NameSet := Id.run do
  let mut out : NameSet := {}
  for data in datas do
    for (extName, entries) in data.entries do
      if (privateToUserName? extName).getD extName == laxStatementExtension then
        for e in entries do
          out := out.insert (unsafeCast e : Name)
  return out

-- `initializersOf` casts each entry of the `init`/`builtin_init` attributes'
-- extensions to `Name × Name` — the declaration and its initialization
-- function, as a `ParametricAttribute Name` persists them. The attributes'
-- own types are guarded: `ParametricAttribute α` is what makes the persisted
-- entries `Name × α`.
run_cmd do
  ShapeGuard.checkConst "initializersOf" `Lean.regularInitAttr "(Lean.ParametricAttribute Lean.Name)"
  ShapeGuard.checkConst "initializersOf" `Lean.builtinInitAttr "(Lean.ParametricAttribute Lean.Name)"

/-- The declarations a module marks `@[init …]`/`@[builtin_init …]` — every
`initialize`, `builtin_initialize`, and their sugar (`register_option`,
`register_simp_attr`, a persistent extension) — read
from the raw olean entries as `moduleDocsOf` reads module docs. A record
declares none (spec 2): an initializer registers a name-keyed global
registry that clashes at import when two records pick the same name, and
runs arbitrary IO in every importer's `lean`
(spike/axiomfree/namespace-review-20261004.md, F1). `declare_syntax_cat` is
not among them: it marks nothing `@[init]` (v4.35.0-rc3) and registers its
category as a parser-extension entry, read by `syntaxCategoriesOf`. -/
unsafe def initializersOf (data : ModuleData) : NameSet := Id.run do
  let mut out : NameSet := {}
  for (extName, entries) in data.entries do
    let name := (privateToUserName? extName).getD extName
    if name == `Lean.regularInitAttr || name == `Lean.builtinInitAttr then
      for e in entries do
        let (decl, _) := (unsafeCast e : Name × Name)
        out := out.insert decl
  return out

-- `instancesOf` casts each entry of `Lean.Meta.instanceExtension` to
-- `ScopedEnvExtension.Entry InstanceEntry` (its type guarded below, the
-- `Entry` constructors by `globalSyntaxOf`'s guard) and reads `globalName?`.
run_cmd do
  ShapeGuard.checkConst "instancesOf" `Lean.Meta.instanceExtension
    "((Lean.SimpleScopedEnvExtension Lean.Meta.InstanceEntry) Lean.Meta.Instances)"
  ShapeGuard.checkType "instancesOf" `Lean.Meta.InstanceEntry
    "Lean.Meta.InstanceEntry.mk : (explicit keys : (Array Lean.Meta.InstanceKey)) -> (explicit val : Lean.Expr) -> (explicit priority : Nat) -> (explicit globalName? : (Option Lean.Name)) -> (explicit synthOrder : (Array Nat)) -> (explicit attrKind : Lean.AttributeKind) -> Lean.Meta.InstanceEntry"

/-- The declarations the package's modules register as instances, global or
`scoped` (a `local` one is not persisted), read from the raw olean entries
as `moduleDocsOf` reads module docs. Read over the whole package, since
`attribute [instance]` may sit in another module than the declaration. An
instance is used by instance resolution, not by name, so it is never an
unused helper (spec 2). -/
unsafe def instancesOf (datas : Array ModuleData) : NameSet := Id.run do
  let mut out : NameSet := {}
  for data in datas do
    for (extName, entries) in data.entries do
      if (privateToUserName? extName).getD extName == `Lean.Meta.instanceExtension then
        for e in entries do
          let entry : Meta.InstanceEntry := match (unsafeCast e : ScopedEnvExtension.Entry Meta.InstanceEntry) with
            | .global a => a
            | .scoped _ a => a
          if let some n := entry.globalName? then out := out.insert n
  return out

/-- Whether an extension holds a module's syntax, macro, or elaborator
registrations: the parser extension (`syntax`/`notation`/`infix` tokens and
parsers) or a `KeyedDeclsAttribute` — `macro`/`macro_rules`/`notation`
expansions, `elab`/`elab_rules` for terms, commands, and tactics, and every
other keyed elaborator Lean or a dependency defines (`doElem_elab`,
`inductive_elab`, `try_tactic`, grind's, …). A keyed attribute's extension is
named by the constant that holds the attribute, so the attribute is found by
that constant's type, not by a list that misses the next one (the E1
follow-up's re-review, 2026-10-05). The pretty printer's keyed attributes
(delaborators, unexpanders, formatters, parenthesizers) change only how a
term prints and are not syntax extensions. Every one is a
`ScopedEnvExtension`, and the olean keeps each entry's scope: `global`, or
`scoped` under a namespace (a `local` one is not persisted at all). -/
def isSyntaxExtension (env : Environment) (name : Name) : Bool :=
  name == `Lean.Parser.parserExtension ||
    (!(`Lean.PrettyPrinter).isPrefixOf name &&
      match env.find? name with
      | some info => info.type.getAppFn.constName? == some `Lean.KeyedDeclsAttribute
      | none => false)

-- `globalSyntaxOf` casts each entry of those extensions to
-- `ScopedEnvExtension.Entry` and reads its constructor, and a parser
-- extension entry further to `ParserExtension.OLeanEntry` for its kind.
run_cmd do
  ShapeGuard.checkType "globalSyntaxOf" `Lean.Parser.ParserExtension.OLeanEntry
    "Lean.Parser.ParserExtension.OLeanEntry.token : (explicit val : Lean.Parser.Token) -> Lean.Parser.ParserExtension.OLeanEntry\nLean.Parser.ParserExtension.OLeanEntry.kind : (explicit val : Lean.SyntaxNodeKind) -> Lean.Parser.ParserExtension.OLeanEntry\nLean.Parser.ParserExtension.OLeanEntry.category : (explicit catName : Lean.Name) -> (explicit declName : Lean.Name) -> (explicit behavior : Lean.Parser.LeadingIdentBehavior) -> Lean.Parser.ParserExtension.OLeanEntry\nLean.Parser.ParserExtension.OLeanEntry.parser : (explicit catName : Lean.Name) -> (explicit declName : Lean.Name) -> (explicit prio : Nat) -> Lean.Parser.ParserExtension.OLeanEntry"
  ShapeGuard.checkType "globalSyntaxOf" `Lean.ScopedEnvExtension.Entry
    "Lean.ScopedEnvExtension.Entry.global : (implicit α : Sort) -> (explicit a._@._internal._hyg.0 : #0) -> (Lean.ScopedEnvExtension.Entry #1)\nLean.ScopedEnvExtension.Entry.scoped : (implicit α : Sort) -> (explicit a._@._internal._hyg.0 : Lean.Name) -> (explicit a._@._internal._hyg.0 : #1) -> (Lean.ScopedEnvExtension.Entry #2)"

/-- The value `declare_syntax_cat` gives the quotation parser it defines for a
category (`cat ++ \`quot`, the term parser behind `` `(suffix| …) ``),
spelled as the elaborator spells it — checked identical under v4.35.0-rc3.
A parser so named that is anything else is the author's, not Lean's. -/
def generatedQuotation (cat : Name) (suffix : String) : Expr :=
  let sym (s : String) := mkApp (mkConst ``ParserDescr.symbol) (mkStrLit s)
  let andthen (a b : Expr) := mkApp3 (mkConst ``ParserDescr.binary) (toExpr `andthen) a b
  mkApp3 (mkConst ``ParserDescr.node) (toExpr ``Parser.Term.quot) (mkNatLit Parser.maxPrec) <|
    mkApp3 (mkConst ``ParserDescr.node) (toExpr (cat ++ `quot)) (mkNatLit Parser.maxPrec) <|
      andthen (sym ("`(" ++ suffix ++ "| "))
        (andthen (mkApp2 (mkConst ``ParserDescr.cat) (toExpr cat) (mkNatLit 0)) (sym ")"))

/-- The syntax categories a module declares: a global parser-extension
`category` entry whose declaration is the constant `declare_syntax_cat`
defines for it (`Lean.Parser.Category ++ cat`). A category is registered
globally whatever the scope, and is keyed by its name alone — two records
that both declare `fo` cannot be imported together — so it is reported
apart from `globalSyntax`, for the validator to judge by its name. -/
unsafe def syntaxCategoriesOf (data : ModuleData) : Array Name := Id.run do
  let mut out : Array Name := #[]
  for (extName, entries) in data.entries do
    if (privateToUserName? extName).getD extName == `Lean.Parser.parserExtension then
      for e in entries do
        if let .global a := (unsafeCast e : ScopedEnvExtension.Entry NonScalar) then
          if let .category c d _ := (unsafeCast a : Parser.ParserExtension.OLeanEntry) then
            if d == `Lean.Parser.Category ++ c && !out.contains c then out := out.push c
  return out

/-- Whether a global parser-extension entry is one `declare_syntax_cat`
writes for one of the module's categories: the category itself, its
quotation parser (`generatedQuotation`, compared by value, so a hand-made
`@[term_parser] def <cat>.quot` is not excused; its name is not compared,
since Lean prefixes it with the current namespace when the category is
declared inside one, and the namespace rule judges that name), and that
parser's tokens `` `(suffix| `` and `)`. Verified on v4.35.0-rc3. -/
def isCategoryEntry (env : Environment) (cats : Array Name) : Parser.ParserExtension.OLeanEntry → Bool
  | .category c d _ => cats.contains c && d == `Lean.Parser.Category ++ c
  | .token t => cats.any fun c => match c with
    | .str _ s => t == "`(" ++ s ++ "|" || t == ")"
    | _ => false
  | .parser `term d _ => cats.any fun c => match c with
    | .str _ s => (env.find? d).bind (·.value?) == some (generatedQuotation c s)
    | _ => false
  | _ => false

/-- The syntax extensions a module contributes a *global* entry to. A global
`syntax`, `macro_rules`, or `elab` rewrites every importer — the archive's
generated Challenge included: a `macro_rules` for `theorem` in a concept
package turns `theorem Cert.p : 1 = 2 := sorry` into `Cert.p : True` with
both exports agreeing (spike/axiomfree/namespace-review-20261004.md, E1) —
and two records' global tokens collide for every later author. A record
declares every syntax extension `scoped` or `local` (spec 2). -/
unsafe def globalSyntaxOf (env : Environment) (data : ModuleData) : Array Name := Id.run do
  let cats := syntaxCategoriesOf data
  let mut out : Array Name := #[]
  for (extName, entries) in data.entries do
    let name := (privateToUserName? extName).getD extName
    if isSyntaxExtension env name then
      let global := entries.any fun e =>
        match (unsafeCast e : ScopedEnvExtension.Entry NonScalar) with
        | .global a =>
          -- a syntax node *kind* is registered globally by every `syntax`,
          -- `scoped` or not (kinds are names under the declaring namespace
          -- and clash with nothing); what rewrites an importer is a token,
          -- a parser, or a category — a category and what Lean generates
          -- for it are reported as `syntaxCategories` instead
          if name == `Lean.Parser.parserExtension then
            match (unsafeCast a : Parser.ParserExtension.OLeanEntry) with
            | .kind _ => false
            | entry => !isCategoryEntry env cats entry
          else true
        | .scoped _ _ => false
      if global then out := out.push name
  return out

-- `retargetedSyntaxOf` casts each entry of the macro and elaborator
-- attributes' extensions, global or scoped, to `KeyedDeclsAttribute.OLeanEntry`
-- for the syntax kind it is keyed on; `KeyedDeclsAttribute` itself is guarded
-- so its extension stays the one that persists that entry.
run_cmd do
  ShapeGuard.checkType "retargetedSyntaxOf" `Lean.KeyedDeclsAttribute.OLeanEntry
    "Lean.KeyedDeclsAttribute.OLeanEntry.mk : (explicit key : Lean.KeyedDeclsAttribute.Key) -> (explicit declName : Lean.Name) -> Lean.KeyedDeclsAttribute.OLeanEntry"
  ShapeGuard.checkType "retargetedSyntaxOf" `Lean.KeyedDeclsAttribute
    "Lean.KeyedDeclsAttribute.mk : (implicit γ : Sort) -> (explicit defn : (Lean.KeyedDeclsAttribute.Def #0)) -> (explicit tableRef : (IO.Ref (Lean.KeyedDeclsAttribute.Table #1))) -> (explicit ext : (Lean.KeyedDeclsAttribute.Extension #2)) -> (Lean.KeyedDeclsAttribute #3)"

/-- The syntax kinds a package declares: every `syntax` (and the `notation`,
`macro`, `elab` that expand to one) declares a parser constant named by its
node kind and registers that kind as a global parser-extension entry
(`scoped` or not). The entries alone overcount: a parser registers every
kind it collects, transitively, so `scoped syntax "yy" «term_∈_» : term`
writes core's `«term_∈_»` into the package's olean (the E1 follow-up's
re-review, 2026-10-05). A kind counts only when it is also a constant of
the package — which the namespace rule keeps under the package's own
namespaces, apart from every kind Lean or another record declares. -/
unsafe def declaredSyntaxKindsOf (datas : Array ModuleData) : NameSet := Id.run do
  let mut consts : NameSet := {}
  for data in datas do
    for n in data.constNames do
      consts := consts.insert n
  let mut out : NameSet := {}
  for data in datas do
    for (extName, entries) in data.entries do
      if ((privateToUserName? extName).getD extName) == `Lean.Parser.parserExtension then
        for e in entries do
          let a : NonScalar := match (unsafeCast e : ScopedEnvExtension.Entry NonScalar) with
            | .global a => a
            | .scoped _ a => a
          if let .kind k := (unsafeCast a : Parser.ParserExtension.OLeanEntry) then
            if consts.contains k then out := out.insert k
  return out

/-- The syntax kinds a module keys a macro or elaborator on — global or
`scoped` — that its package does not declare. A `scoped macro_rules` for
core's `∈` retargets the existing syntax inside the package's namespace, so
a statement whose source reads `3 ∈ NP` elaborates to `True`
(spike/axiomfree/ultracode-review-20261004.md, E1 follow-up). A `local`
rule is not persisted and cannot be seen here; it shows only in the
statement's elaborated body. -/
unsafe def retargetedSyntaxOf (env : Environment) (data : ModuleData) (declared : NameSet) :
    Array Name := Id.run do
  let mut out : Array Name := #[]
  for (extName, entries) in data.entries do
    let name := (privateToUserName? extName).getD extName
    if name != `Lean.Parser.parserExtension && isSyntaxExtension env name then
      for e in entries do
        let entry : KeyedDeclsAttribute.OLeanEntry :=
          match (unsafeCast e : ScopedEnvExtension.Entry NonScalar) with
          | .global a => unsafeCast a
          | .scoped _ a => unsafeCast a
        if !declared.contains entry.key && !out.contains entry.key then
          out := out.push entry.key
  return out

def usage : IO UInt32 := do
  IO.eprintln "usage: laxinspector --spec <1|2> <out.json> <module> [<module>...]"
  return 1

unsafe def main (args : List String) : IO UInt32 := do
  let (spec, outPath, mods) ←
    match args with
    | "--spec" :: "1" :: outPath :: mods@(_ :: _) => pure (1, outPath, mods)
    | "--spec" :: "2" :: outPath :: mods@(_ :: _) => pure (2, outPath, mods)
    | _ => return (← usage)
  initSearchPath (← findSysroot)
  let modNames := mods.map String.toName
  let imports := modNames.toArray.map fun m => ({ module := m } : Import)
  let env ← importModules imports {} (trustLevel := 1024) (loadExts := false)

  let allNames := env.header.moduleNames
  let datas := env.header.moduleData
  let matchers := matcherNamesOf datas
  -- the tag is read only when the environment's spec has it: the spec-1
  -- report must not change, and reading it is harmless but not free
  let laxStatements := if spec == 2 then laxStatementsOf datas else {}
  -- One name representation, both specs (ultracode review 2026-10-04, C3):
  -- Lean's escaped `Name.toString`, which reads back through `String.toName`
  -- (`isCanonicalName`); the validator compares names as printed, and the
  -- certificate generator writes them as recorded (certify/lean-name.ts).
  let nameStr (n : Name) : String := n.toString
  let mut idxMap : Std.HashMap Name Nat := {}
  for i in [0:allNames.size] do
    idxMap := idxMap.insert allNames[i]! i

  -- Only package-local references are useful to the unused-helper check.
  -- Filtering here prevents ubiquitous Mathlib dependencies from inflating
  -- the untrusted JSON report.
  let mut packageNames : NameSet := {}
  let packageDatas := modNames.toArray.filterMap fun m => idxMap[m]?.map (datas[·]!)
  -- the syntax kinds the package's own modules declare, for the spec-2
  -- retargeting fact
  let declaredKinds := if spec == 2 then declaredSyntaxKindsOf packageDatas else {}
  -- and the declarations they register as instances, for the unused-helper
  -- check
  let instances := if spec == 2 then instancesOf packageDatas else {}
  for m in modNames do
    if let some idx := idxMap[m]? then
      for declName in datas[idx]!.constNames do
        packageNames := packageNames.insert declName

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
    let importsJson := Json.arr <| data.imports.map fun imp => Json.str (nameStr imp.module)
    let moduleDocs := moduleDocsOf data
    let declarationRanges := declarationRangesOf data
    let moduleDocsJson := Json.arr <| moduleDocs.map fun d => jsonOfParsedDoc (parseDoc d.doc)
    -- the module-level spec-2 facts: the syntax extensions this module
    -- registers globally; the declarations it marks `@[init]` are flagged
    -- per declaration below
    let globalSyntax := if spec == 2 then globalSyntaxOf env data else #[]
    let retargetedSyntax := if spec == 2 then retargetedSyntaxOf env data declaredKinds else #[]
    let syntaxCategories := if spec == 2 then syntaxCategoriesOf data else #[]
    let initializers := if spec == 2 then initializersOf data else {}
    moduleJsons := moduleJsons.push <| Json.mkObj <|
      [("name", Json.str (nameStr m)),
       ("imports", importsJson),
       ("moduleDocs", moduleDocsJson),
       ("declCount", toJson data.constNames.size)] ++
      (if spec == 2 then [("globalSyntax", Json.arr (globalSyntax.map fun n => Json.str (nameStr n))),
                          ("retargetedSyntax", Json.arr (retargetedSyntax.map fun n => Json.str (nameStr n))),
                          ("syntaxCategories", Json.arr (syntaxCategories.map fun n => Json.str (nameStr n)))] else [])

    -- the module's own constants, as its olean stores them: `env.find?`
    -- would return the merged environment's copy, which for a theorem two
    -- modules both declare is the later module's (`AxiomCacheCtx`)
    let mut localMap : Std.HashMap Name ConstantInfo := {}
    for i in [0:data.constNames.size] do
      localMap := localMap.insert data.constNames[i]! data.constants[i]!
    let ctx : AxiomCacheCtx := { env, «local» := localMap }
    axiomCache := { axiomCache with localSeen := {} }
    for declName in data.constNames do
      let some ci := localMap[declName]?
        | IO.eprintln s!"constant {declName} of module {m} not found"
          return 2
      let (axioms, axiomCache') := axiomsOfCached ctx axiomCache declName
      axiomCache := axiomCache'
      let usedConstants := (usedConstantsOf ci).toArray
        |>.filter packageNames.contains
        |>.qsort Name.lt
      let doc? ← findDocString? env declName
      let parsed? := doc?.map parseDoc
      let mut fields : List (String × Json) :=
        [("name", Json.str (nameStr declName)),
         ("kind", Json.str (kindOf ci)),
         ("module", Json.str (nameStr m)),
         ("axioms", Json.arr (axioms.map fun a => Json.str (nameStr a))),
         ("usedConstants", Json.arr (usedConstants.map fun n => Json.str (nameStr n)))]
      -- spec 2 flags a name that does not read back (`isCanonicalName`);
      -- spec 1 is untouched
      if spec == 2 && !isCanonicalName declName then
        fields := fields ++ [("nonCanonical", Json.bool true)]
      -- `userName` is the display name: the spec's user-level reading, and
      -- nothing a rule branches on. Where a declaration came from is
      -- `origin`, one fact with its evidence (`Origin`).
      if let some u := userLevelName? env matchers declName then
        fields := fields ++ [("userName", Json.str (nameStr u))]
      if spec == 2 then
        fields := fields ++ [("origin", jsonOfOrigin (originOf env matchers packageNames declarationRanges declName))]
      if initializers.contains declName then
        fields := fields ++ [("initializer", Json.bool true)]
      if instances.contains declName then
        fields := fields ++ [("instance", Json.bool true)]
      -- the full range, start and end, as positions: the unused-helper rule
      -- (phases/inspect.ts) asks whether one declaration lies inside
      -- another's, and two declarations can share a line — a definition and
      -- an unrelated theorem written side by side — so a line alone cannot
      -- answer it. Columns count codepoints from 0, as `Lean.Position` does.
      if let some ranges := declarationRanges.find? declName then
        fields := fields ++ [
          ("startLine", toJson ranges.range.pos.line),
          ("endLine", toJson ranges.range.endPos.line),
          ("startColumn", toJson ranges.range.pos.column),
          ("endColumn", toJson ranges.range.endPos.column)]
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
            cf := cf ++ [("originModule", Json.str (nameStr om))]
          fields := fields ++ [("conclusionFacts", Json.mkObj cf)]
      let isAxiom := match ci with | .axiomInfo _ => true | _ => false
      let tagged := spec == 2 && laxStatements.contains declName
      -- the pretty-printed type: of every axiom (the spec-1 statement) and,
      -- under spec 2, of every tagged declaration (for the statement's
      -- signature, and for the finding when it is not `Prop`)
      if isAxiom || tagged then
        let sig ← ppType env ci.type
        fields := fields ++ [("signature", Json.str sig)]
      if spec == 2 then
        let type := ci.type
        let isProp := match type.consumeMData with
          | .sort .zero => true
          | _ => false
        fields := fields ++ [
          ("laxStatement", Json.bool tagged),
          ("isProp", Json.bool isProp),
          ("levelParams", Json.arr (ci.levelParams.toArray.map fun n => Json.str n.toString)),
          ("telescope", jsonOfTelescope (telescopeOf type))]
        if tagged then
          fields := fields ++ [("binders", toJson (leadingBinders type))]
          if let .defnInfo v := ci then
            let body ← ppType env v.value
            fields := fields ++ [("body", Json.str body)]
      declJsons := declJsons.push (Json.mkObj fields)

  let report := Json.mkObj
    [("modules", Json.arr moduleJsons),
     ("declarations", Json.arr declJsons)]
  IO.FS.writeFile outPath (report.pretty 100)
  return 0
