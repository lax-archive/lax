# The Concept Dialect

This document is a normative companion to [spec.md](spec.md). It specifies
the **concept dialect**: the subset of Lean that concept packages must be
written in, and the gate that enforces it. Its purpose is a safety property
the archive currently lacks: today, building a submission locally means
elaborating the concept packages of every upstream submission, and
elaborating Lean is running code — so users must trust other submitters not
to ship malicious code. The dialect closes this by design: concept packages
become safe to compile because the language they are written in cannot
express the attack.

spec.md's Decisions section records an earlier version of this dialect,
dropped for the MVP because its stakes were only editorial ("unreadable, not
unsound") and enforcing it "needs a parser, and it is the only thing that
does." Both conclusions stand; the stakes have changed. The rule is now a
security boundary, and the parser earns its keep.


## Motivation and Threat Model

**Elaboration is code execution.** Compiling a Lean module does far more
than type-check it. A `macro` or `elab` registers author code that runs on
every later use of the syntax it claims. An `initialize` block runs
arbitrary IO the moment the module is *imported* — before any command of the
importing file elaborates. `#eval`, `run_cmd`, and `run_elab` run IO during
elaboration itself. The `native_decide` tactic compiles a proposition to
native code and executes it mid-proof. `include_str` reads any file the
build can see into the module. The attributes `@[init]`, `@[implemented_by]`,
and `@[extern]` attach executable code to otherwise innocent declarations.
None of this is exotic: it is ordinary, documented Lean, available to every
module mathlib's toolchain compiles.

**The threat.** A submitter publishes a concept package containing any of
the above. Every downstream author who requires it — or requires anything
that transitively requires it — executes that code on their own machine the
next time `lake build` runs, with the author's own filesystem and network.
The server is already protected (its pipeline runs sandboxed, precisely
because it assumes Compile runs attacker code); the users building locally
are not. Asking them to audit upstream Lean for elaboration-time attacks is
not a defense — the vectors above are easy to hide and hard to grep for.

**The artifact channel.** Source is not the only carrier. Compiled `.olean`
files embed environment extensions — parser state, macros, initializer
metadata — and *loading* them may run the interpreter (Lean documents this
explicitly). Replay does not authenticate that layer: `leanchecker` rechecks
kernel declarations, not persisted extensions. So any pipeline step that
lets unrestricted code write an artifact that is later loaded as trusted —
by the gate, or by a downstream build — reopens at the binary level the
hole the dialect closes at the source level. The Artifact provenance rules
below exist for this vector.

**Non-goals.** Three exclusions, each deliberate:

- **Resource exhaustion.** A dialect-clean concept can still make
  elaboration diverge or eat memory — a typeclass loop, a huge `decide`,
  deep reduction. The guarantee covers capability, not termination: Lean's
  default `maxHeartbeats` bounds the common cases, and a build that hangs is
  an annoyance the user can kill, not a compromise. The residual risk is
  accepted and documented here.

- **Proof packages.** Proofs need full Lean — they are written largely by AI
  agents wielding heavy tactics and metaprogramming, and restricting them
  would gut the archive's core bet that proof-writing can be outsourced.
  Proof packages therefore stay unrestricted, and the guarantee covers them
  by refusal rather than by dialect: see Foreign proof packages below.

- **Soundness.** The dialect adds nothing to the archive's validity story —
  Replay, the trusted artifact store, and the axiom rules own that entirely
  (see spec.md, Build Pipeline). The dialect is about the safety of
  *running* a compile, an orthogonal property: a submission could be
  perfectly sound and still hostile to build, or dialect-clean and wrong.


## The Guarantee and Its Trust Base

The property the dialect buys:

> **Under a default `lax build`, content from other submitters is data,
> never code: parsed, elaborated, and reduced by the pinned trusted
> toolchain, it acquires no capability of its own — no IO, no filesystem
> or network access, no native code, no registered elaborators.**

This is deliberately a confinement claim, not an absence-of-computation
claim: trusted elaborators do evaluate foreign definitions — a `decide`
reduces them, the kernel unfolds them — and that is inside the guarantee.
Foreign definitions may cost time, never capability, which is also what
makes the resource-exhaustion non-goal coherent.

The argument has three legs, each enforced, none assumed:

1. **The dialect admits no capability.** No schema-admissible construct
   registers or embeds author code (Design Principle below), so elaborating
   dialect-clean source runs only the pinned trusted background: Lean core,
   the toolchain, mathlib.
2. **Every foreign source is verified, and the verdict is recorded.** The
   server gates every submit, and Resolution admits a dependency only if a
   passing verdict is on record — a fact checked on every build, not a
   one-time migration assumption.
3. **Every foreign artifact descends from its verified source.** Stored
   concept artifacts are captured before any unrestricted code could touch
   them and carry a provenance binding, so what a build or the gate loads
   is a pure function of gated source and the pinned toolchain.

**Enforcement point.** The server runs the dialect gate on **every
submit** — draft and registration alike — as a pipeline phase between
Provision and Compile, inside the sandbox. A dialect violation is a pipeline
violation like any other: collected, reported, and fatal to the submit. A
submit that passes records a **dialect verdict** — pass, together with the
schema version it passed (see Design Principle) — on the submission record,
learned by clients through the database clone like everything else.
Resolution admits a dependency only when its record carries a passing
verdict at a valid schema version; a submission that predates the dialect,
or failed re-verification, simply has no verdict and is refused as a
dependency with a violation naming it, whatever its other standing. This
closes the induction over drafts as well as registrations — drafts are
admissible dependencies of other drafts, so they are inside the boundary,
not grandfathered around it. Verdict validity across schema changes: growth
keeps every earlier verdict valid; a shrink voids all of them (Evolution).

**Artifact provenance.** Leg 3 needs its own rules, because nothing else
supplies it: if concepts and proofs compile in one writable job tree and
the concept oleans are extracted only after both builds finish, a malicious
proof build — unrestricted by design — can overwrite its sibling concept
oleans with forged ones (for instance, by invoking Lean on generated source
that reproduces the original declarations plus an `initialize`) that replay
clean, because Replay authenticates kernel declarations only, yet carry
executable environment extensions that run in every later gate or
downstream build that loads them. Normative rules:

- **Capture isolation.** The server extracts the concept package's oleans
  after the concept build completes and **before the proof build starts** —
  concretely, Compile becomes two sandboxed invocations with the extraction
  between them; any equivalent isolation (disjoint build trees) also
  satisfies the rule. The proof build may still scribble over its copy of
  the concept artifacts; nothing reads them afterwards. Replay, capture,
  and the store then see only artifacts that are a pure function of gated
  source, the pinned toolchain, and trusted store inputs.
- **Provenance binding.** Every store entry records the dialect schema
  version, toolchain, and source commit that produced it — a small metadata
  file beside the artifacts — so an entry is checked against its
  submission record, when it is placed on a job's trusted search path,
  rather than trusted by location. A mismatch is a server-side integrity
  failure, fatal to the job.
- **Destination.** The recorded optimization path — the gate becomes the
  authoritative concept compiler, its elaboration output captured directly
  — subsumes capture isolation and remains where this design is headed.

**Locally**, the gate runs on the submission's *own* concept package as
author feedback — so `lax build` catches a dialect violation before the
server rejects it — not as a safety measure: authors trust their own code,
and the safety of dependencies comes from the server gate above.

**Foreign proof packages.** The dialect cannot cover proof packages (see
Non-goals), so requiring another submission's proof package — already legal
but discouraged and warned about — would still compile unrestricted foreign
code locally. The rule: **`lax build` refuses to build a workspace whose
compilation closure contains a foreign proof package unless the author
passes `--allow-foreign-proofs`.** The normative shape of the check:

- **When:** during local Resolution — before Provision and before any
  `lake` invocation. A refusal computed after the first `lake build` would
  arrive after the code already ran.
- **What:** the transitive dependency closure of the packages this
  invocation will compile. Direct requires come from the workspace
  lakefiles; the rest of the closure is walked through the recorded
  build-outputs in the local database clone (`requiredByConcepts` /
  `requiredByProofs`) — the same walk the server uses to assemble trusted
  dependency paths. Direct requires alone are not enough: a foreign proof
  package can itself require further proof packages.
- **Fail closed:** a closure member whose record or build-output is missing
  locally blocks the build with the stale-database hint (`lax pull-db`) —
  it is never treated as a pass.
- **The refusal** names every foreign proof package in the closure and the
  flag.
- **Scope interaction:** the closure is that of the packages actually
  compiled. Concept packages may require only concept packages (spec.md,
  Dependencies), so a foreign proof package enters only through the proof
  package's requires: `lax build --only concepts` compiles no proof package
  and cannot trip the refusal, by design; the default build and `--only
  proofs` cover the full closure. The guarantee quantifies over the default
  build.

The existing warning stays; the server is unaffected (its pipeline is
sandboxed regardless). The guarantee above is exactly the default-flag
case: an author who opts in has chosen to trust those specific submitters,
explicitly and per-build.

**Trust base.** The guarantee rests on the archive server having run the
gate and recorded the verdicts and provenance — all learned through the
database clone, the same trust users already place in every registered
`build-output.json`. It does not rest on other submitters, which is the
point. The recorded upgrade path, should a smaller base become worth its
cost: `lax build --verify-deps`, re-running the gate over dependency
*sources* locally (which requires lax to fetch them before Compile and
check them in dependency order), shrinking the base to the lax binary, the
toolchain, and pinned mathlib. Not specified normatively here.

**Evolution.** The schema is expected to grow — a missing tactic or
attribute that authors legitimately need is added by amendment, which is
backward compatible: every recorded verdict stays valid. Shrinking the
schema invalidates previously accepted content and is a ``specVersion``
bump: all verdicts are void and re-verification reruns. On adoption, the
server re-verifies **every content-bearing submission — drafts included**:
drafts are admissible dependencies of other drafts and their artifacts
enter the store on the same terms as registrations, so leaving them outside
the induction would leave the hole open. Passing submissions get verdicts
stamped. A failing draft is quarantined: kept, but verdict-less and
therefore refused as a dependency until resubmitted. A failing registered
submission keeps its registration and citability — its validity is Replay's
property and untouched — but is likewise refused as a dependency until an
amendment covers it. The expected number of failures is zero, because the
schema should be grown against the existing corpus before adoption; the
quarantine semantics exist so the induction never has to rest on that
expectation. The archive is small enough that re-verification is a batch
job, not a migration project.


## Design Principle: A Contextual Schema, Fail Closed

The gate parses each concept module with Lean's own parser — the one the
pinned toolchain ships — and walks the **entire** syntax tree of every
command. But a bare set of admissible syntax kinds cannot express the
dialect: an option name, an attribute name, a deriving class all sit inside
generic kinds (`set_option` is one kind whether the option is
`pp.deepTerms` or `debug.skipKernelTC`). The whitelist is therefore a
**schema**, two rules deep:

1. **Kinds, stratified by syntax category.** Each category the dialect
   admits carries its own closed kind list: commands, declaration
   modifiers, tactics, conv tactics, attribute positions. Fail closed per
   category: a kind not listed for the category in which it appears is a
   violation, never a guess — the same philosophy as the frontmatter
   grammar (spec.md, Annotations). Syntax the schema has never heard of — a
   construct from a future mathlib revision, an extension this spec forgot
   — is rejected by default rather than admitted by oversight.

2. **Payloads, validated in position.** Kinds whose children *name trusted
   code to invoke* are checked by content in their grammatical position:
   the option name of a `set_option`, the attribute names inside `@[...]`
   and the `attribute` command, the class names of a `deriving` clause.
   The schema records these as per-position name lists or prefix rules
   (e.g. `pp.*`), failing closed exactly like kinds; each whitelisted
   tactic and attribute entry also names which argument sub-syntax it
   admits (priorities, `(config := ...)` payloads — the latter are ordinary
   terms and are walked as terms).

The schema is fully **static**: because the dialect admits no syntax
declarations of any sort — not even notation (see Notation) — a verified
module registers no parser extension, so no kind ever needs to be admitted
mid-run or classified by who declared it. Every parser extension present in
a gate environment originates from the pinned trusted background, by
construction.

**The term category is the one deliberate non-enumeration.** Command,
tactic, attribute, option, and deriving positions are extension points —
places where a name selects code to run — and stay closed lists. Term-
category syntax registered by the pinned trusted background (core and
mathlib) is instead admitted *by origin*, minus an explicit ban list.
Mathlib registers thousands of term-level notations that are pure pattern
expansions performed by trusted elaborators; enumerating them buys no
security (they are inside the trust base already) and costs schema churn on
every pin bump, while the core term forms that *do* embed capability are
few and nameable — syntax quotations, `include_str` — and the schema bans
them explicitly (see Terms). The honest summary: **fail closed at every
position where author code could attach; origin-trusted at positions that
only select data paths through pinned trusted code, with the exceptions
named in the schema.** Every mathlib pin bump is a schema review: the term
ban list is re-audited against the new revision.

**The schema is the normative surface.** This document motivates the rules
and names their reasons; the checked artifact is a versioned,
machine-readable schema file (`dialect-schema`, shipped with the CLI source
beside the gate and compiled into it), carrying the `dialectVersion` that
verdicts record. Where the prose says a family ("the `pp.*` options", "the
search tactics"), the schema says the exact prefix rule or list; nested
grammars — conv tactics, tactic configuration payloads — are schema entries
like everything else. A divergence between prose and schema is a bug in one
of them, resolved by amendment — never by letting the implementation
silently become the specification.

**The soundness induction.** The schema admits no construct that registers
author code: no `macro`/`elab`/`syntax`, no `initialize`, no code-attaching
attributes. So when a dialect-clean module elaborates, every piece of code
that runs — every command elaborator, tactic, deriving handler, attribute
handler — is trusted code from core or mathlib, pinned by the archive
environment. Author input reaches that trusted code only as syntax and
kernel terms: data to process, never code to call. The induction extends
across imports: a dialect-clean module may import only mathlib and other
concept modules (spec.md's import rule), and those are dialect-clean by the
same gate, so importing them runs no author initializers and loads no
author parser extensions — a verified module registers nothing at all; its
olean contributes declarations and entries in trusted extensions (an
`@[simp]` registration, an instance priority), data throughout.

One side effect worth stating: a syntactic gate enforces the *editorial*
dialect for free. Concepts carry no proofs, so `theorem` has no place in a
concept module — a rule spec.md could only state, because it is invisible to
the environment (a `structure` generates theorem-kind declarations, an
`example` leaves no trace). The gate sees the source, so the rule is now
checked. This resolves the "enforced later" of spec.md's Decisions entry.


## The Dialect (Rationale; the Schema Is Normative)

The rules below name surface constructs and record the reasons; the
exhaustive, versioned boundary is the dialect schema (Design Principle).
The ban lists are the *reasons* recorded for the bans authors are most
likely to hit, not the boundary — everything off-schema is banned by
default.

The dialect applies to every module of the concept package, including the
root module (whose own rules already restrict it to imports). The proof
package is untouched: full Lean.

### Module structure

Allowed: `import` (governed by the existing import rule, unchanged, but
checked by the gate on the source header *before* anything loads — see The
Gate), the single module docstring, `namespace`/`end`, `section`, `open` in
all its forms (including `open scoped` and `open ... in`), `variable`,
`universe`, `export`, and `set_option` (command and `... in` forms) for
whitelisted options only.

Banned: the module-system and prelude header forms — `module`, `prelude`,
`public import`, `meta import`, `import all` — concept modules speak plain
`import` only. `#eval`, `#check`, `#print`, and the other diagnostic
commands — `#eval` runs code; the rest are harmless but are residue, not
content, and whitelisting residue buys nothing. (This tightens spec.md's
root-module remark that "a stray `#check` is tolerated": inside the concept
package it no longer is.) Also banned: `run_cmd`, `run_elab`, `initialize`,
`builtin_initialize` — elaboration- and import-time IO — and
`attribute [...]` applications of non-whitelisted attributes.

### Declarations

Allowed: `def`, `abbrev`, `structure` (with `extends` and `where`),
`inductive`, `class`, `class inductive`, `instance`, `axiom`; the modifiers
`private`, `protected`, `noncomputable`; `deriving` clauses (and the
standalone `deriving instance` command) for a whitelisted class list —
initially `Repr`, `DecidableEq`, `Inhabited`, `Fintype`, `BEq`, `Hashable`.
Deriving handlers are trusted code, but the handler set is extensible
machinery, so the class list is a payload rule like everything else.

Banned:

- `theorem`, `lemma`, `example` — concepts declare statements, they do not
  prove or exercise them; the editorial rule, now enforced. Proof *terms*
  still appear inside definitions where the mathematics requires them
  (instance fields, subtype members, `decreasing_by`) — the rule bans the
  commands, not propositions.
- `unsafe` — opts out of the kernel and into compiled execution.
- `partial` — safe (nothing executes) but opaque: a partial definition
  cannot be unfolded, so nothing can be proven about it, which makes it an
  anti-concept. Excluded for cleanliness, not safety; addable by amendment
  if a genuine use appears.
- `macro`, `macro_rules`, `elab`, `elab_rules`, `syntax`,
  `declare_syntax_cat` — the author-code registration vectors; see Notation.

### Notation

Banned — all of it, for the WIP. The `notation` family (`notation`,
`infix`, `infixl`, `infixr`, `prefix`, `postfix`, with their `scoped` and
`local` variants) came closest to admission: a notation's expansion is a
data-driven pattern produced and applied by core's own elaborator — the
author supplies the shape, core supplies all the code — so it adds no
capability. It is pruned anyway, because admitting it would cost the gate
its best structural property: Lean compiles a `notation` command into a
generated `syntax` declaration plus `macro_rules` under a *dynamically
generated* syntax kind, so uses of legal notation could never appear on any
fixed list — the gate would have to track kinds minted mid-run and across
imports, and tell author-minted kinds from background ones. Banning it
keeps the schema fully static and the induction blunt: a verified module
registers no parser extension whatsoever. Concepts still *use* every
notation the trusted background provides (see Terms); they cannot declare
new ones.

Reintroducing the notation family is the expected first amendment once the
WIP settles — growth is backward compatible (Evolution) — and the mechanism
is recorded so the amendment is an unpruning, not a redesign: the guarded
frontend folds the kinds a validated notation command registers into a
per-run dynamic whitelist, keyed on the declaring module for imports.

Also banned, and staying banned: everything that takes author code from
syntax to meaning — `syntax`, `declare_syntax_cat`, `macro`, `macro_rules`,
`elab`, `elab_rules`. A macro is author code executed on every use site,
which is exactly the capability the dialect exists to remove. Mathlib's
`notation3` is off the list on the same terms as the notation family.

### Terms

Allowed: ordinary term syntax — application, lambdas, `fun`/`match`/`let`/
`if`/`calc`/`show`/`have`/`suffices`, anonymous constructors, structure
instances, literals, type ascriptions, `by` (see Tactics) — plus, by the
origin rule (Design Principle), any term-category notation registered by
the pinned trusted background.

Banned — the named exceptions to the origin rule: syntax quotations and
antiquotations (`` `( ) ``) — meaningless without macros and elabs, so
their presence is at best confusion; `include_str` — reads files at
elaboration time into the artifact. References to `unsafe` declarations
(`unsafeCast` and friends) need no gate rule and get none: Lean itself
rejects safe code that references unsafe declarations, and with `#eval` and
`native_decide` off the schema nothing in a concept module evaluates
compiled code — an identifier-level ban would add name-resolution
fragility, not safety.

### Tactics

`by` blocks are allowed; every tactic inside them must be on the whitelist.
Tactics are trusted mathlib/core code, but they are also the most open-ended
extension point Lean has, so the dialect names the admissible set rather
than betting that no current or future tactic has side effects. The initial
whitelist, chosen to cover the proofs that legitimately appear inside
concepts (instance fields, `termination_by`/`decreasing_by`, subtype
members, small `Fact`s):

- closers: `rfl`, `decide`, `trivial`, `assumption`, `exact`, `contradiction`,
  `infer_instance`, `omega`, `norm_num`, `ring`, `linarith`, `nlinarith`,
  `positivity`, `tauto`, `aesop`
- structure: `intro`, `intros`, `rintro`, `apply`, `refine`, `constructor`,
  `use`, `exists`, `cases`, `rcases`, `obtain`, `induction`, `by_cases`,
  `exfalso`, `have`, `show`, `let`, `suffices`, `calc`, `split`, `case`,
  `next`, `focus`, `skip`
- rewriting: `rw`, `rewrite`, `simp`, `simpa`, `simp_all`, `unfold`,
  `norm_cast`, `push_cast`, `conv`
- extensionality and combinators: `ext`, `funext`, `all_goals`,
  `any_goals`, `first`, `try`, `repeat`, `<;>`
- recursion bookkeeping: `termination_by`, `decreasing_by`,
  `decreasing_with`

`conv` opens its own syntax category, so the schema carries a separate
conv-tactic list — initially `enter`, `lhs`, `rhs`, `ext`, `pattern`,
`rw`, `simp`, `unfold`, `norm_num`, `ring_nf`, `change`, `congr`, `skip`,
`rfl`, and the combinators above. Configuration and named-argument payloads
of whitelisted tactics are ordinary terms, walked as terms; each schema
entry names the argument forms it admits.

Banned, with the motivating reasons: `native_decide` — compiles the goal to
native code and runs it, the single sharpest vector in tactic position (its
`ofReduceBool` axiom is already banned, but the axiom check runs *after* the
code did; the dialect rejects it before); `polyrith` — built around an
external web service that is shut down at the pinned mathlib revision, so
today the tactic only throws; it stays banned as unavailable residue and as
the standing example of the class the tactic whitelist exists to exclude,
tactics that reach outside the elaborator; `run_tac` and `tactic'` — escape
hatches into arbitrary tactic monad code; `exact?`, `apply?`, `hint` and
the other search tactics — residue of interactive development, not content.

### Attributes

Allowed (in `@[...]` position and via the `attribute` command): `simp`,
`ext`, `coe`, `norm_cast`, `push_cast`, `symm`, `trans`, `refl`, `congr`,
`simps`, `reducible`, `irreducible`, `inline`, instance priorities
(`instance` / `default_instance` and priority annotations). All are trusted
registration or lemma-generation code operating on the declaration as data.
Attribute names are payloads validated in position (Design Principle, rule
2): `@[...]` and `attribute` share generic syntax kinds, so the per-position
name list, not the kind, is what admits them, and each entry names its
admissible arguments.

Banned, with reasons: `init` — runs a function at import time, `initialize`
in attribute clothing; `implemented_by` and `extern` — attach executable
code to a declaration, splitting what the kernel checked from what runs;
`export` (the attribute) — C-level symbol export, meaningless for a concept
and adjacent to `extern`.

### Options

`set_option` is allowed for a schema-listed set: the prefix rules `pp.*`
(display) and `linter.*` (hygiene) — recorded in the schema as exactly
those two prefixes — plus `maxHeartbeats` and `maxRecDepth`. Raising
`maxHeartbeats` is admissible because resource exhaustion is out of scope
(see Non-goals); an author with a heavy `decide` may pay for it. Everything
else is banned by default — notably `debug.*` (e.g.
`debug.skipKernelTC`, harmless post-Replay but pure residue) and
`compiler.*`.


## The Gate

The gate is a lax-owned Lean executable, a sibling of the inspector: pinned
to the archive toolchain, shipped with the CLI as source, compiled once per
CLI version into `~/.lax/tools/`, and reused (see spec.md, Inspection
Scaffolding — the build and caching machinery is the same). Like the
inspector it decides nothing: it reports each off-schema node as a fact —
module, position, offending syntax kind or payload — and the CLI, sole
emitter of violations, judges. Unlike the inspector it reads *source*,
because the dialect is a source-surface property: spec.md's Decisions entry
proves it cannot be an environment property (a `structure` generates
theorem-kind declarations while `example` and `set_option` leave no trace),
so this document deliberately amends the "pipeline never parses Lean"
invariant. The amendment is narrow: the parser is Lean's own, pinned by the
toolchain, and the pipeline still never *interprets* what it parses — the
gate matches syntax against the schema and elaborates nothing off-schema.

**Mechanism: a guarded frontend.** Modules are processed in dependency
order derived from the module inventory and the parsed import headers. Per
module, normatively:

1. **Header first, before anything loads.** The gate parses the module
   header *without importing anything* and validates it: the only
   admissible header form is plain `import` (no `module`, `prelude`,
   `public import`, `meta import`, `import all`), and every import target
   must lie within pinned mathlib, the concept package's own inventory, or
   the resolved dependency set — the existing import rule, but checked
   here on the source, because loading a disallowed import is already
   execution. This step is normative, not an implementation detail implied
   by dependency ordering: environments are constructed only after the
   header passes.
2. **Then the guarded loop.** Parse one command, walk its full syntax tree
   against the schema — kinds per category, payloads in position — and
   only if every node passes, elaborate it; then parse the next.

The gate refuses *before* elaborating any off-schema command, so by the
soundness induction, everything the gate itself executes is trusted code.
Elaboration is not optional bookkeeping even with author notation banned:
it is what maintains the scope state — `namespace`, `open` (including
`open scoped`, which activates trusted notation for the parser),
`variable`, `set_option` — that later commands need to parse and elaborate
as Lean intends.

**Server placement.** A new pipeline phase between Provision and Compile,
run inside the sandbox like every Lean-adjacent phase. Its imports resolve
against the warm mathlib workspace and the trusted store's dependency
artifacts — which exist before Compile runs, captured when each dependency
was itself submitted. Loading those artifacts loads their environment
extensions, which may run the interpreter — this is precisely why the gate
may load only store entries whose provenance the capture-isolation rule
guarantees (see Artifact provenance): dialect-clean source cannot have put
executable extensions there. The cost is that concept packages elaborate
twice, once in the gate and once under `lake build`. Concepts are small and
the dominant cost is loading the mathlib environment, so this is
acceptable; making the gate the authoritative concept compiler is the
recorded optimization path (and subsumes capture isolation).

**Local placement.** `lax build` runs the gate on the submission's own
concept package. It is advisory (see Trust Base), so it needs no particular
ordering guarantee; running it against the compiled workspace after
Compile, the way Inspect runs, is fine and lets it resolve imports without
special provisioning.


## Relation to spec.md

This document is written as an amendment set; spec.md is reconciled
manually. The touch points:

- **Decisions / "Concept dialect enforcement"** — superseded: the dialect
  is enforced, the parser exists, and the stakes are security, not
  editorial. The entry's reasoning (the whitelist cannot be an environment
  check) is incorporated above. The rejected plugin route stays rejected —
  the gate is a separate trusted executable, per the same reasoning as
  in-process inspection.
- **Build Pipeline** — a new phase, Dialect, between Provision and Compile
  (server-mandatory on every submit; local run advisory on the own concept
  package); server Compile splits into two sandboxed invocations with the
  concept-artifact extraction between them (Artifact provenance); and the
  "pipeline never parses Lean" statement in Inspection Internals gains the
  narrow exception above.
- **Archive Server / trusted store** — store entries gain the provenance
  binding (dialect schema version, toolchain, source commit).
- **Build Pipeline / Resolution** — admits a dependency only with a
  recorded passing dialect verdict; local Resolution grows the transitive
  closure walk over recorded build-outputs and hosts the foreign-proof
  refusal, pre-Provision.
- **Submissions / records** — the record schema gains the dialect verdict
  (pass + schema version).
- **Packages / Dependencies** — the warning on requiring foreign proof
  packages becomes a local-build refusal absent `--allow-foreign-proofs`,
  computed transitively before any `lake` invocation.
- **Packages / Root modules** — the "stray `#check` is tolerated" remark no
  longer holds inside the concept package; the gate rejects it.
- **CLI / lax build** — the `--allow-foreign-proofs` flag; `--verify-deps`
  reserved as the recorded upgrade path.
- **Concepts** — the section gains the dialect by reference to this
  document.
