**Verdict: the representation change is sound, but the charter is not ready for parallel implementation.** Replacing claim axioms with proposition definitions and explicit hypotheses is a substantial improvement. The proposed certification can establish that particular formal implications have proofs. It does **not yet establish that those implications are exactly the claims displayed by lax**, and its trusted-Challenge assumption currently has no implemented enforcement. Resolve that boundary, certificate identity, and declaration coverage before treating C1–C6 as fixed. **[High; repository, toolchain source, reasoning]**

This was read-only: I modified no files and invoked no build tools. I inspected the installed **v4.35.0-rc3** sources, rather than assuming the standalone comparator README describes the bundled implementation. Spike observations below reflect files and logs available around **20:40 CEST, 3 October**; the spike continued changing during review.

Evidence labels: **R** = repository or spike inspection; **T** = installed toolchain source; **U** = upstream documentation/source; **K** = reasoning about Lean or the trust architecture. Reasoned attacks below were not executed.

## A. Soundness of the trust argument

**A1. The certified object is an exported theorem statement, not a database edge or website badge. [High; R,T,K]**

The architecture calls inventory, telescopes, network, and website untrusted claims, then says important claims are re-derived by the judge. But C4 feeds the judge a Challenge *generated from those same claims*. Comparator checks the relationship between the resulting Challenge and Solution; it does not read `certificate.json`, database records, or the website.

For example, a generator can accidentally produce `A → A` while recording `{A} → C` in JSON. Both generated Lean files can agree and pass. Likewise, an edge certificate for `A → C` does not certify a website marking `C` unconditionally proven.

The residual trusted components therefore include:

- The mapping from record/source identity to Lean constants.
- The mapping from edge descriptors to Challenge theorem types.
- The correspondence between listed targets, successful verdicts, and published edges.
- The website’s interpretation of conditional edges and grounded proofs.

These are substantive mathematical bindings, not merely presentation. Publish independently checkable bindings, and generate a composed theorem for each unconditional or relative-proven status you label certified. “No archived proof found” also needs to remain distinct from mathematical unprovability. See [architecture](/home/jan/git/lax/axiomfree-plan.md:53), [C4](/home/jan/git/lax/axiomfree-plan.md:132), and the existing [least-fixed-point semantics](/home/jan/git/lax/spec.md:461).

**A2. Trusted Challenge imports are the largest unresolved security dependency. [High; R,K]**

[C1](/home/jan/git/lax/axiomfree-plan.md:88) constrains declaration kinds and axioms. Neither constraint prevents a concept package from executing an initializer, registering an elaborator, or running a command that changes what later declarations mean.

A malicious concept dependency could arrange for generated Challenge declarations to elaborate to a different, easy proposition. It could do so without introducing a forbidden axiom: the final declarations might be perfectly valid theorems about `True`. Comparator would correctly certify the wrong Challenge.

The charter recognizes this at [lines 74–78](/home/jan/git/lax/axiomfree-plan.md:74), but supplies no contract or workstream enforcing it. Its reference to “decision 5” is broken: [decision 5](/home/jan/git/lax/axiomfree-plan.md:44) is the integration branch.

This is particularly concrete because:

- [TODO](/home/jan/git/lax/TODO.md:502) says the dialect has zero implementation.
- The [existing normative dialect](/home/jan/git/lax/spec_conceptdialect.md:325) forbids the module forms now proposed.
- The [successor draft](/home/jan/git/lax/spec_conceptdialect_draft.md:3) is advisory, and documents an `autoParam` capability escape missed by the earlier design.

An advisory label cannot establish a mandatory trusted-import premise. Either make a revised, provenance-preserving concept gate a prerequisite, or explicitly retain trust in concept authors/elaboration. A third alternative—constructing Challenges from protected, reviewed exported declarations—needs its own source-to-export trust contract.

**A3. Random theorem namespaces do not solve module or artifact capture. [High; R,T,K]**

C4 randomizes `<ns>` in theorem names while leaving the generated module named `Challenge`. Those are different namespaces. Palomar’s protection specifically randomizes the **Challenge module’s top-level prefix**, addressing module lookup, not merely declaration collision. See [C4](/home/jan/git/lax/axiomfree-plan.md:141) and [Palomar’s implementation](https://raw.githubusercontent.com/PalomarRegistry/PalomarSubmission/main/scripts/verify_submission.py).

Randomness also does not protect against code that can read the generated file, poison writable build artifacts, or modify the exported Challenge. Fixed names in published bundles make secrecy unsuitable as a lasting premise.

Require a protected Challenge build/export, immutable statement dependencies, explicit module search paths, and separation from Solution-writable state. Use canonical, escaped Lean names and structured universe expressions; never interpolate arbitrary reported strings as Lean syntax.

**A4. C1’s archive-wide axiom prohibition is stronger than the proposed judges enforce. [High; R,T]**

There are two separate holes:

1. `lake check` rejects **uses** of nonstandard axioms. Its `usedAxioms` deliberately excludes a declaration’s reference to itself. An otherwise unused `axiom Bad : False` is therefore not rejected merely for existing.
2. Comparator exports the cones of selected targets. An unused sorried helper or forbidden axiom elsewhere in the proof package is outside those cones.

Thus [W4’s replacement of Replay and the axiom walk](/home/jan/git/lax/axiomfree-plan.md:210) does not implement “every declaration of both packages” in C1. Retain an explicit declaration-kind prohibition and comprehensive package policy checks, or narrow the promise to certified proof cones.

This is visible directly in [Axioms.lean:60](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/Check/Axioms.lean:60) and [Check.lean:529](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Check.lean:529).

Also, “axiom-free” must mean **no submission axioms beyond the permitted background**, not absence of axioms: C4 explicitly permits three.

**A5. The main attack classes have different outcomes; avoid treating them all as solved by C1.**

| Attack or construct | Assessment |
|---|---|
| Solution changes a statement definition to `True` under the same constant name | Comparator’s identical-constant-cone comparison should reject, provided the protected Challenge is authentic. **[High; T,K]** |
| A selected proof uses `sorry`, including through a helper | Rejected by the axiom walk; the spike confirms direct `sorryAx` rejection. **[High; T,R]** |
| `def Bad : Prop := sorry`, then an apparently harmless identity proof over `Bad` | Its theorem type reaches `Bad`’s body and therefore `sorryAx`; the selected cone should reject. Checking only proof bodies would be insufficient, but comparator also walks types. **[High; T,K]** |
| Forbidden axiom hidden in an opaque value | Opacity does not hide it from the comparator dependency walk: values are traversed with `allowOpaque := true`. **[High; T]** |
| Native computation used as proof authority | Reject its generated axiom. In this rc3, native proof machinery creates per-computation `_native…` axioms; checking only the historical name `Lean.ofReduceBool` would be wrong. **[High; T]** |
| `@[implemented_by]`, `@[extern]`, or unsafe tactic code | Runtime behavior is not certified by kernel checking. A checked safe proof must ultimately have a valid logical term; executable behavior still requires isolation and a Challenge policy. **[High; T,K]** |
| `partial`/`unsafe` declarations presented as “all declarations kernel-checked” | That claim is too broad. The exporter normally skips unsafe declarations; Lean replay explicitly skips unsafe and partial constants in its initial selection. **[High; T]** |
| `noncomputable` definitions or a theorem inside `noncomputable section` | Not intrinsically problematic. Judge the actual declaration and dependencies; classical choice is permitted. **[High; K]** |

Sources: [dependency traversal](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/Check/Util.lean:14), [native axioms](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/Lean/Meta/Native.lean:75), [export filtering](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/LeanExport/Basic.lean:255), [replay filtering](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/Lean/Replay.lean:176).

**A6. “Kernel-only” still includes comparison, parsing, primitive semantics, and execution integrity. [High; T,U,K]**

The bundled comparator explicitly compares kernel-sensitive constants such as Nat operations and String constructors. `leanchecker --from-export` also performs a quotient post-check after replay. Preserve these checks; a hand-selected theorem cone is not a substitute for comparator’s primitive handling. See [primitive targets](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Check.lean:474) and [quotient verification](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/LeanChecker.lean:60).

Independent kernels reduce dependence on one kernel implementation. They do not independently establish that the Challenge represents the website claim, nor repair a compromised comparator process. Nat/String reduction extensions and arithmetic libraries remain relevant implementation dependencies; Lean’s build configuration explicitly records a GMP minimum motivated by soundness bugs. [Lean build configuration](https://raw.githubusercontent.com/leanprover/lean4/v4.35.0-rc3/src/CMakeLists.txt).

## B. Contracts C1–C6

**B1. C1 needs an exact expression grammar and an explicit classification policy. [High; R,K]**

“Syntactically a constant under any universe instantiation and binder info” should become something implementable:

- A statement is a **safe definition declaration** with raw type `Expr.sort Level.zero`, if literal syntax is intended.
- A proof type consists of zero or more raw `forallE` nodes whose domains are statement `const` expressions, ending in a statement `const`.
- Specify whether expression metadata is stripped; do not silently use weak-head normalization.
- State whether private/inaccessible candidates are rejected or classified as helpers.
- State that proof declarations, not just statements, must be externally referenceable.

The distinction matters for these cases:

| Case | Recommended interpretation |
|---|---|
| `def S : Prop := ∀ n : Nat, P n` | Statement; the quantifier belongs inside its body. |
| `def S (n : Nat) : Prop := P n` | Parameterized predicate, not a closed statement. Decide whether allowed as an ordinary definition or rejected when intended as a statement. |
| `def AimpC : Prop := A → C`; `theorem q : AimpC` | Unconditional proof of the statement `AimpC`. It is not automatically the graph edge `{A} → C`. |
| `theorem q (h : C) : C := h` | Valid self-edge; it cannot ground `C` without another witness. |
| Duplicate hypotheses | Graph deduplication is logically fine, but retain the argument-position mapping for application. |
| Unused hypotheses | Count binders actually present in the stored theorem type. A surrounding section variable omitted by elaboration is not a hypothesis. |
| `def p : C := …` | A proof term, but not theorem-kind archive proof under C1. |
| `def D : Type := …` | Ordinary mathematical definition, not a proposition statement. Do not label checking its definition as proving a claim. |

The “helper whose conclusion unfolds to a statement” hint is especially underspecified. Many statement definitions can be definitionally equal; finding a matching statement may require expensive reduction/search. Keep that hint bounded and non-authoritative. See [C1](/home/jan/git/lax/axiomfree-plan.md:90).

**B2. Universe polymorphism is incompatible with the current name-only graph unless its semantics are restricted. [High; R,K]**

A closed proposition constant can still have universe parameters. `S.{u}` and `S.{v}` are not interchangeable merely because both are named `S`.

C1 permits arbitrary instantiations, while C6 stores only names. Consequently:

- A proof of `C.{0}` could be presented as a proof of the universally polymorphic declaration `C`.
- Hypotheses `S.{u}` and `S.{v}` could collapse into one assumption.
- Two edges with incompatible universe substitutions could appear composable.

Comparator catches an ill-typed **generated composition**, but cannot repair an already misleading graph or badge.

Before W1/W2, choose either a restricted initial universe policy or structured, level-aware graph endpoints and composition. Universe variables, their quantification, and substitutions are part of the mathematical claim—not optional display metadata. See [C1’s instantiations](/home/jan/git/lax/axiomfree-plan.md:102) against [C6](/home/jan/git/lax/axiomfree-plan.md:165).

**B3. C3 can be extracted without kernel checking, but its proposed fields are insufficient. [High; R,T,K]**

A raw expression walk can extract this restricted telescope without `isDefEq`. Be careful with `isProp`: “the declaration’s type is `Prop`” differs from the usual metaprogramming question “is this type a proposition?” For `def C : Prop`, you want to recognize `Sort 0`, not ask whether `Prop` itself has type `Prop`.

C3 must also specify:

- Declaration universe parameters in order, and a structured level-expression encoding.
- Ordered binder occurrences, preserving duplicates.
- Binder information, or an explicit rule canonicalizing wrappers to explicit arguments.
- Canonical internal names versus user-facing/private names.
- Statement body rendering, visibility/exposure, safety, and origin facts needed by C1.

The current inspector prints only axiom signatures at [Main.lean:595](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:595); adding `isProp` and `telescope` does not supply C6’s pretty-printed definition bodies.

Also distinguish policy from certification: a generated wrapper `theorem cert : C := q` can pass even when `q`’s original type is an unfolded version of `C`, or `q` is a definition. Comparator certifies the wrapper’s theorem, not C1’s structural classification of `q`.

**B4. C2 needs version-boundary decisions beyond its listed branches. [High; R]**

The manifest currently requires string `"1"`, while the proposed environment field is numeric `1 | 2`. Define the conversion and distinguish **content spec version** from **archive JSON schema version**.

Today:

- [manifest validation](/home/jan/git/lax/src/submission-validation/validators/manifest.ts:195) rejects spec 2.
- [archive snapshot loading](/home/jan/git/lax/src/submission-validation/archive/snapshot.ts:151) requires outer `specVersion: "1"`.
- [shared record types](/home/jan/git/lax/src/shared/types.ts:18) fix that outer field to `"1"`.

Keeping those outer schemas at version 1 may be entirely reasonable, but C2/C6 must explicitly say so. Otherwise separate implementations will disagree about what to bump.

“Branch at exactly” the listed places is also too restrictive: scaffolding, provisioning, captures, runtime invocation, artifact validation, and certification provenance require changes.

**B5. C4 is missing executable bundle requirements. [High; R,T,K]**

At minimum:

- Include **`lake-manifest.json`**. Bundled comparator refuses a source-based run without it; C4 omits it. See [checkManifest](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Check.lean:555).
- Define library targets and module/public-import structure.
- Specify application as something like `@Q.{…} …`, with the original argument order and duplicate mapping. Plain `Q h₁ … hₖ` is not correct for every implicit/instance telescope.
- Define immutable source snapshots for per-submit path dependencies and a sandbox-visible layout. Arbitrary external workspace paths are not automatically visible or writable inside comparator’s sandbox.
- Define the zero-edge case: comparator rejects an empty target configuration.
- Explicitly keep `definition_names` empty. These are definition **holes**, not a mechanism for naming immutable statement definitions.
- Bind target names one-to-one to structured edge identities and the protected Challenge export.

See [C4](/home/jan/git/lax/axiomfree-plan.md:134) and [empty-target rejection](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Check.lean:716).

**B6. C5/C6 need a durable certification record and a lossless regeneration path. [High; R,K]**

The existing [ProofEntry](/home/jan/git/lax/src/submission-validation/contracts.ts:359) holds only strings, and assumptions are currently [deduplicated and sorted](/home/jan/git/lax/src/submission-validation/phases/inspect.ts:193). C6 therefore cannot support W3’s database-only generation with the generality C1 permits.

Choose one:

1. Persist a versioned certificate descriptor containing the necessary telescope data.
2. Persist normalized certified wrappers with sufficient identity information.
3. Reinspect exact source snapshots during export, explicitly abandoning “database records alone” as sufficient input.

C5 should additionally bind the configuration, axiom policy, Challenge/Solution exports, source closure, verifier/workflow revision, actual kernel results, and complete toolchain identity. Executable digests alone may omit shared libraries; a distribution/image digest helps.

An environment-level “latest verdict” must not certify changed records by name alone. Require the exact database snapshot or independently verified content identity. Define partial failure, stale verdict, timeout, and revoked-verifier states. A checked proposition definition should receive a different status from a proved proposition.

## C. Comparator and Lake mechanics

**C1. The central comparator use is correct for protected, precisely generated targets. [High; T]**

The installed implementation:

- Compares target `ConstantVal`s rather than proving arbitrary definitional equality.
- Requires identical non-hole constants throughout the statement cone.
- Requires actual theorem-kind Solution targets in `checkAxioms`.
- Checks forbidden axioms through types and values.
- Replays the Solution export through the configured kernels.

See [Compare.lean:67](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/Check/Compare.lean:67) and [Axioms.lean:73](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/Check/Axioms.lean:73).

This supports the wrapper architecture. It does not establish the missing source, policy, and publication bindings identified above.

**C2. `permitted_axioms` is global; spec 2 benefits directly from avoiding claim axioms. [High; R,T,K]**

One run with permitted claim axioms `{A,B}` establishes only that every selected target stays within that global set. It does not establish one edge used only `A` while another used only `B`.

Explicit hypotheses solve this cleanly: keep the same background allowlist for every target, with edge assumptions in theorem types.

The spec-1 experiments are useful but narrower than archive certification:

- A real proof of `type_of% AxStmt` [passes](/home/jan/git/lax/spike/axiomfree/logs/spec1-ok.log:15).
- Returning the axiom itself [fails without permission](/home/jan/git/lax/spike/axiomfree/logs/spec1-ax-not-permitted.log:13).
- It [passes when that axiom is permitted](/home/jan/git/lax/spike/axiomfree/logs/spec1-relative.log:13).

`type_of%` extracts a type; it neither discharges the axiom nor establishes per-edge dependency attribution. These runs also use rc3, not the archive’s v4.33 environment.

**C3. Visibility already requires more than the charter’s proposed wording. [High; R,T]**

The spike demonstrates:

- `public def` without exposure prevented the proofs from unfolding the statements: [failure log](/home/jan/git/lax/spike/axiomfree/logs/lake-build-public-def-not-exposed.log:18).
- Nonpublic proof declarations were unknown in Solution: [failure log](/home/jan/git/lax/spike/axiomfree/logs/comparator-0-proofs-not-public.log:14).
- The working statements use [`@[expose] public def`](/home/jan/git/lax/spike/axiomfree/project/Concepts.lean:11).

Update W7’s scaffold and migration language accordingly. Exposure is an interface decision for clients needing the definition body; it is not a security sandbox.

There is another concrete integration gap: [capture sealing](/home/jan/git/lax/src/submission-validation/captures/seal.ts:53) copies old companion suffixes but omits the module builds’ `.olean.private`, `.olean.server`, `.ir`, and associated metadata. Those files exist in the spike’s output. C6’s “captures unchanged” cannot mean an unchanged implementation. Test private proof-body availability, inspector completeness, and downstream rebuilding against sealed read-only captures.

**C4. For decision 9.1, choose the VM with bubblewrap. [High; R,T,K]**

The host probe works; the Docker matrix needs both unconfined security profiles for the tested unprivileged setup. Those are observations about this host, not portable deployment guarantees. See [host probe](/home/jan/git/lax/spike/axiomfree/logs/bwrap-host.log:10) and [Docker matrix](/home/jan/git/lax/spike/axiomfree/logs/bwrap-docker.log:49).

The alternative “one Docker sandbox, comparator with `--inadvisably-no-sandbox`” loses an essential **internal** boundary. Malicious compilation then shares filesystem/process authority with the judge. For example, it can seek and overwrite temporary Challenge exports before comparison. Docker protects the host; it does not by itself protect the judge from another process inside that same container.

The installed no-sandbox path removes the mount restrictions and environment filtering imposed by bubblewrap: [Check.lean:203](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Check.lean:203).

A defensible Docker design would use separate disposable build/export containers and a clean judge consuming sealed exports. That is a third architecture, not the charter’s “nothing new” option. Preserve the existing CPU, memory, PID, disk, output, and timeout controls when moving work onto the VM.

The local automatic no-sandbox fallback in W4 should likewise require deliberate opt-in and must not emit an equivalent trustworthy-certification status.

**C5. For decision 9.2, provisionally require `--paranoid` per submission. [Medium; R,T,K]**

The small bundle currently costs approximately **31 seconds with all bundled checkers**, versus **10 seconds with Lean alone**. That is insufficient evidence to relax the proposed independent-kernel promise.

Make this provisional pending a representative large submission. If the full set is impractical, explicitly revise the policy to Lean plus a named independent subset per submission, with all checkers on schedule. Do not silently label a Lean-only result as having passed independent kernels.

`leanchecker-paranoid` is another Lean checker configuration, not a fifth independent kernel implementation. The bundled list is explicit in [Check.lean:572](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Check.lean:572).

**C6. Cost is per exported union of cones per run, not necessarily per theorem. [High; T,R]**

Comparator exports all configured targets together, and the exporter deduplicates visited constants. Separate runs repeat their common mathlib cone; batching can amortize it. Conversely, `lake check` exports everything in scope from its default modules, which can be much larger.

Therefore sharding is a memory/parallelism tradeoff, not automatically a reduction in total cost. Measure single-target runs, a per-submission batch, and larger batches before selecting shard boundaries. See [comparison export targets](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Check.lean:529) and [check export](/home/jan/.elan/toolchains/leanprover--lean4---v4.35.0-rc3/src/lean/lake/Lake/CLI/Main.lean:1218).

## D. Spike coverage

**D1. The spike provides useful positive evidence, but not the full W0 gate. [High; R]**

At the inspection cutoff:

| Observation | Evidence |
|---|---|
| Warm ordinary comparator passed in 9.98 s | [log](/home/jan/git/lax/spike/axiomfree/logs/comparator-2-warm.log:14) |
| All bundled checkers passed in 30.72 s | [log](/home/jan/git/lax/spike/axiomfree/logs/comparator-3-paranoid.log:14) |
| Whole default-target `lake check` passed in 284.56 s | [log](/home/jan/git/lax/spike/axiomfree/logs/check-1.log:7) |
| Unfolded wrapper conclusion rejected by comparator | [log](/home/jan/git/lax/spike/axiomfree/logs/neg-a-defeq.log:14) |
| Sorried selected theorem rejected | [log](/home/jan/git/lax/spike/axiomfree/logs/neg-b-sorry.log:15) |
| First cone passed all listed checkers | [cone log](/home/jan/git/lax/spike/axiomfree/logs/replay-cone1.log:1) |
| Bertrand export was already about 185 MB; ordinary replay took 66.16 s | [cone log](/home/jan/git/lax/spike/axiomfree/logs/replay-cone2.log:1) |

The full three-cone/all-kernel results and REPORT were not available at that cutoff. These small-project results do not establish the Lax17 cost model.

**D2. The logged shadow tests did not exercise the intended comparator rejection. [High; R]**

The original shadow run failed during elaboration because the replacement definitions were not exposed: [log](/home/jan/git/lax/spike/axiomfree/logs/neg-c-shadow.log:15). The both-imports version failed on a duplicate declaration during import: [log](/home/jan/git/lax/spike/axiomfree/logs/neg-c2-shadowboth.log:14).

During review, [`ConceptsShadow.lean`](/home/jan/git/lax/spike/axiomfree/project/ConceptsShadow.lean:11) gained `@[expose]`. That repairs the first test’s construction; it still needs a corresponding completed rerun demonstrating a **constant mismatch after successful Solution elaboration/export**.

The spike already has same-name definitions in a different module and public imports. The missing evidence is a successful adversarial build reaching comparison, plus realistic package-prefix and artifact-shadowing variants.

**D3. These adversarial boundaries remain unexercised. [High; R,K]**

Add:

- A concept dependency whose elaboration/import executes code and attempts to alter Challenge interpretation.
- A proof build attempting to overwrite Challenge artifacts, dependency artifacts, configuration, exports, or verdict output.
- Cold versus deliberately poisoned warm build state.
- A same-name replacement definition behind a re-exporting root module.
- Fixed published module names versus randomized protected module prefixes.
- A Solution target supplied as an axiom or definition instead of a theorem.
- Primitive/quotient tampering in an export.
- A source-to-record or record-to-target mismatch where both generated Lean files agree on the wrong edge.

The existing project exercises ordinary imports in one Lake project. It does not exercise the archive’s distinct concept/proof packages, source triples, sealed captures, generated manifests, and publication boundary.

**D4. C1/C3 require a classification matrix, including positive edge cases. [High; R,K]**

Missing cases include:

- Section parameters creating a nonclosed statement, versus parameters correctly placed inside `∀`.
- Universe-polymorphic statements, different instantiations of the same statement, and incompatible composed edges.
- Explicit, implicit, strict-implicit, and instance binders; duplicates and reordered hypotheses.
- Private statements/proofs, exposed and unexposed aliases, and a theorem inside `noncomputable section`.
- A self-edge whose conclusion is also a hypothesis.
- An unused hypothesis retained in the theorem type, versus a section variable omitted by elaboration.
- `AimpC` as an atomic statement, parameterized predicates, and Type-valued definitions.
- Unused axioms, unused sorried helpers, sorried statement bodies, opaque dependencies, and native-generated axioms.
- Frontmatter on both structural proofs and helpers.
- A package with no certified proof targets.

Several should pass. In particular, self-edges and noncomputable-section theorems are not inherently invalid.

The current unfolded-conclusion test changes the **certificate wrapper**. It does not demonstrate that the inspector correctly classifies an original theorem with an unfolded conclusion.

**D5. The scripts record results but do not enforce an expected-result test suite. [High; R]**

[`run-timed.sh`](/home/jan/git/lax/spike/axiomfree/scripts/run-timed.sh:19) records the child status, then finishes with `echo`; it does not return the recorded status. [`run-all.sh`](/home/jan/git/lax/spike/axiomfree/scripts/run-all.sh:9) also does not assert expected successes or particular rejection reasons.

That is acceptable for collecting exploratory logs, but not a regression gate. Require expected phase/reason, so an elaboration error cannot masquerade as a successful security test.

The direct replay script’s NanoDa configuration sets `unpermitted_axiom_hard_error=false`, as the upstream runner does. Its success is kernel-replay evidence, not independently sufficient evidence of the archive’s axiom policy. See [replay-cone.sh](/home/jan/git/lax/spike/axiomfree/scripts/replay-cone.sh:26).

**D6. Before deciding 9.1/9.2, measure the actual proposed pipeline. [High; R,K]**

Use a representative large submission and a cross-submission chain, through the real package/capture layout. Record:

- Cold and warm build, export, comparison, and each kernel separately.
- Per-theorem versus batched union sizes and times.
- Full-package hygiene checking separately from selected-edge certification.
- Aggregate process-tree/cgroup peak memory, temporary disk, and export bytes.
- Exact production resource limits, including execution alongside the paper workload.
- Cancellation, timeout, missing checker, and checker-disagreement behavior.
- The never-ran-lax rerun from a complete bundle and manifest.

The roughly 16-fold export-size difference already seen between the first two cones warns against extrapolating from module counts alone.

## E. Palomar comparison

**E1. Copy Palomar’s protected-statement and provenance architecture. [High; U,K]**

Current Palomar code sets a minimum of **v4.35.0-rc2**, uses the submitted toolchain’s judge/exporter/checkers, and records toolchain commit and tool digests. Its protected configuration selects bundled NanoDa and con-ron alongside Lean. It separately constructs the protected Challenge and judges exported inputs. These are useful precedents, more specific than “Palomar runs comparator on a VM.” [Toolchain minimum](https://raw.githubusercontent.com/PalomarRegistry/PalomarSubmission/main/toolchains.json), [current verifier](https://raw.githubusercontent.com/PalomarRegistry/PalomarSubmission/main/scripts/verify_submission.py).

Copy immutable statement identity, protected configuration, actual checker provenance, and durable mechanical reports. Do not make a run URL the sole lasting evidence.

Some policy prose still describes the older separately pinned tooling arrangement; use the implementation and recorded verification generation when making comparisons.

**E2. Its dependency allowlist is a substantive trust restriction that lax cannot inherit by analogy. [High; U,R,K]**

Palomar permits authenticated mathlib, Tau Ceti, and CSLib closures, and explicitly does **not** make previously registered projects trusted Challenge dependencies. [Allowlist](https://raw.githubusercontent.com/PalomarRegistry/PalomarSubmission/main/allowed-challenge-repositories.json), [submission policy](https://raw.githubusercontent.com/PalomarRegistry/PalomarPolicy/main/CONTRIBUTING.md).

Lax deliberately wants other submitters’ concepts as statement dependencies. That is a different trust problem. Copy closure authentication and protected artifacts, but solve the additional concept-language/provenance problem explicitly. Registration alone is not a substitute.

**E3. Preserve frozen evidence; do not freeze the assessment of its reliability. [High; U,R,K]**

Palomar states that registered versions are not rerun against later Lean/mathlib releases; updated sources become new verified versions. It also describes the recorded toolchain/tool provenance and remaining limitations. [Palomar’s version and verification policy](https://palomar-registry.org/about).

Decision 4 is reasonable for reproducing **what judge accepted this artifact**. The risk register’s stronger acceptance—bugs are remedied only by admitting a new environment—is inadequate for a continuing “certified” assurance.

Keep source environments immutable, but allow:

- Security advisories against a judge version.
- Suspension or qualification of affected certification badges.
- Additional checks of preserved exports with compatible fixed tooling.
- A new attestation without rewriting the historical one.

A newer Lean cannot simply load an older environment’s oleans. Compatibility must be established for the export format and semantics, or a supported/backported verifier used. Porting the source is a separate operation. Revisit [the frozen-judge risk](/home/jan/git/lax/axiomfree-plan.md:297) accordingly.

## F. Program shape

**F1. The critical path omits the hardest prerequisite. [High; R,K]**

W0 → W2 → W3 → W4 is incomplete. The path should begin with:

1. Trusted concept/Challenge construction and artifact provenance.
2. Lossless edge identity, universe policy, and certification semantics.
3. Revised contracts and spec draft.
4. One complete inspector → generator → isolated judge → published-evidence implementation.
5. Scaling, scheduling, website integration, and rollout.

W1’s dependency on W0 is not “one word”: it includes exposure, private declarations, module sidecars, whole-package checking, and sandbox structure. The [current parallel-start claim](/home/jan/git/lax/axiomfree-plan.md:261) overstates contract maturity.

**F2. Assign ownership to the missing interfaces before splitting work. [High; R,K]**

Add explicit owners for the concept gate, C2/schema migration, certificate descriptor, capture format/provenance, verifier policy, and verdict authentication.

Merge W3’s minimal generator with W4’s first integration milestone. A generator that passes handwritten fixtures but cannot use protected imports and sealed archive dependencies is not yet the component W4 needs.

Website layout can proceed on provisional fixtures, but certification semantics and parsing must wait for the descriptor and verdict contracts.

**F3. Reduce initial scope around the sound core. [Medium; R,K]**

I would defer broad automated axiom rewriting and whole-environment monolithic certification.

The proposed textual `axiom X : T` transformation needs to distinguish proposition types, parameter telescopes, universes, and Type-valued axioms. A warning per line does not make a general rewrite reliable. Start with guided migration and a few real ports. See [W7](/home/jan/git/lax/axiomfree-plan.md:233).

Initially certify submissions and composed witnesses with immutable attestations. Add scheduled batching after measuring union-cone reuse. Preserve the independent-rerun gate; it is one of the charter’s strongest requirements.

**F4. Dual-spec archival support is the right cut; close spec-1 admission at the epoch flip. [High; R,K]**

Keep old environments readable and reproducible, clearly labeled with their historical assurance. Do not add retroactive spec-1 certification to this program. Environment separation is a good mathematical and operational boundary.

Closing spec 1 does **not** remove the old validator: existing records and grandfathered drafts remain admissible under today’s [closure rule](/home/jan/git/lax/src/submission-validation/environments.ts:164). If “close” is intended to stop further Lean submissions to old drafts, that is an additional lifecycle decision.

My choice is closure to new records at the flip, explicit treatment of existing drafts, and successor records for ports. Maintain both validation paths while necessary, with version decisions concentrated at named interfaces rather than scattered conditionals.

## Top 10 things to change before implementation starts

1. **[High; R,K]** Add a mandatory, owned trust contract for concept elaboration and protected Challenge provenance.
2. **[High; R,K]** Bind every displayed certified edge/status to the exact exported theorem, source identity, and verdict.
3. **[High; R,K]** Resolve universe semantics and persist enough ordered telescope data to regenerate and compose certificates.
4. **[High; R,T]** Retain complete declaration-policy checks; selected comparator cones and `lake check` do not enforce C1.
5. **[High; R,T,K]** Choose bubblewrap on the VM, or genuinely separate build/export/judge containers; reject the single-container no-sandbox equivalence.
6. **[High; R,T]** Complete C4 with a manifest, module targets, exposure rules, explicit applications, and zero-edge behavior.
7. **[High; R,T]** Extend capture handling for module-system artifacts and require a sealed-capture reimport/export test.
8. **[High; R,K]** Turn W0 into an expected-result adversarial suite and measure a real large archive submission with batching.
9. **[High; R,U,K]** Separate immutable historical attestations from current verifier reliability, including invalidation and rechecking policy.
10. **[High; R,K]** Rewrite the workstream dependencies and version boundaries before declaring C1–C6 ready for parallel implementation.