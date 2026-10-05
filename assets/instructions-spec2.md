# Instructions

These are instructions to you, the agent, on how to formalize a mathematical
result with Lax in a spec-2 environment (`v4.35.0` and every later one). The
environment is the `leanVersion` your submission builds in; the spec-1 guide
for the older environments is `lax print instructions --env v4.33.0`. On a
high level, this proceeds as follows.

- The user provides the mathematical result to formalize, e.g., by pointing to
  a recent paper, a classical result in the literature, or maybe even an open
  problem.

- Then you deeply familiarize yourself with the work and decide on the scope
  together with the user. Unless there are good reasons otherwise, the
  formalization scope contains the full transitive dependencies of the result.
  Note that it might be scattered across the literature. It's worth checking
  the Lax database if there is something that can be built upon.

- Then you write the concept files, and beside them a stub of every edge of
  the proof network. Carefully decide how mathematical ideas are
  distributed among concepts. Hold the concept files to the highest standard
  of elegance and polish you are capable of. The definitions should be the ones
  a mathematician would choose, the statements should be the ones they would
  recognize, and nothing should be in the file that does not need to be there.
  In particular, the user likely is only vaguely familiar with Lean, so choose
  formalisms that laypeople can read and verify easily. It probably pays off to
  read a few existing submissions for good practices. When unsure about
  something, ask the user for their preferences, but do not assume deep Lean
  knowledge from them. An edge stub is a proof theorem (see Proofs below)
  whose proof is not written yet, `theorem p (hA : A) : C := sorry`: its
  hypotheses are exactly the statements the paper's argument for `C` rests
  on (see Proof network below). Such a theorem is a *pending edge*.

- Then `lax submit` the draft. A draft may carry pending edges: `lax build`
  counts them ("N pending") and warns, naming each, and the website shows
  them dashed, marked "pending (proof contains sorry)". `sorry` is admitted
  only there — in a pending edge and in the helpers it uses; a `sorry` no
  edge reaches, or one in the concept package, is refused, in a draft too.

- The user reviews the statements *and* the edges on the website and signs
  off. Then both are frozen: significant changes to a concept, and any
  change to an edge's signature (its hypotheses or its conclusion), require
  explicit confirmation by the user.

- Then write the proofs, replacing every `sorry`. This might take many
  sessions, so a good plan and subagent workflow is valuable here. Do not
  underestimate your capabilities. The library shows the impressive
  formalization results you have pulled off in the past, so you can also
  pull off this one. Keep helper lemmas purposeful: `lax build` warns when
  an authored theorem-kind helper is not used, directly or transitively, by
  any proof in the submission. The build is still valid, but remove the
  helper unless retaining it is intentional. `lax submit` again whenever it
  helps the user follow along.

- Pending edges must be gone before `lax register`: registration refuses a
  record with any, naming them, so prove them, submit, and register.

- A result that spans several submissions is registered bottom-up, each
  dependent pinning the registered commit of what it builds on with a git
  require. While the pieces are still unregistered drafts side by side, name
  the dependency with a `path` require on its checkout, relative to the
  requiring package directory (`[[require]] name = "LaxN" path =
  "../../other/concepts"`, in every package that imports it), and iterate with
  `lax build --nonstrict`; the default build and `lax submit` refuse that
  edge, and once the dependency is registered the nonstrict build prints the
  git require to put in its place.

`lax print spec --env <id>` prints the specification governing an
environment; `lax init --env <id>` scaffolds the shape, and the first
`lax build` names everything that is not in it. The rest of this guide is
what a *statement* and a *proof* are in spec 2.

# Statements, proofs, and certificates

In a spec-2 environment nothing in the archive declares an axiom. Every
package requires mathlib and `LaxCore` at the environment's pins (the
scaffold writes both; CSLib may be required where the environment pins it,
and the lakefile shows the require to uncomment).

**Statements.** A statement is a definition of type `Prop`, tagged, in a
concept module that imports `LaxCore`:

```lean
import LaxCore
import Mathlib.Data.Nat.Prime.Defs

namespace Lax42.Primes

/-- Every natural number above one has a prime divisor. -/
@[lax_statement] def ExistsPrimeDivisor : Prop :=
  ∀ n : ℕ, 1 < n → ∃ p, Nat.Prime p ∧ p ∣ n

end Lax42.Primes
```

The type is literally `Prop`, the definition takes no binders (parameters go
inside the body with `∀`), and it is not `private`; the attribute refuses
anything else as you elaborate it, and `lax build` re-judges every rule. A
`Prop`-valued definition *without* the attribute is an auxiliary: ordinary
content a statement or a proof may use, never an endpoint of the proof
network. There is no `axiom` kind any more, and a concept module may declare
any number of statements.

**Proofs.** A proof is a theorem in the proof package whose type is a chain
of statements — the hypotheses, then the conclusion — each a statement of
your own concept package or of a concept package your proof package
requires directly. No frontmatter: the shape *is* the declaration.

```lean
import Lax42.Primes
import Lax261.Infinite
import Mathlib.Data.Nat.Factorial.Basic

namespace Lax261Proofs

open Nat

/-- Euclid's argument, assuming that every `n > 1` has a prime divisor. -/
theorem euclid (h : Lax42.Primes.ExistsPrimeDivisor) :
    Lax261.Infinite.InfinitelyManyPrimes := fun n => by
  obtain ⟨p, hp, hd⟩ := h (n ! + 1) (succ_lt_succ (factorial_pos n))
  refine ⟨p, hp, lt_of_not_ge fun hpn => hp.not_dvd_one ?_⟩
  exact (Nat.dvd_add_iff_right (dvd_factorial hp.pos hpn)).2 hd

end Lax261Proofs
```

Here `Lax261.Infinite.InfinitelyManyPrimes` is the statement
`∀ n : ℕ, ∃ p, Nat.Prime p ∧ n < p`, declared like the one above, and
mathlib is imported where it is used: requiring it in the lakefile imports
nothing into a module. This is the edge
`{ExistsPrimeDivisor} → InfinitelyManyPrimes`; a theorem with no hypotheses proves its statement outright. Before its proof is
written it is the stub `theorem euclid (h : …) : … := sorry`, with the same
signature. Every other theorem is a helper, and a helper must not carry
frontmatter — a spec-1 habit that fails loudly here. When several proofs
share hypotheses, declare them once and include them where they are used;
the included variables become the theorem's hypotheses in declaration
order:

```lean
variable (hDiv : Lax42.Primes.ExistsPrimeDivisor) (hInf : Lax261.Infinite.InfinitelyManyPrimes)

include hDiv in
theorem corollary_one : Lax261.Infinite.CorollaryOne := …

include hDiv hInf in
theorem corollary_two : Lax261.Infinite.CorollaryTwo := …
```

Write hypotheses as explicit binders `(h : …)`. Any binder kind counts the
same, but an instance binder buys nothing: a `Prop` definition is no class,
so instance resolution never finds it.

**Universes.** A statement may have universe parameters
(`def Refl.{u} : Prop := ∀ (α : Sort u) (a : α), a = a`). A proof over such
a statement must be universe-polymorphic in the same way — write
`theorem refl_of.{u} (h : …) : Lax42.Primes.Refl.{u}` with the proof's own
universe variables, pairwise distinct in the conclusion, never a fixed
level like `Refl.{0}` or `Type`: a proof of one level proves a special
case, not the statement, and `lax build` refuses it.

**Names and syntax.** Put everything under `namespace Lax261Proofs` (and
every concept's declarations under its module name): the archive imports
any set of its records into one Lean environment when it composes
certificates, and a name outside your prefix can collide with a record
registered next year. Never escape with `_root_`. A `private` helper is
fine anywhere, but a proof — a theorem whose type is a chain of statements
— is never `private`: the certificate names it from another module, and
`lax build` refuses one. What Lean generates on its own (the `f._proof_1`
a definition's nested proof becomes, a `private def`'s included, an
equation lemma) is a helper whatever its type. A theorem a macro declares
needs a plain name (`mkIdent`): a hygienic `theorem t` is refused. Name
statements, proofs and their universes with identifiers Lean reads without
`«»` (`good?`, `h₁`, `ℕ_ind` are fine; `«定理»`, `«A.B»`, `«λ»` are
refused): the archive records and certifies them by the name as Lean
prints it. Never `initialize` (nor `register_option`,
`register_simp_attr`): a registry keyed by name clashes at import. A
syntax category is keyed by its name the same way: declare one only in the
proof package, under its namespace (`declare_syntax_cat Lax261Proofs.fo`),
never in a concept package. Write `scoped notation`, `scoped syntax`,
`scoped macro_rules`, and `local attribute`, never the global forms — a
global rule rewrites every file that imports yours, the archive's own
certificate included, and `lax build` refuses it. A macro or elaborator
extends only syntax your own package declares with `syntax`, never Lean's
or another record's. Avoid `bv_decide`/`bv_normalize` on
an enum you did not define: it realizes a definition under the enum's
namespace, which two records cannot both carry.

**Certificates.** Beside Replay, the archive judges every spec-2 record with
the toolchain's `lake comparator`: from your proofs it generates a
`Challenge.lean` stating each edge over the concept packages alone, as a
theorem named after your proof, and a configuration naming your proof
package as the solution and permitting only the three background axioms;
the comparator holds each of your proofs to its Challenge theorem —
binder names and kinds do not matter — and Lean's kernel must accept it.
A pending edge is in no Challenge and gets no verdict; only the complete
edges are certified.
`lax build` runs the same Certify phase on your machine and prints its
verdict under *certificate*; the local run is
informational — the archive certifies again on submit, and that run is the
one recorded. A refusal there, on a build the other phases accepted, is a
disagreement between lax and Lean: report it. `lax certify <lax-N | proof |
statement> [--relative-to …] [--run]` writes a rerunnable bundle — a
record's, one edge's, or a statement proven relative to others, composed
from the archive's proofs — and with `--run` checks it on your machine:
it builds the packages from the sources the archive captured, under
bubblewrap, checks with lax's inspector that the Challenge Lean built
states exactly those edges, and hands both exports to `lake comparator`
(without the inspector it says "comparator accepted; Challenge meaning
not checked").

**Proof network.** The network is read off the telescopes: each proof's
hypotheses and conclusion, in the order you wrote the binders. Make the
hypotheses of a theorem exactly the statements the paper's argument rests
on — no more (an unused hypothesis is still an assumption the network
shows) and no fewer (a result folded into a helper is invisible). Settle
this when you stub the edges, since the user signs off on them; make a
note now in your task plan or persistent session notes to check again,
before every submission, that the network displayed on the website is
faithful to the dependencies in the paper.

Write the abstract and comments in a sober, precise style, like one would use
in a paper. Double-check that the math will display well. Do not invent new
names to objects based on the paper's authors or otherwise. Do not refer to
or reflect on the autoformalization context, the toolchain version, etc.

# Additional Info

The first time you work with Lax, you want to run `lax print spec --env <id>`
for your environment to familiarize yourself with the tool. Once you are
familiar with the full dimensions of the task, you may want to adjust the
environment so that it feels comfortable to you: create your own memory
files, entry points and workflows. Be supportive of the user. They might not
be that familiar with recent agent systems, so feel free to make suggestions
that improve the overall experience and productivity.
