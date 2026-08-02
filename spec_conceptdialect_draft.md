# The Concept Dialect — second draft

**Status: draft, 2026-07-29** (revised twice the same day, after two
rounds of review). A
proposed replacement for [spec_conceptdialect.md](spec_conceptdialect.md),
rewritten after the first real submissions existed and sized against the
actual corpus — nine submissions (Lax1–Lax15), ~4,800 lines of concept
source. Two decisions from the review shape this revision: the tactic
list shrinks to closers only (the corpus is restructured to match, see
`lax-submissions/plans/submission-polish.md`), and **the dialect is
advisory, not blocking**: "safe dialect" is a label the archive computes
and displays, a moving target that can be tightened or grown freely —
never a gate that refuses a submission. A second review then found a hole
both drafts shared — `autoParam`, which selects a tactic from a *data*
value that no list of syntax forms can see — and this revision closes it
with a second axis, the mention rule (list 8). Not normative until
reconciled; until then spec_conceptdialect.md stands, hole included.

Part I defines the dialect and is written to be checkable by a reader who
does not know Lean. Part II is the machinery — the gate, the verdicts,
the artifact rules.


# Part I — The Dialect

## What the dialect is for

When you build a submission, `lax build` compiles the concept files of
every submission you depend on, on your machine. Compiling Lean is not
like reading a data file: Lean deliberately lets a file run arbitrary
programs *while it is being compiled* — download things, read your files,
anything. So depending on a stranger's submission means running the
stranger's code on your machine, and no realistic amount of code review
protects you, because the dangerous constructs are easy to hide.

The dialect closes this by construction, for the submissions that carry
its label. Concepts written in the dialect — a small sub-language of Lean
— contain nothing that could ever execute author-written code: no
construct that runs a program, and no name that would let a value the
concept computes become one. The promise:

> **When every foreign package your build compiles carries the
> safe-dialect label, the build runs only the pinned toolchain and pinned
> mathlib — software you already trust, because it is what builds mathlib
> itself. The authors' text enters that machinery only as inert content:
> definitions to type-check, notation to expand, goals for whitelisted
> tactics. And when a package in your build does *not* carry the label,
> `lax` tells you so before its first line compiles.**

One consequence worth spelling out, because it sounds paradoxical: a
concept may *define* a program — say a `def` whose type is `IO Unit` —
and that is fine, *provided nothing in the dialect can hand that program
to the machinery that runs programs*. Defining is not running. Keeping it
that way takes two kinds of exclusion rather than one, and the second is
easy to miss: the dialect removes the constructs that name a program to
run, **and** it removes the few constants that let a program be selected
by a *value* instead of by a name. What the dialect removes is
capability, not computation: a hostile concept can still be slow to
compile (see Non-goals), it just cannot *do* anything.

## Why compiling Lean can run code

Ordinary, documented Lean has a handful of doors through which author
code executes at compile time. Naming them is most of understanding the
design:

- **Commands that execute directly.** `#eval`, `run_cmd`, `run_elab`
  exist to run a program during compilation. That program has full IO:
  files, network, processes.
- **Code that runs on import.** An `initialize` block runs the moment the
  file is *imported* — merely depending on the file triggers it, before
  anything else happens.
- **Registering code for later.** `macro`, `elab`, `syntax`, `notation`
  and friends register author-written programs (or new grammar) that run
  whenever the syntax they claim is used — including in *other* files.
- **Attributes that attach code.** A few attributes hang executable code
  on an innocent-looking definition: `@[init]` (an `initialize` in
  disguise), `@[extern]` and `@[implemented_by]` (splitting what the
  kernel checked from what actually runs).
- **Tactics that reach outside.** Most tactics are trusted mathlib code
  rearranging a proof goal. But the position is open-ended, and a few
  reach further — `native_decide` compiles the statement to machine code
  and executes it mid-proof.
- **Compiler switches.** `set_option` flips switches inside the compiler,
  including a few that disable safety machinery (`debug.skipKernelTC`).
- **Term-level oddities.** A couple of term forms carry capability:
  `include_str` reads any file the build can see into the compiled
  artifact.
- **Names that select a program out of a *value*.** The door that is
  easiest to miss, because nothing about it looks like code. Lean's
  `autoParam` gadget is an ordinary constant whose second argument is a
  piece of *data* — a `Lean.Syntax` value — and the elaborator runs that
  data as a tactic whenever an argument or structure field of such a type
  is left to be filled in. Its familiar surface form is the field default
  `(h : P := by simp)`, but nothing restricts it to that form: an author
  can apply `autoParam` directly to a `Syntax` value assembled from
  ordinary constructors, and then the tactic that eventually runs —
  including an escape hatch like `run_tac`, and through it arbitrary IO —
  appears **nowhere in the file's syntax**. The kernel has a smaller
  version of the same shape: mentioning `Lean.reduceBool` asks it to
  compile a term and run the result natively. What distinguishes this
  door from all the ones above is that walking the source text cannot
  find it; only a rule about *names* can (see the design section).

There is also a binary-level channel — compiled `.olean` files can carry
executable state that runs when *loaded* — which no source dialect can
close. Part II's artifact rules close it instead.

## The design: a whitelist on every door

The dialect has one rule:

> **Everything is off-dialect unless this document lists it.**

The gate (Part II) parses each concept file with Lean's own parser and
walks the entire syntax tree. Every node is checked against the lists
below; a construct not on them — including any construct from a future
Lean or mathlib version that the lists have never heard of — is
off-dialect, never guessed about. For *forms* there is thus no blacklist
to keep complete: the dangerous constructs of the previous section are
simply *not on the lists*, along with everything else that isn't.

The rule has exactly one exception, and it is better stated here than
discovered later. Whitelisting is impossible on the *name* axis — the
pinned background holds hundreds of thousands of constants and a concept
may legitimately mention any of them — so list 8 is an exclusion list,
the only one in this document. It is short, it is computed from the
pinned background rather than written by hand, and its completeness rests
on an audit rather than on construction. That makes it the design's
honest weak point; it is named as such again where it appears.

One exclusion does double duty and is worth naming: **declaring new
syntax is not in the dialect** — no `macro`, `elab`, `syntax`, and (for
now) no `notation`. A macro is the purest form of author code, so it is
out for capability; but excluding all grammar declaration also keeps the
*set of doors itself fixed*. Every piece of syntax the gate ever meets
comes from the pinned toolchain or pinned mathlib, so the lists below are
complete by construction and never need to account for syntax an author
invented. (Concepts still freely *use* every notation mathlib provides —
`∀`, `∑`, set-builders, all of it; they cannot mint new notation.
Admitting the `notation` family, which is genuinely code-free, is the
expected first extension once the archive settles; the first draft
records the mechanism.)

**Forms are not enough: the second axis.** The value-door above makes the
limit of a tree-walk concrete. A list of admissible syntax forms sees
`autoParam` as an identifier, `Syntax.node` as an identifier, and a
structure instance as a structure instance — all three are certainly
admissible, because mathematics is made of identifiers and structures. A
file that opens the door therefore passes a form-based check while the
program it runs is assembled at elaboration time out of perfectly
innocent parts. So the dialect has a **second axis of the same shape**: a
rule about which *names* a concept may mention (list 8), which is what
keeps a fabricated program from ever reaching a position where something
would run it. The two axes together cover both ways a program gets
selected — by a form in the text, and by a value the text computes.

The safety argument, in full, for a reader who does not know Lean. Code
runs during Lean compilation in exactly two ways. Either a *form in the
source text* selects a program — a command, a tactic, an attribute, an
option, a deriving handler — or registers a new such program; or a *value
the source computes* reaches one of the few constants that the elaborator
and the kernel interpret as "run this", which in the pinned background
means `autoParam` and the native-reduction pair. The dialect closes the
first kind by listing, for every such position, a short explicit set of
trusted entries, and by removing the register-a-new-program constructs
entirely. It closes the second kind by making those constants
unmentionable, so that no value a concept computes ever arrives anywhere
it would be run. What remains is the mathematics: inert expressions that
trusted, pinned code type-checks and expands.

Convincing yourself of the dialect's safety means reading the lists below
and believing that the pinned toolchain and mathlib are not themselves
hostile — a trust you already extend by using Lean at all. That trust is
load-bearing in one place worth naming out loud: trusted structures do
carry `autoParam` field defaults of their own (mathlib is full of `:= by
measurability` and its relatives), so building such a structure runs a
mathlib tactic that need not appear on the tactic list of list 6. The
tactic list bounds what an *author* can ask to have run; what pinned code
runs on its own behalf is covered by trusting pinned code, not by the
lists.

## Safe is a label, not a gate

The dialect blocks nothing. A submission whose concepts fall outside the
dialect submits, registers, and is archived exactly like any other. What
the archive does is **compute, record, and display** the fact:

- Every submit runs the gate and records a **verdict** for the
  submission's own concept package: on-dialect or not, at the current
  schema version.
- A submission is **safe-dialect** when its own verdict is a pass *and*
  every concept submission it requires is itself safe-dialect. (The label
  is transitive by definition — compiling a dependency means compiling
  the dependency's dependencies.)
- **The website shows the label** on every submission.
- **The CLI warns** — before compiling anything foreign — when a build's
  dependency closure contains any package that is not safe-dialect. It
  never refuses.

This advisory design is what makes the dialect a **moving target we can
fix later**, which is a feature, not a concession. A blocking gate
couples every schema mistake to a submission outage: a missing tactic
would stop an author's submit, so the schema would be grown under
pressure and shrunk never (shrinking would strand accepted submissions).
An advisory label has none of that: too-strict costs a submission its
label until the schema grows — visible, reversible, no one blocked;
too-loose is fixed by tightening the schema and re-computing every label
in one batch. The lists below are therefore **deliberately too small
rather than too big**, because under this model the cost of too-small is
a label and a warning, not a failed submission. The archive is small and
human-read; informed consent plus visibility is the right enforcement
strength today, and a strict opt-in (a flag that refuses non-safe
dependencies) can be added on top for users who want the gate back.

## The lists

Lists 1–7 admit surface forms, list 8 restricts the names those forms may
mention; the prose gives the reasons, and the exact machine-readable
boundary is the versioned schema file that ships with the gate (Part II).
A concept is on-dialect when it satisfies all eight. The corpus is
on-dialect under these lists after the
restructure of Lax3 and Lax5 recorded in
`lax-submissions/plans/submission-polish.md` — notably, after it, **no
concept in the corpus needs a single tactic**; the closer list below
exists for the small side conditions that legitimately arise.

**1. File structure.** `import` (plain form only; targets must be pinned
mathlib, the concept package's own modules, or declared dependencies —
the existing import rule, checked on the source before anything loads),
the single module docstring, `namespace … end`, `section … end`, `open`
in all its forms (including `open … in` and `open scoped`), `variable`,
`universe`, `export`, and `set_option` (command and `… in` forms) for
listed options only. *Why safe: pure bookkeeping — names and scopes for
the trusted elaborator.*

Not listed, deliberately: the module-system and prelude header forms
(`module`, `prelude`, `public import`, `meta import`, `import all`);
`#eval` and every other `#`-command (`#check`, `#print`, … — mostly
harmless, but they are development residue, not content); `run_cmd`,
`run_elab`, `initialize`, `builtin_initialize`.

**2. Declarations.** `def`, `abbrev`, `structure` (with `extends` and
`where`), `inductive`, `class`, `class inductive`, `instance`, `axiom`;
the modifiers `noncomputable`, `private`, `protected`; `deriving`
clauses and the standalone `deriving instance` command, for listed
classes; the recursion annotations `termination_by`, `decreasing_by`,
`decreasing_with`. *Why safe: declarations are processed entirely by the
trusted elaborator and kernel; nothing the author wrote executes.*
(`axiom` is central to the archive's open-claims design; its *soundness*
consequences are Replay's business, not the dialect's — see Non-goals.)

Not listed: `theorem`, `lemma`, `example` — concepts state, they do not
prove; proofs live in the proof package. `unsafe` — opts out of the
kernel. `partial` — safe but opaque: nothing can be proven about a
partial definition, which makes it an anti-concept. `macro`,
`macro_rules`, `elab`, `elab_rules`, `syntax`, `declare_syntax_cat`, and
the whole `notation`/`infix`/`prefix`/`postfix` family — see the design
section.

**3. Deriving classes.** `Repr`, `DecidableEq`, `Inhabited`, `Fintype`,
`BEq`, `Hashable`. *Why a list: `deriving` invokes a handler — trusted
code, but an extensible registry, so admission is by name.* (Lax5's
`deriving Language.IsRelational` is replaced by a one-line hand-written
instance in the restructure; the class returns here by amendment if
deriving it ever pulls real weight.)

**4. Attributes** (in `@[…]` position and via the `attribute` command):
`simp`, `ext`, `coe`, `norm_cast`, `push_cast`, `symm`, `trans`, `refl`,
`congr`, `simps`, `reducible`, `irreducible`, `inline`, and instance
priorities (`instance`, `default_instance`, priority annotations). *Why
a list: all listed entries are trusted registration or lemma-generation
code that treats the declaration as data; the not-listed ones include
the code-attaching attributes named above.* (Lax5's
`@[implicit_reducible]` becomes `abbrev`/`@[reducible]` in the
restructure — to be confirmed by rebuilding its proofs; if the coarser
form genuinely hurts, `implicit_reducible` is one amendment away.)

**5. Options.** The prefixes `pp.*` (display) and `linter.*` (hygiene),
plus `maxHeartbeats` and `maxRecDepth`. Raising `maxHeartbeats` is
admissible because resource exhaustion is out of scope (Non-goals).

**6. Tactics: closers only.** The editorial line this draft takes,
enabled by the corpus restructure: **concepts may close small side
conditions inline; proof developments live in proof packages.** A `by`
block in a concept exists for the subtype member, the instance field,
the arithmetic side condition — obligations a definition carries — not
for conducting proofs. The list, chosen to close such obligations in one
step:

> `rfl`, `decide`, `trivial`, `assumption`, `exact`, `infer_instance`,
> `omega`, `simp`, `norm_num`, `intro`, `constructor`

plus the same list inside `decreasing_by`. That is the whole tactic
surface — no rewriting toolbox, no case-analysis toolbox, no `conv`
sub-language. Anything that feels cramped under this list is a signal
the proof content belongs in the proof package (the Lax3 pattern: keep
the *definitions* in the concept, bundle and *verify* them in the
proofs). If a genuine one-step closer is missing, the list grows by
amendment — and under the advisory model a missing tactic costs a label,
not a submission.

Never listed, with reasons: `native_decide` — compiles the goal to
native code and runs it; `run_tac`, `tactic'` — escape hatches into
arbitrary tactic-monad code; `polyrith` — built around an external web
service; `exact?`, `apply?`, `hint` and the other search tactics —
interactive residue, not content.

This list bounds the tactics an author *writes*. It does not bound the
tactics pinned code runs on its own behalf: a mathlib structure whose
field default is `:= by measurability` runs `measurability` when a
concept builds that structure, and that is fine for the same reason
mathlib's elaborators are fine. What list 8 guarantees is that a tactic
in such a position is always one someone trusted put there — pinned
code's own, or a `by` block that passed this list — and never one
assembled out of data.

**7. Terms: the snapshot list.** The mathematics itself is written in
"term" syntax — `∀ n, P n`, `{c | ∃ S, …}`, arrows, subscripts,
coercions — and mathlib registers *thousands* of such notations. All of
them are pattern expansions performed by trusted code, so listing them
by hand buys no safety, but leaving them off the lists would put every
second submission off-dialect. The first draft handled this with an
origin rule ("whatever the trusted background registered, minus a ban
list") — sound, but the checked rule was effectively a blacklist, and
this document keeps those to the single place where a whitelist is
impossible (list 8).

The second draft's answer keeps the whitelist rule literal: the schema
ships an explicit, **generated snapshot**. A dump mode of the gate
enumerates, for the pinned toolchain and mathlib, every syntax kind
registered in the term-level categories; a short audited exclusion list
is applied *at generation time* — today three entries, `include_str`
(reads files), syntax quotations (useless without macros, so their
presence is at best confusion) and name literals (`` `Foo.bar ``: raw
material for the value-door of list 8, and never mathematics) — and the
result is checked in as part of the versioned schema. The gate consults only that
file: finite, explicit, diffable, pure whitelist. On every mathlib pin
bump the snapshot is regenerated and its **diff** is reviewed — dozens
of lines, not thousands.

The honest limit, stated plainly: the claim that the exclusion list is
complete — that no *other* term form shipped by core or mathlib carries
capability — rests on an audit, refreshed at each pin bump by reviewing
the snapshot diff. The first draft's origin rule rested on exactly the
same audit; the snapshot makes the audited object an explicit file in
the repository instead of a property of a running compiler.

**8. Names: the mention rule.** Lists 1–7 are about *forms*; this one is
about *names*, and it is what closes the value-door. Both rules are
checked against **resolved** names — what an identifier actually refers
to, not how it was spelled — so `open`, aliases and abbreviations do not
evade them:

- **The elaboration gadgets are unmentionable.** A concept may not
  mention `autoParam` or `optParam`. `autoParam` is the constant that
  turns a data value into a tactic to be run; `optParam` is its inert
  sibling for default terms, excluded with it because the two are one
  mechanism and separating them buys nothing. Concepts carry their side
  conditions as ordinary arguments instead.
- **Lean's metaprogramming layer is unmentionable.** No constant in the
  `Lean` namespace, and no constant whose *type* mentions a type from it.
  That namespace is where `Syntax`, `Name` and `Expr` live — the raw
  material a fabricated program is built out of — and it is also where
  the kernel's native-reduction pair `Lean.reduceBool` /
  `Lean.ofReduceBool` lives, the one way to make the *kernel* run
  compiled code.

*What stays in the dialect:* the trigger forms, and the honest way to
write a field default. Structure-instance notation, anonymous
constructors and omitted arguments are ordinary mathematics and remain
admissible — with no fabricated `autoParam` within reach, triggering a
synthesis can only run a tactic that is already visible and already
checked. So does the field default `(h : P := by simp)`, which mints an `autoParam`
without mentioning it: there the tactic sits in the source in plain
sight, and the tree-walk checks it against list 6 like any other `by`
block. The invariant these rules protect is therefore not "no `autoParam`
exists in a concept" — one can be inherited from mathlib or written as a
default — but the one that matters: **every tactic that ever runs was
either chosen by pinned code or written out in a gated `by` block, never
assembled out of data.**

*Why this suffices.* The claim to establish is not that no `autoParam`
position ever arises during a concept's elaboration — trusted structures
have plenty — but that **no such position ever carries a tactic the
author chose**. There are only two ways it could. The author writes
`autoParam` themselves, which the first rule forbids: it is a bare
root-level name, so it cannot be reached by dot-notation, cannot be
conjured by inference, and cannot arrive through a dependency either,
because the gate compiles a dependency only when that dependency's own
verdict is a pass (Part II) and a passing dependency did not mention it
either. Or the author reaches a *trusted* constant that takes the tactic
as an argument and hands it one — which requires both a constant whose
type mentions `Lean.Syntax` and a `Lean.Syntax` value to pass it, and the
second rule removes both. What is left is a position whose tactic was
fixed by pinned code or written out in a `by` block that list 6 already
passed — the trust the whole design already rests on. `Lean.reduceBool`
is closed by the same second rule, and with it the only way to ask the
kernel to run compiled code.

*The honest limit*, the same one list 7 carries: "these are the constants
that carry capability" is an audit, not a theorem. The audit is
mechanical — the excluded set is *computed* from the pinned background
rather than hand-written (Part II) — and it is refreshed at each pin bump
by reviewing the diff of that computed set. *The cost:* none observed.
No concept in the corpus mentions any excluded name, which is what one
would expect, since the excluded set is exactly the part of the pinned
background that is not mathematics.

## Non-goals

- **Resource exhaustion.** A dialect-clean concept can still make the
  compiler diverge or eat memory. The guarantee covers capability, not
  termination: a build you have to kill is an annoyance, not a
  compromise.
- **Proof packages.** Proofs need full Lean — they are written largely
  by AI agents wielding heavy tactics — and stay unrestricted. A proof
  package is therefore *never* safe-dialect, and requiring a foreign one
  puts a build outside the label; the CLI's warning covers it like any
  other unlabeled package.
- **Soundness.** The dialect adds nothing to mathematical validity —
  Replay and the axiom rules own that. A submission can be perfectly
  sound and hostile to build, or dialect-clean and wrong.


# Part II — Enforcement

## The gate

A lax-owned Lean executable, sibling of the inspector: pinned to the
archive toolchain, shipped as source with the CLI, compiled once per CLI
version into `~/.lax/tools/`, reused. Like the inspector it decides
nothing: it reports each off-schema finding as a fact — module, position,
offending kind, payload, or resolved name — and the CLI/server judge. Unlike the
inspector it reads *source*, which deliberately amends the "pipeline
never parses Lean" invariant, narrowly: the parser is Lean's own, and
the gate elaborates nothing off-schema. **Gate findings are warnings and
verdict input, never pipeline violations** — nothing about the dialect
fails a job (the one change to the first draft's gate semantics).

**Mechanism: a guarded frontend.** Modules are processed in dependency
order. Per module, normatively:

1. **Header first, before anything loads.** The gate parses the module
   header without importing anything and validates it: plain `import`
   only, every target within pinned mathlib, the package's own
   inventory, or the resolved dependency set. Environments are
   constructed only after the header passes — loading a disallowed
   import is already execution.
2. **Then the guarded loop.** Parse one command and check it twice
   before elaborating it: walk its full tree against the schema's kind
   lists, and resolve every identifier it contains against the current
   scope, checking each resolution against the mention rule of list 8.
   Only if *both* checks pass is the command elaborated; then parse the
   next. An identifier that resolves ambiguously is off-dialect if *any*
   of its candidates is excluded. Elaboration maintains the scope state
   (`namespace`, `open`, `variable`, `set_option`) later commands need.
3. **Then the names only elaboration could resolve.** Some identifiers
   have no resolution until the expected type is known: dot-notation
   (`.node`), generalized field notation, anonymous constructors. After
   the command elaborates, the gate reads those off the elaborator's
   **info tree** — which records, for each identifier *in the source*,
   the constant it denoted — and checks them against the mention rule as
   well. Reading source occurrences rather than scanning the elaborated
   result is what keeps this check free of false positives: a concept
   that extends a mathlib structure inherits `autoParam` applications and
   `Lean.Syntax` values into its own types without mentioning either, and
   inheriting them is exactly what list 8 permits. Deferring this half
   until after elaboration is safe because the spellings it covers cannot
   open an executing position on their own — applying a constant to a
   fabricated `Syntax` value runs nothing — and the one gadget that would
   run it, `autoParam`, is a bare root-level name that must be spelled
   out, so step 2 catches it before anything elaborates.

All three checks are decided by a static schema. Because the dialect
admits no syntax declarations, no kind ever appears mid-run that the
shipped schema file does not already contain; and because it admits no
way to define a new capability constant, neither does any name — the
excluded set is computed once from the pinned background and cannot be
extended by anything an author writes.

**The schema file is the normative surface.** A versioned,
machine-readable file (`dialect-schema`) beside the gate, compiled into
it, carrying the `dialectVersion` that verdicts record: kind lists per
syntax category, payload rules (tactics, attributes, options, deriving
classes, each with its admissible argument forms), the generated term
snapshot of Part I, and the generated **excluded-name set** of list 8.
The latter is enumerated the same way as the term snapshot, by scanning
the pinned environment: every constant in the `Lean` namespace, every
constant whose type mentions a type from it, and the two gadgets
`autoParam` and `optParam`. A dump mode of the gate regenerates both
generated parts on pin bumps, and both are reviewed as diffs.
Prose–schema divergence is a bug, fixed by amendment — never by letting
the implementation silently become the specification.

## Verdicts and the safe label

**Stored fact, derived label.** Each submission record stores one
**verdict** about its *own* concept package: `pass` or `fail`, with the
schema version that judged it (records predating the gate have none —
equivalent to `fail` for the label). The **safe-dialect label** is never
stored; it is derived wherever needed: *safe ⇔ own verdict is `pass` at
the current schema version ∧ every concept dependency is safe.* Deriving
rather than storing means a schema change or an upstream flip never has
to cascade updates through the database — labels follow verdicts
instantly, computed by the same closure walk Resolution already does.

**When verdicts are written.** The server runs the gate on every submit
(draft and registration), as a pipeline phase between Provision and
Compile, inside the sandbox, and writes the verdict into the record it
commits. On a schema version change, a batch job re-runs the gate over
every content-bearing record in dependency order and rewrites verdicts
(see Evolution).

**Verdict integrity.** The gate elaborates a submission's modules
against its dependencies' stored artifacts, and loading an artifact can
run code (the olean channel). Rule: **the gate loads only artifacts of
dependencies whose own current verdict is `pass`.** If any concept
dependency's verdict is not `pass`, the submission's verdict is recorded
as `fail` (reason: dependency off-dialect) without elaborating anything
— its label could never be safe regardless, and this way no potentially
hostile artifact ever runs inside the gate, so a recorded `pass` cannot
have been forged by an upstream initializer. Together with capture
isolation (below), a `pass` verdict is therefore always the product of
trusted code examining gated source.

**Locally**, `lax build` runs the gate on the submission's *own* concept
package and reports the findings as warnings — the author learns their
label outcome before submitting. This is feedback, not safety: authors
trust their own code; the safety of *dependencies* comes from the server
verdicts learned through the database clone.

## What the CLI warns about

During local Resolution — before Provision and before any `lake`
invocation, because a warning after foreign code compiled is worthless —
`lax build` computes the transitive compilation closure through recorded
build-outputs in the local database clone and **warns**, naming:

- every foreign concept submission in the closure that is not
  safe-dialect (verdict from the local clone; the transitive label needs
  no extra walk beyond the closure computation itself),
- every foreign proof package in the closure (never safe by definition),
- every closure member whose record or build-output is missing locally —
  reported as *unknown* with the `lax update-db` hint, never silently
  treated as safe.

The warning is loud, names each package once, and blocks nothing. A
strict mode that refuses instead (`lax build --require-safe`, say) is
the natural opt-in for cautious users and CI; recorded here as expected,
not specified.

## What the website shows

Every submission page and listing shows the derived label: safe-dialect
(with the schema version its verdict carries) or not. A not-safe
submission names the coarse reason — its own concepts are off-dialect,
or it inherits from a named dependency — so a reader can see at a glance
whether the archive vouches for compiling it, and authors can see what
their fix would be. Display details are sitegen's business; the label
semantics above are normative.

## The artifact channel

Compiled `.olean` files can carry executable state that runs when
loaded, and Replay does not authenticate that layer (`leanchecker`
rechecks kernel declarations only). The label's artifact-level meaning
needs:

- **Capture isolation.** The server extracts the concept package's
  oleans after the concept build completes and **before the proof build
  starts** — concretely, Compile becomes two sandboxed invocations with
  the extraction between them. A malicious proof build (unrestricted by
  design) can scribble on its own copies; nothing reads them afterwards.
  Stored artifacts are then a pure function of the submitted source, the
  pinned toolchain, and trusted store inputs — so a `pass` verdict about
  the source covers the artifact.
- **Provenance binding.** Every store entry records the dialect schema
  version, toolchain, and source commit that produced it, checked
  against the submission record whenever the entry is placed on a
  trusted search path. A mismatch is a server-side integrity failure,
  fatal to the job.
- **Destination.** The recorded optimization path — the gate becomes the
  authoritative concept compiler, its elaboration output captured
  directly — subsumes capture isolation and remains where this design is
  headed.

The server itself is protected by the sandbox regardless of any of this
(every phase that touches untrusted code or artifacts runs inside it);
the artifact rules exist so the *label* keeps its meaning for users.

## Evolution: a moving target by design

The schema is expected to move, in both directions, and the advisory
model makes every move cheap:

- **Any schema change** — adding a missing tactic, admitting the
  `notation` family, tightening a payload rule, regenerating the term
  snapshot on a pin bump — is a new `dialectVersion` plus one batch
  re-verification: re-run the gate over every content-bearing record,
  drafts included, in dependency order, rewriting verdicts. Labels are
  derived, so they update the moment verdicts do; the site shows the new
  state on its next regeneration.
- **Nothing is quarantined, voided, or blocked.** A submission that
  loses the label keeps its standing, its citability, and its
  dependents; what changes is a line on its page and a warning in
  downstream builds. A submission that gains the label gains it for its
  dependents too, automatically.
- The archive is small enough that re-verification is a batch job, not a
  migration project — which is exactly why the schema can afford to
  start deliberately too small and grow against real submissions.

## Relation to spec.md

Touch points for manual reconciliation: a new Dialect phase between
Provision and Compile (server-mandatory on every submit, findings are
warnings + verdict, never violations); the Compile split with concept
extraction between the halves; store provenance binding; the record
schema's dialect verdict (own-package pass/fail + schema version); the
CLI warning walk in local Resolution (replacing the first draft's
`--allow-foreign-proofs` refusal — no such flag exists in this design;
`--require-safe` reserved as the strict opt-in); sitegen's safe-dialect
label; the narrow exception to "pipeline never parses Lean" (which now
also covers the gate resolving names and inspecting elaborated
declarations — still one phase, and still elaborating nothing off-schema);
`theorem`-in-concepts and stray-`#check` tolerance both become
off-dialect (label-relevant, not submit-relevant).


# Changes from the first draft

For the reviewer; no other semantic changes intended.

1. **Advisory, not blocking.** The first draft's admission gate —
   dialect violations fatal to submit, Resolution refusing verdict-less
   dependencies, `--allow-foreign-proofs` to consent past foreign proof
   code, quarantine semantics for failed re-verification — is replaced
   wholesale by the label model: verdicts recorded on every submit,
   safe-dialect derived transitively, website display, a pre-Compile CLI
   warning naming every unlabeled package in the closure, nothing ever
   refused. Evolution trivializes accordingly (no verdict voiding, no
   specVersion bump, no quarantine — one batch re-verification per
   schema change).
2. **Tactics: closers only.** The ~50-name tactic list (plus a conv
   sub-list) shrinks to eleven one-step closers plus the recursion
   annotations. Enabled by restructuring the corpus rather than growing
   the dialect: the only real tactic proofs in any concept package
   (Lax3's `ScatterChoice` witnesses) are verification content and move
   to the proof package, keeping the pure definitions in the concept;
   Lax5's `@[implicit_reducible]` and `deriving Language.IsRelational`
   are replaced by on-dialect forms. The restructure is specified in
   `lax-submissions/plans/submission-polish.md`; after it, the corpus
   uses zero tactics in concepts. Growth remains one amendment away and
   is now nearly free (see change 1).
3. **Term layer: origin rule → generated snapshot.** The one place the
   first draft's checked rule was a blacklist becomes a literal
   whitelist: an explicit generated file, exclusions applied at
   generation time, diff reviewed on every pin bump. Same audit, better
   artifact. Adds a dump mode to the gate.
4. **A second axis: the mention rule (list 8).** The one change here that
   is a *fix* rather than a redesign, added after a second review. Both
   drafts' safety argument claimed that code runs only where a name in
   the source selects a program, and closed every such position with a
   list of forms. The claim is false. Lean's `autoParam` takes its tactic
   as a `Lean.Syntax` *value*, so a file built entirely out of
   whitelisted forms — ordinary constructors, ordinary application, a
   structure instance with a field left open — can hand the elaborator a
   tactic that appears nowhere in its syntax tree, `run_tac` and full IO
   included; the kernel's `Lean.reduceBool` is a smaller instance of the
   same shape. No tree-walk can see either, in either draft. The dialect
   therefore gains a rule about names, the door list gains the entry it
   was missing, the term snapshot's generation-time exclusions gain name
   literals, the gate gains a resolution check and a post-elaboration
   scan, and the safety argument is restated over both axes. It costs the
   corpus nothing: no concept mentions an excluded name.
5. **Restructured for the non-expert reader.** Part I is meant to be
   readable and checkable without Lean knowledge; the machinery moved to
   Part II. The first draft's threat-model prose and the notation
   unpruning mechanism survive there and are incorporated by reference.
6. **Unchanged**: the syntax-declaration ban (and planned `notation`
   unpruning), attributes/options/deriving as closed lists, the guarded
   frontend, capture isolation and provenance binding, the sandbox
   protecting the server throughout, all three non-goals.
