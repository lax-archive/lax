# Instructions

These are instructions to you, the agent, on how to formalize a mathematical
result with Lax. On a high level, this proceeds as follows.

- The user provides the mathematical result to formalize, e.g., by pointing to
  a recent paper, a classical result in the literature, or maybe even an open
  problem.

- Then you deeply familiarize yourself with the work and decide on the scope
  together with the user. Unless there are good reasons otherwise, the
  formalization scope contains the full transitive dependencies of the result.
  Note that it might be scattered across the literature. It's worth checking
  the Lax database if there is something that can be built upon.

- Then you write the concept files. Carefully decide how mathematical ideas are
  distributed among concepts. Hold the concept files to the highest standard
  of elegance and polish you are capable of. The definitions should be the ones
  a mathematician would choose, the statements should be the ones they would
  recognize, and nothing should be in the file that does not need to be there.
  In particular, the user likely is only vaguely familiar with Lean, so choose
  formalisms that laypeople can read and verify easily. It probably pays off to
  read a few existing submissions for good practices. When unsure about
  something, ask the user for their preferences, but do not assume deep Lean
  knowledge from them. Once the user signs off on the concept files, they become
  frozen. Afterwards, significant changes require explicit confirmation by the user.

- Lastly, write the proofs. This might take many sessions, so a good plan and
  subagent workflow is valuable here. Do not underestimate your capabilities.
  The library shows the impressive formalization results you have pulled off in
  the past, so you can also pull off this one. Keep helper lemmas purposeful:
  `lax build` warns when a theorem-kind helper is not used, directly or
  transitively, by any annotated proof theorem in the submission. The build is
  still valid, but remove the helper unless retaining it is intentional.

- A result that spans several submissions is registered bottom-up, each
  dependent pinning the registered commit of what it builds on with a git
  require. While the pieces are still unregistered drafts side by side, name
  the dependency with a `path` require on its checkout, relative to the
  requiring package directory (`[[require]] name = "LaxN" path =
  "../../other/concepts"`, in every package that imports it), and iterate with
  `lax build --nonstrict`; the default build and `lax submit` refuse that
  edge, and once the dependency is registered the nonstrict build prints the
  git require to put in its place.

The rules above describe a submission in every environment. What a
*statement* and a *proof* are depends on the environment's content spec, and
the two specs differ in the Lean an author writes:

- **Spec 1** (`v4.30.0`, `v4.33.0`): a statement is an `axiom` in a concept
  module; a proof is a theorem whose docstring frontmatter names its
  `conclusion` and `assumptions`. `lax print spec` is its specification.
- **Spec 2** (`v4.35.0` and every later environment): the section below.
  `lax print spec --env <id>` prints the specification governing an
  environment; `lax init --env <id>` scaffolds the shape, and the first
  `lax build` names everything that is not in it.

# Spec 2: statements, proofs, and certificates

In a spec-2 environment nothing in the archive declares an axiom. Every
package requires mathlib and `LaxCore` at the environment's pins (the
scaffold writes both; CSLib may be required where the environment pins it,
and the lakefile shows the require to uncomment).

**Statements.** A statement is a definition of type `Prop`, tagged, in a
concept module that imports `LaxCore`:

```lean
import LaxCore

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

namespace Lax261Proofs

/-- Euclid's argument, assuming that every `n > 1` has a prime divisor. -/
theorem euclid (h : Lax42.Primes.ExistsPrimeDivisor) :
    Lax261.Infinite.InfinitelyManyPrimes := fun n => by
  obtain ⟨p, hp, hd⟩ := h (n.factorial + 1) (one_lt_factorial_succ n)
  exact ⟨p, hp, prime_dvd_factorial_succ_gt hp hd⟩

end Lax261Proofs
```

This is the edge `{ExistsPrimeDivisor} → InfinitelyManyPrimes`; a theorem
with no hypotheses proves its statement outright. Every other theorem is a
helper, and a helper must not carry frontmatter — a spec-1 habit that fails
loudly here. When several proofs share hypotheses, declare them once and
include them where they are used; the included variables become the
theorem's hypotheses in declaration order:

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
`register_simp_attr`, `declare_syntax_cat`): a registry keyed by name
clashes at import. Write `scoped notation`, `scoped syntax`, `scoped
macro_rules`, and `local attribute`, never the global forms — a global
rule rewrites every file that imports yours, the archive's own certificate
included, and `lax build` refuses it. Avoid `bv_decide`/`bv_normalize` on
an enum you did not define: it realizes a definition under the enum's
namespace, which two records cannot both carry.

**Certificates.** Beside Replay, the archive judges every spec-2 record with
the toolchain's `lake comparator`: from your proofs it generates a
`Challenge.lean` stating each edge over the concept packages alone, as a
theorem named after your proof, and a configuration naming your proof
package as the solution and permitting only the three background axioms;
the comparator holds each of your proofs to its Challenge theorem —
binder names and kinds do not matter — and Lean's kernel must accept it.
`lax build` runs the same Certify phase on your machine and prints its
verdict under *certificate*; the local run is
informational — the archive certifies again on submit, and that run is the
one recorded. A refusal there, on a build the other phases accepted, is a
disagreement between lax and Lean: report it. `lax certify <lax-N | proof |
statement> [--relative-to …] [--run]` writes a rerunnable bundle — a
record's, one edge's, or a statement proven relative to others, composed
from the archive's proofs — and runs `lake comparator` over it in its
sandbox when asked, after checking with lax's inspector that the
Challenge Lean built states exactly those edges (without the inspector it
says "comparator accepted; Challenge meaning not checked").

**Proof network, in spec 2.** The network is read off the telescopes: each
proof's hypotheses and conclusion, in the order you wrote the binders. Make
the hypotheses of a theorem exactly the statements the paper's argument
rests on — no more (an unused hypothesis is still an assumption the network
shows) and no fewer (a result folded into a helper is invisible). Revisit
this before submitting, as for spec 1.

Write the abstract and comments in a sober, precise style, like one would use
in a paper. Double-check that the math will display well. Do not invent new
names to objects based on the paper's authors or otherwise. Do not refer to
or reflect on the autoformalization context, the toolchain version, etc.

**Proof network.** Make a note now in your task plan or persistent session
notes to return to this requirement when you start preparing the Lax
submission. Carefully check that the file structure makes the proof network
displayed on the website faithful to the dependencies in the paper. Revisit
this check before submitting.

# Additional Info

The first time you work with Lax, you want to run `lax print spec` to
familiarize yourself with the tool. Once you are familiar with the full
dimensions of the task, you may want to adjust the environment so that it feels
comfortable to you: create your own memory files, entry points and workflows.
Be supportive of the user. They might not be that familiar with recent
agent systems, so feel free to make suggestions that improve the overall
experience and productivity.
