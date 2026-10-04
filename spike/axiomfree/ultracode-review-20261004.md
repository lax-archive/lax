# Ultracode review of the `axiomfree` branch, 2026-10-04

Scope: lax `axiomfree` at 64c623a and lax-website `axiomfree`, diffed against `main`. The prior reviews in `spike/axiomfree/` (REPORT, codex ×4, commonsense, fable, namespace, verification) were read first. Findings they already raised and closed are not repeated here. Each finding below was checked by three verifiers (facts, merit, exploit), and the severity given is their corrected one. I re-checked the top items against the tree myself:
- `git()` in `src/cli/certify.ts:631-641` sets only `GIT_CONFIG_NOSYSTEM`.
- `BUNDLE_FILES` (`generate.ts:59-65`) has five files and no `lean-toolchain`.
- `inspect-spec2.ts:140,161` handles near misses with a silent `continue`.
- `term()` in `compose.ts:79` has no memo.
- `artifact-schema.ts:415-450` checks probes, kernels and `challengeText` exactly.
- `verify-bundle.ts:158` uses a synthetic resolution.
- `cli/certify.ts:347` and `provision.ts:168` sort with `localeCompare`.

## 1. Verdict

The architecture is sound. Decision 10's split is right, and the mechanism a Lean user would recognise is in place: `lake comparator` judges a Challenge/Solution pair with the kernel, and the Challenge is checked structurally against the telescopes. It is not yet idiomatically clean, for three reasons:
- **One real sandbox escape on the reader's side.** `lax certify --run` runs host git in a tree the sandbox could write.
- **Machinery that exists only for lax's own wrapper.** The `Cert.<id>` Solution and container B1, the binder kinds, and a private name encoding that differs from Lean's.
- **Rules copied into several call sites that have already drifted.** Name grammars, bundle assembly, Certify orchestration.

The most important change is the security fix: never run git or anything else on the host in a tree a sandboxed run could write (finding S1). The most important conceptual change: judge the author's own constant directly by naming each Challenge theorem after the proof, and drop Solution.lean and B1 for records (C1). Several record-shape findings change the Challenge text, the bundle format or the record shape: C1, C2, C3, C5, M1 and I1. All of them are free now and expensive after the first spec-2 record, so they should land before stage 6.

## 2. Conceptual simplifications

### C1. Judge the proof package itself: name each Challenge theorem after its proof, drop Solution.lean and container B1
- **Severity:** medium.
- **Where:** `certify/phase.ts:370-455`, `certify/generate.ts:82-84,150-160,229-256`, `certify/host.ts:205-216`, `spec_v2_draft.md:1812-1830`, `axiomfree-plan.md` decision 10 (A1/A2/B1/B2/C).
- **Problem:**
  - The comparator looks up each theorem name in both exports and compares `ConstantVal` with `Expr.eqv`, which ignores binder names and annotations.
  - The generated `Cert.<id> := @<id> h…` wrapper is the only reason Solution.lean exists. B1 exists only to build that wrapper, and B1 is the one Certify container that runs proof-package code.
  - A scratch run on v4.35.0-rc3 shows the wrapper is unnecessary. A Challenge `theorem Proofs.q (h₁ : A) : C := sorry` against a plain `leanexport Proofs` is accepted. That holds for `variable`/`include` binders and for implicit binders. A Challenge with a wrong statement is rejected.
  - The name cannot collide in the Challenge, because the Challenge imports concept packages only and proof ids live under `…Proofs`.
  - The proof package has exactly one `lean_lib` root, and that root imports every module, so `leanexport <ProofsRoot>` reaches every proof.
- **Recommendation:**
  - For per-record bundles, give each Challenge theorem the proof's canonical id (keep `_root_` on the statement references), and set `solution_module` to the proof package root.
  - Replace B1+B2 with one read-only `leanexport <ProofsRoot> -- <targets>` over the proof capture, with `/out` the only writable mount.
  - Delete the per-record `solutionText`, the `Cert.` naming for edges and the `solution-build` violation together with its contested intent.
  - Keep the generated Solution, `rootName` and the naming for relative certificates, which genuinely compose. Say in the draft that the two bundle shapes differ by that one file.
  - Add tests for: a proof via `variable`/`include`; instance and implicit binders; a universe-polymorphic proof; a source-mode `lake comparator` rerun where `solution_module` is in a dependency package; and a stored proof type carrying mdata. The last one is now refused by `Expr.eqv` instead of passed through the wrapper. That fails safe, but it should be documented.
- **Revisits:** decision 10 / Certify step 3, and the draft's `Cert.<proof-id>` naming.

### C2. Recorded binder kinds are dead weight, and the author guide's instance-binder advice is wrong
- **Severity:** medium.
- **Where:** `contracts.ts:416,425,438`; `inspect-runner.ts:150,240-243`; `artifact-schema.ts:835,851-858`; `generate.ts:138-149,194-206`; `challenge-check.ts:67`; `compose.ts:146`; `Main.lean` `jsonOfBinderInfo`; `assets/instructions.md:125-128`; `spec_v2_draft.md:690-692,1818-1826`; lax-website `types.ts:87`, `database.ts:165-167`, `pages/shared.ts:129,162` (it does render `binderLabel`).
- **Problem:**
  - The draft justifies recording binder kinds "so the generated certificate can apply the proof with `@`". But `@` is exactly what makes binder kinds irrelevant, and the draft's own line 1826 says so.
  - The kernel's defeq and `Expr.eqv` ignore BinderInfo. Challenge and Solution are generated from the same text, so the certificate's binders agree by construction.
  - Still, the field travels through the inspector JSON, two contract types, two validators, the immutable record, the website label, a four-way renderer and a challenge-check comparison. It also puts a `set_option checkBinderAnnotations false in` toggle into the reader-facing Challenge.
  - `compose.ts` already writes `binder: "default"` for every hypothesis, and nothing breaks.
  - The guide's reason for using it is false. With `def S : Prop := True`, `theorem inside [h : S] : S := inferInstance` fails with "type class instance expected S", because instance resolution never finds a local of a `Prop` def that is not a class.
- **Recommendation:**
  - Always generate `(hᵢ : Sᵢ)`.
  - Delete `binder` from the telescope everywhere (inspector, contracts, both validators, record schema, website type and label), along with `binder()`, the guard, the challenge-check comparison, `compose.ts:146` and the instructions paragraph.
  - Reword the draft: binder names and kinds are not part of an edge and are not recorded.
  - Proof-hood keeps accepting any binder kind.
- **Revisits:** the "Proof package" design paragraph, and the resolution of Codex-intents finding 7 (preserve rather than normalize).

### C3. Use Lean's own `Name.toString` (escaped) for spec-2 names, and have one name grammar instead of several (merges two findings)
- **Severity:** medium.
- **Where:** `Main.lean:455-486` (`isCanonicalName`, `canonStr`, and the false comment at :468-473), `:837` (`nameStr`, `escape := false`), `:902-925` (`nonCanonical`); `inspect-spec2.ts:149` (the `includes("«")` sniff), `:338-357`; `inspect-common.ts:76-95`; `certify/lean-name.ts` (the whole lexer transcription); `contracts.ts:366-367` (`LEAN_NAME_PATTERN`); `artifact-schema.ts:1138-1141`; `outputs.ts:270-300`; the `LEAN_NAME` copy in lax-website.
- **Problem:**
  - Spec 2 prints names with `escape := false`, which is not injective (`A.«B.C»` vs `A.B.C`). The inspector then adds `isCanonicalName`, `canonStr` and a `nonCanonical` sideband, writes non-canonical names in the escaped form in the same field, and the TS side tells the two forms apart by sniffing for `«`.
  - On the pinned toolchain, Lean's escaped printer already round-trips through `String.toName`, which is the function `lake comparator` uses for `theorem_names`. `.str A "3"` prints as `A.«3»`, `.num A 3` prints as `A.3`, and `A.«B.C»` is preserved.
  - So the Main.lean comment claiming the escaped form is not injective is false. The residual `.num`/`.str` hole that verification C1-1 accepted exists only because of the unescaped form.
  - Separately, the archive has disagreeing grammars:
    - The inspector and `lean-name.ts` admit `!` and `?` (`isIdRest`).
    - Hygiene admits Common-script characters but refuses `\p{M}`.
    - `LEAN_NAME_PATTERN` refuses `!`, `?` and letterlike characters (`℘`) but admits `\p{M}`.
  - Consequence: `Lax1.C.good?` or `Lax1Proofs.main!` passes Inspect and Certify. `requirePublishableReport` then rejects the report as a non-retryable **infrastructure** failure ("not the submission's fault") instead of giving a rename finding.
- **Recommendation:**
  1. Bug fix now: export one archive-name predicate from contracts.ts. Decide deliberately whether to admit `!`/`?`; admitting them is the better choice, since `get?` is idiomatic. Reconcile `\p{M}` between the pattern and hygiene. Apply the predicate in `checkCanonicalName` and to level params as a `translation` finding. Make `identifier()` and the website import or mirror the same definition, and add a test that every name Inspect admits parses under the schema. Fix the false Main.lean comment.
  2. Structural fix: print spec-2 names with Lean's escaped `Name.toString`, as spec 1 does. The endpoint and universe rule becomes "the printed name contains no `«`", with one guard for components containing `»`. This deletes `canonStr`, `isCanonicalName`, `nonCanonical`, the `«` sniff and most of lean-name.ts. Exotic endpoints (`«定理»`) become refusals. If they must stay, emit names as JSON component arrays with the private prefix as a separate field, and derive one TS `canonicalName()` shared by the classifier, the publisher and the generator.
- **Revisits:** decision 10, "Names must round-trip"; Codex 2026-10-03 finding 4.

### C4. Certify orchestration is written three times, and the copies have drifted
- **Severity:** low (one verifier said medium).
- **Where:** `certify/phase.ts:271-461`, `certify/host.ts:104-216`, `certify/self-test.ts:162-337`, `certify/verdict.ts:1-5`, `cli/certify.ts:655-690`.
- **Problem:**
  - `phase.ts` writes A1/A2 and B1/B2 as near-identical blocks.
  - `host.ts` has its own `buildAndExport`.
  - `self-test.ts` builds its own mounts and plans, inlines `writeJudgeProject`, and copies the comparator plan JSON byte for byte.
  - `sha256File` exists three times, `boundary` twice, `exportedFile`/`readExport` twice.
  - `verdict.ts` claims to be "the one reading" of the transcript, yet `host.ts:229` and `cli/certify.ts:679` each have their own `unknown (sub)command` regex.
  - `host.ts` imports `nameViolation` and `readChallengeReport` from the trusted container module, so the dependency points the wrong way.
  - The drift is already visible to authors. The verification-review wording for `challenge-build` ("if every concept package … builds cleanly") landed only in `phase.ts`. `host.ts` builds with `compileLeanThreads` and judges with `leanThreads`.
  - The self-test header claims it runs "through the very containers, mounts and limits the record will go through". In fact S1/S2 run in the `judge` runtime while A1/A2 run in `lean`, and A2's inspector step is never exercised.
  - Not drift: `host.ts` has no exit-2 branch, but exit 2 is a `run-certify.mjs` convention that the host path never goes through.
- **Recommendation:**
  - Move `sha256File`, `boundary`, `exportedFile`, `readChallengeReport` and `nameViolation` into one shared certify module.
  - Move the no-comparator detection into `interpretComparatorRun`.
  - Give each rule's message (`challenge-build`, `solution-build`, `name`) a single source.
  - Factor `phase.ts` A and B into one `buildAndExport(side)`.
  - Have the self-test call container C's judge-plan and mount builder.
  - Either reword the header or run S1/S2 in the `lean` runtime.
  - Keep the separate Challenge build and inspection on the host. Collapsing to a single `lake comparator` run would turn a `translation` failure into a `judge` failure and lose the telescope check that runs first.
- **Revisits:** none.

### C5. The certificate block stores constants and duplicates of the row
- **Severity:** low.
- **Where:** `contracts.ts:597-688`, `artifact-schema.ts:396-460`, `recorded-shape.ts:1-22,57`, lax-website `database.ts:205-243`.
- **Problem:**
  - `recorded-shape.ts` drops `capture.leanToolchain` because it duplicates the row, but stores `certificate` whole.
  - `judge.comparatorExitCode` is always 0, `selfTest.passed` is always `true`, and `judge.toolchain` must equal the row's toolchain.
  - The website copy marks `solutionExportSha256` optional while lax requires it.
- **Recommendation:**
  - Drop `comparatorExitCode` and `judge.toolchain`, and fill them from the row in `expandRecordedBuildOutput`.
  - `selfTest.passed` only goes if the local `passed: false` shape changes too (see I6).
  - Keep `kernels`, the probe list and the export digests: they are historical attestation, and S6 covers how to parse them.
  - Make the website require `solutionExportSha256`.
- **Revisits:** "Record shape for spec 2".

### C6. `lax generate-prooftree` is a spec-1 composer that is still advertised and not gated
- **Severity:** medium.
- **Where:** `assets/prooftree/Main.lean:328-330`, `cli/prooftree.ts:215-300,492-596,668-700`, `test/unit/prooftree.test.ts:246-300`, `cli/certify.ts:517`, `cli/main.ts:60`, `README.md:225,448`, `spec_v2_draft.md:2441-2449`.
- **Problem:**
  - The composer throws `conclusion … is not an axiom` for any non-axiom, and every spec-2 statement is a `def`.
  - On a spec-2 target the tool still downloads and verifies the whole capture closure before it fails.
  - About 70 lines of sidecar inventory, with tests (stage-3 hardening item 3), exist only for spec-2 captures in this tool, a path that can never succeed.
  - `certify.ts:517` tells authors that `generate-prooftree` "reports the same leaves".
  - `lax certify <statement>` without `--relative-to` is the spec-2 counterpart.
- **Recommendation:**
  - Refuse spec-2 targets before any download, pointing to `lax certify <statement>`.
  - Delete the sidecar inventory and its tests.
  - Have `certify.ts` list `selection.unresolved` itself.
  - Label both commands spec 1 / spec 2 in README and `main.ts`.
  - Resolve the draft note.
- **Revisits:** stage-3 hardening item 3.

### C7. Statement `body` and the spec-2 statement `signature` are stored but never used
- **Severity:** low.
- **Where:** `Main.lean:989-992`, `contracts.ts:393-395,559-560`, `artifact-schema.ts:778,792`, `inspect-spec2.ts:279-293`, `inspect-runner.ts:208`, the spec-2 golden, lax-website `types.ts:66-70`, `spec_v2_draft.md:2185-2187,1044-1050`.
- **Problem:**
  - `body` is a pretty-print in core notation. It has to be, because `loadExts := false` is a deliberate security choice. Nothing reads it, and the website states that it is "Carried, not shown".
  - The draft says a statement card shows the body; the website shows the source range.
  - The spec-2 `signature` is always `Name.{us} : Prop`, so it can be derived from `id` + `levelParams`. The graph panel does display it.
- **Recommendation:**
  - Remove `body` everywhere before the first record.
  - Derive the signature when reading, or have the schema require exactly the derived form.
  - Fix the draft's two passages.
  - If a per-statement identity is wanted for revalidation, design it separately as a hash of the value Expr.
- **Revisits:** the plan's Inspector item ("pretty-printed body … for the website").

### C8. Dead exports and small re-derivations
- **Severity:** low.
- **Where:** `generate.ts:86-105,365-368`, `inspect-spec2.ts:229-231`, `recorded-shape.ts:33-38`, `self-test.ts:73-79`.
- **Problem:**
  - `edgesOf`/`CertificateEdge` are used only in a test, and their docstring ("for findings and for the website") is false.
  - `textDigest` has no caller.
  - The classifier re-derives `conclusion`/`assumptions` inline, a copy of `derivedEdge`.
  - `selfTestComparatorConfig` string-replaces inside `JSON.stringify` output. Existing tests pin the result, but the pattern is poor.
- **Recommendation:**
  - Delete the three unused exports.
  - Use `...derivedEdge(recorded)` in the classifier.
  - Give `comparatorConfigFor` a `modules` parameter.
  - Moving local mode out of the planner belongs with I2, not here.
- **Revisits:** none.

## 3. Security and binding

### S1. `lax certify --run` runs host git in checkouts a sandboxed run could write, and `core.fsmonitor` turns that into code execution
- **Severity:** high.
- **Where:** `cli/certify.ts:576-629` (`verifyCertificateWorkspace`, `git status` at :607), `:631-641` (`git()` sets only `GIT_CONFIG_NOSYSTEM`/`GIT_TERMINAL_PROMPT`), `:104` (`REUSABLE_ENTRIES` keeps `.lake`); Lake `Check.lean:356-375` (`safeLakeBuild` mounts `projectDir/.lake` writable).
- **Problem:**
  - The fix for Codex-2 finding 3 checks every `.lake/packages/<name>` with `git rev-parse` and `git status --porcelain --ignored`, outside the sandbox, before each `--run`.
  - The comparator's sandboxed `lake build` has `.lake` writable, and proof-package code runs there. For a relative certificate, that means any record on the composed path.
  - That code can write `[core] fsmonitor = "<cmd>"` into `.lake/packages/<any>/.git/config` while HEAD and the worktree stay clean.
  - On the next `--run` into the same default folder, `git status` executes `<cmd>` as the user, with network and `$HOME`.
  - Reproduced with git 2.43: the exact invocation from line 607 runs the hook and exits 0 with empty output.
  - bwrap's uid mapping makes the planted files owned by the user, so `safe.directory` does not help. Gitfile redirects show that patching individual config keys cannot close this class.
- **Recommendation:**
  - Structural fix: never run host git or lake on a tree the sandbox could write. Keep verified package checkouts and the mathlib cache in a lax-owned store that the comparator mounts read-only (it already binds the Lake home read-only), and treat the writable `.lake` as disposable per run. This also closes the TODO(decision 10) residue at certify.ts:599-603 about planted library `.lake/build` products.
  - Stopgap until then: `git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -c protocol.allow=never`, with `GIT_CONFIG_GLOBAL=/dev/null`. Refuse any checkout whose `.git` is not a plain directory, or whose `.git/config` holds keys beyond the ones Lake writes.
  - Audit every other host-side git or lake call on a reused certificate folder.
- **Revisits:** the Codex-2 finding 3 fix.

### S2. `lax certify --run` skips the Challenge-to-telescope check
- **Severity:** medium (one verifier said low).
- **Where:** `cli/certify.ts:160-178`, `certify/challenge-check.ts`, `certify/phase.ts:365`, `certify/host.ts:186`, `axiomfree-plan.md:196-199`.
- **Problem:**
  - `checkChallengeReport` runs only in A2 and on the host path.
  - The reader's rerun prints "Certified" from the comparator verdict plus a Challenge *text* comparison. So the reader again rests on the archive's global-syntax rule alone, which is exactly what the plan says "is not the defence".
  - No relative certificate is ever held to a telescope anywhere.
  - Note that drafts on the island did pass the standards rule. No concrete exploit was built; this is defence in depth against holes in that rule. It is also namespace review §5 Q1's reader half, which is still open.
- **Recommendation:**
  - Factor one "held to the telescope" step: inspect the built Challenge olean with the per-environment inspector, then run `checkChallengeReport`, generalised to take the expected `{name, levelParams, telescope}` list.
  - Use it in A2, on the host, and in `lax certify --run`, including relative certificates.
  - If the inspector is unavailable, print "comparator accepted; Challenge meaning not checked" instead of "certified".
- **Revisits:** decision 10, where the E1 defence currently lives only in the pipeline.

### S3. The publisher does not repeat the translation's referential checks
- **Severity:** low (one verifier said medium).
- **Where:** `certify/verify-bundle.ts:150-163`, `certify/project.ts:184-212`, `artifact-schema.ts:162-185,800-875`, `shared/submit-publisher.ts:294-300`, `cli/certify.ts:372-376`.
- **Problem:** Under trust rule 2 the publisher should repeat these checks, and does not:
  - **(a)** `verify-bundle` passes `{concepts: [], proofs: dependencies, all: dependencies}`, so every closure package counts as a direct require. The reader CLI enforces the rule the writer does not.
  - **(b)** No check that each telescope endpoint is a statement of the record or of a direct concept require, even though the publisher has just re-read the dependencies' `statements`.
  - **(c)** A `draft` dependency is admitted. This gap already exists on main.
  - All three matter only for a forged validate report. A forged report can already publish an edge the judge never accepted, so this is hardening.
- **Recommendation:**
  - This closes the existing TODO "carry the direct-require set" (Fable 1.4). The direct set is already `buildOutput.requiredByProofs`, so no schema change is needed.
  - Pass a real resolution (`proofs` = dependencies in `requiredByProofs`, `all` = the closure).
  - Add one membership check beside `validateDependencyGraph`.
  - Refuse any dependency that is not `registered`.
  - Add a forged-report unit test for each.
- **Revisits:** none.

### S4. Judge tool digests are self-attested and pinned nowhere
- **Severity:** low (one verifier said medium).
- **Where:** `certify/phase.ts:267,505`, `certify/self-test.ts:149-173`, `artifact-schema.ts:419-421`, `pins.ts`, `host/setup.ts`, `submission.yml:210-218`, `contracts.ts:600-613`.
- **Problem:**
  - Nine `JUDGE_TOOLS` digests are recorded and only compared before against after. Every container mounts the toolchain read-only, so that comparison guards nothing.
  - Nothing compares the digests with a known value. The toolchain comes from elan or an Actions cache restore, while images, TeX and ReflowTeX are pinned by digest.
  - The website drops `tools` entirely.
  - Decision 5's "frozen with the environment" is therefore declared, not enforced. The contracts comment ("so a later reader knows which bytes judged it") promises a check no reference makes possible.
- **Recommendation:**
  - Record the sha256 of all nine binaries per environment row at admission, and add that to the checklist.
  - Verify them fail-closed in `host/setup.ts` after install and after cache restore.
  - Have `lax doctor`/`certify` report match or mismatch.
  - An equality check in `parseCertificate` is cheap consistency but not a security boundary.
  - Delete `verifyToolDigests`, or document it as a host-race check only.
- **Revisits:** decision 5.

### S5. The inspector's extension readers un-mangle private names before `unsafeCast`
- **Severity:** low. Two verifiers hold it as defence in depth; the merit verifier rejects it as a security finding.
- **Where:** `Main.lean:657,682,705,732,757,793`.
- **Problem:**
  - Every reader matches `(privateToUserName? extName).getD extName == expected` and then casts the entries.
  - A `private initialize laxStatementAttr : SimplePersistentEnvExtension Nat …` in `namespace LaxCore` elaborates and un-mangles to the expected name, so its `Nat`s are cast to `Name`.
  - This always needs an `@[init]`, so the package is rejected anyway, but only after the inspector has run.
  - The merit verifier's point stands: olean bytes are attacker-controlled regardless, and the defence is the sandbox plus re-judging. Exact name matching also does not stop a package that lacks LaxCore from registering the public name itself.
- **Recommendation:**
  - One `entriesOf data expected` helper.
  - Match public extensions exactly. Accept the private form only for core-private extensions whose `privateModule?` root is Lean/Init/Std.
  - Optionally skip the cast-reading readers when a submission module declares an initializer.
  - Add one comment stating the actual trust argument.
- **Revisits:** none.

### S6. A stored certificate is re-checked against today's settings, probes and generator
- **Severity:** medium (the merit verifier said low).
- **Where:** `artifact-schema.ts:373-381,409-455,466`, `metadata-resubmission.ts:174,331`, `shared/metadata-publisher.ts:131,145`, `environments.ts:15-17`, `spec_v2_draft.md:181-184`, `axiomfree-plan.md:662-664`.
- **Problem:**
  - `parseCertificate` also parses stored records (`published=true`), and it requires exact equality with the current `certificationKernels`, `SELF_TEST_PROBES`, `JUDGE_TOOLS` keys and `challengeText()` output.
  - The planned paranoid switch (decision 5), any new probe, or any generator change like ab394b0 therefore makes every earlier spec-2 record in that environment fail the published parse.
  - The metadata fast path then silently becomes a full revalidation, logging only "inconclusive", and the metadata publisher refuses outright.
  - This contradicts "the set may grow by a table edit".
  - The merit verifier argues the current-schema re-parse is deliberate and matches spec 1. True for the fast path, but the publisher refusal and the contradiction with the draft remain.
  - `configuredKernels` is a copy of `kernelsOf`.
- **Recommendation:**
  - Split by trust boundary: a new certificate is held to the current values; a stored one is checked against closed vocabularies (kernels a subset including `lean`, probes from the known history, tools from the known key set, challenge kept as recorded and bound by the digest). Alternatively, select the generator by `bundle.formatVersion`.
  - Import `kernelsOf`.
  - Reconcile decision 5's "new attestation beside the old one" with the plan's rewrite-on-revalidate. An append-only `attestations[]` list is the cleaner long-term shape but is optional.
- **Revisits:** decision 5, and stage-3 hardening "binds kernels to the row".

## 4. Inconsistencies

### I1. Proof-shaped theorems Lean generates (`_proof_n`) are refused as translation violations
- **Severity:** medium.
- **Where:** `inspect-spec2.ts:157-163,393-416`, `test/unit/submission-validation-inspect-spec2.test.ts:533-538`.
- **Problem:**
  - `abstractNestedProofs` makes `foo._proof_1 : A → C` from `def foo (hA : A) : {n // C} := ⟨0, …⟩`. That is a theorem with no range and origin `auxiliary`.
  - Its chain names only statements, so it reaches `checkEndpointName`, which raises a `proof`/`translation` violation. The doc comment's premise ("only through a forged or mistaken olean") is false.
  - The certificate can never name such a constant, so refusing it adds no soundness and refuses honest packages. The archive's own `variable`/`include` recipe produces exactly this shape.
  - The private half of the original finding is a recorded decision (`axiomfree-plan.md:659`) and is not reopened; see Rejected.
- **Recommendation:**
  - Treat `auxiliary` and `realized` theorems of proof shape as helpers; at most emit a note.
  - Keep `scoped` and unknown origins fail-closed.
  - Fix the doc comment and the unit test.
  - Add a real-Lean `_proof_1` fixture to the spec-2 e2e.
  - Reword `instructions.md:140` so that "a private helper is fine anywhere" does not read as contradicting the private-proof rule.
- **Revisits:** decision 10 / Codex-2 finding 1 (the endpoint gate should exclude, not refuse).

### I2. The bundle is assembled by several regenerators, and the CLI's copy sorts differently
- **Severity:** low (one verifier said medium).
- **Where:** `cli/certify.ts:320-430`, `certify/project.ts:131-151,192-264`, `certify/verify-bundle.ts:146-160`, `phases/provision.ts:153-169`, `artifact-schema.ts:373-381`.
- **Problem:**
  - `lax certify`'s `regenerateBundle` never calls `planCertificate`. It has its own `gitSource`, its own `packageClosure` (sorted with `localeCompare`, which `byName` explicitly forbids) and hand-built lakefile and manifest files.
  - `provision.ts:168` also sorts with `localeCompare`.
  - There are three closure walks.
  - With ASCII `Lax<n>` names the orders agree today, so the divergence is latent.
  - A future digest mismatch will be explained away as "another pin set". That note is a recorded stage-4 deviation pending the warm-manifest pin, and is not reopened here.
- **Recommendation:**
  - Build a `CertifyRecord` from the indexed records (`requiredByProofs` as the direct set) and call `planCertificate`.
  - Delete the CLI's assembly code.
  - Use one `dependencyClosure` sorted by `byName`.
  - Give the publisher the same real resolution (see S3).
  - Turn the mismatch note into an error once the warm manifest is pinned.
- **Revisits:** none.

### I3. Relative-certificate composition refuses edges the network and the website count as implied
- **Severity:** low.
- **Where:** `certify/compose.ts:96-146`, `inspect-spec2.ts:186-207`, `cli/prooftree.ts:118-166`, lax-website `sitegen/network.ts:19-42`, `spec_v2_draft.md:1967`, `axiomfree-plan.md:525-529`.
- **Problem:**
  - The universe rule admits `P.{u} : A.{u} → B`.
  - The network grounds by name, so B shows as proven given `Q.{v} : A.{v}`.
  - `composeRelativeCertificate` refuses it: an undetermined parameter, an undemanded polymorphic given, or a given demanded at two instances. This also applies to unconditional `lax certify B`.
  - The plan's "refused rather than guessed" is not a guess. Every edge is universally quantified, so any instantiation is sound.
- **Recommendation:** Either:
  - make composition total: instantiate at `0` on grounded paths, use fresh Cert level parameters where a parameter reaches a given, and emit one hypothesis per demanded instance; or
  - tighten the validator so a proof's level parameters are exactly its conclusion's instantiation.
  
  Add a property test that every statement `selectProofTree` marks implied composes.
- **Revisits:** the stage-4 deviation.

### I4. The draft's Inspection Internals and framing contradict decision 10 and the origin rule
- **Severity:** medium (one verifier said low).
- **Where:** `spec_v2_draft.md:33,763,1343-1357,1679-1686,1701,1713,1744-1750,1790,1957-1965,2143-2148`.
- **Problem:**
  - The Internals namespace check still gives the spec-1 `isInternalDetail`/un-mangle procedure, which Codex-2 showed is exploitable (`C.«A.B».proof_1`). The Namespaces section and the code use origin.
  - "Nothing is exempted" is wrong, and statement-hood and proof-hood still say "user-level".
  - Lines 763 and 1790 predate decision 10, under which the judge is the sole proof-validity check and the Challenge is the archive's reading.
  - The header lists Namespaces as verbatim.
  - The worked example has "container B runs the comparator" and a certificate that "lists the one edge".
  - The local-sandbox note "takes" bubblewrap, but `host.ts` always passes `--inadvisably-no-sandbox` (plan :647).
  - The Internals paragraph is the one most likely to be copied as the operational rule.
- **Recommendation:**
  - Fold this into the existing TODO stale-wording item.
  - Replace the Internals namespace, enumeration, statement-hood and proof-hood text, and the primer at 1343-1357, with references to the origin rule and the endpoint gate.
  - Reword 763/1790 to the three questions.
  - Fix the header, the worked example and the sandbox note.
  - Agents may edit the draft on this branch.
- **Revisits:** decision 10 (the text was not carried through).

### I5. The draft's Archive Database section still describes the spec-1 record shape
- **Severity:** low (one verifier said medium).
- **Where:** `spec_v2_draft.md:976-1007,1068-1079,1126,1135-1138`, `recorded-shape.ts:1-21`, `artifact-schema.ts:351,806`.
- **Problem:**
  - The example capture shows `leanToolchain`, `mathlibCommit` and `files`.
  - The proof entry stores `conclusion`/`assumptions` "so spec-1 readers read spec-2 records unchanged", which the trusted parser refuses and which is false.
  - Line 1007 ("certificate present in every spec-2 record") contradicts line 1126 and the code.
  - The determinism paragraph sorts certificate edges and capture files that do not exist.
- **Recommendation:**
  - Regenerate the section from `recorded-shape.ts`: the stored shape, a derivation table, and the statement that readers must use `expandRecordedBuildOutput`.
  - Change the certificate sentence to "present exactly when the record has proofs".
  - Add the section to the TODO staleness list.
- **Revisits:** none.

### I6. The website certifies any certificate without reading `selfTest.passed`, and the spec mapping is copied by heuristic
- **Severity:** low.
- **Where:** lax-website `database.ts:206-243` (`certificateEntry`), `sitegen/model.ts:39-41`, `pages/shared.ts:220,240-244`, `config.ts:53-71`; lax `certify/host.ts:247-251`, `cli/website.ts:539-542,1132-1148`, `TODO.md:82-83`.
- **Problem:**
  - A local host run records `selfTest: {passed: false}`.
  - `lax serve` renders it with the "certified" chip, the trust note ("a reader need not trust this archive's pipeline") and a rerun line.
  - The published site is protected by lax's parser, so this affects the local preview only.
  - lax never passes `environmentSpecVersions`, so the renderer falls back to its own table plus a "≥ 4.35.0" rule.
  - The `solutionExportSha256` tolerance is dead code, and the TODO line about new judge keys is stale.
- **Recommendation:**
  - Branch the rendering on `selfTest.passed`: show "local run — the archive certifies again on submit" with no trust note. This is rendering only; lax's parser stays the one gate.
  - Pass the spec versions from `environments.ts` and delete the heuristic.
  - Require `solutionExportSha256`.
  - Strike the TODO line.
- **Revisits:** none.

### I7. Intent headings, finding messages and the guide disagree about what a judge refusal means
- **Severity:** low.
- **Where:** `cli/findings.ts:11-15`, `certify/verdict.ts:42-44` (`REPORT`), `inspect-spec2.ts:81`, `pipeline.ts:296-306`, `assets/instructions.md:150-159`, `axiomfree-plan.md:209-213`.
- **Problem:**
  - The heading says "the proof does not establish the edge". Every judge body ends in `REPORT` ("the archive's validator accepted this record … report it as a lax bug"), and that wording also appears on purely local builds. The guide says any refusal is a lax/Lean disagreement.
  - With proof Replay gone, `kernel-rejected` for a kernel-unchecked proof (e.g. `debug.skipKernelTC`, which nothing forbids) is a correct verdict on the author. The author is still told to file a bug.
  - "Beside Replay" is stale for proofs.
  - Concept-side statement rules sit under the heading "the theorem is not the edge".
  - F-1.6a's keep-the-label decision for `solution-build` is respected here.
- **Recommendation:**
  - Make `REPORT` rule-specific: bug wording for `solution-build`, `statement-mismatch` and `missing-constant`; "your proof did not pass the kernel / used a forbidden axiom" for `kernel-rejected` and `illegal-axiom`.
  - Drop "accepted this record" on local runs.
  - Give concept statement rules a heading of their own.
  - Change the guide to "concepts are replayed; proofs are judged by the comparator".
  - Optionally forbid `debug.skipKernelTC` as a standards rule.
- **Revisits:** none.

### I8. "Rerun the certificate" means different things in the draft, the website and the CLI
- **Severity:** low.
- **Where:** `spec_v2_draft.md:1904-1907,2421-2443`, lax-website `pages/shared.ts:229-232`, `cli/main.ts:240,252-258`, `axiomfree-plan.md:519-534`.
- **Problem:**
  - The draft says: fetch by default, `--output`, `~/.lax/certificates/`.
  - The CLI regenerates by default (and requires the regenerated Challenge to equal the stored one byte for byte), fetches with `--fetch`, uses `--out` and writes to `./certificate-<target>`.
  - `generate-prooftree` uses `--output`.
- **Recommendation:**
  - Update the draft to the shipped behaviour and retire its note.
  - Rename `--out` to `--output`.
  - Keep the website line. Regeneration is the more independent check; only fix its "in the fetched bundle" clause.
- **Revisits:** none.

### I9. Spec-2 call sites read the epoch's Lean facts
- **Severity:** low.
- **Where:** `generate.ts:290-302`, `project.ts:226 vs 382,432,443`, `inspect-common.ts:21`, `inspect-runner.ts:121`, `lean-facts.ts:107-116`.
- **Problem:**
  - `comparatorConfigFor` takes `permitted_axioms` from `leanFacts()`, which is the epoch row (`v4.33.0`, spec 1). `comparatorExportTargets` uses `leanFacts(record.environment)`. So one `comparator.json` comes from two different lookups, and it feeds the bundle digest.
  - `BY_VERSION` is empty and main has about 15 identical no-argument calls, so this is the module's documented convention, not a branch regression.
- **Recommendation:** Before the first spec-2 record, pass the environment into `comparatorConfigFor`/`comparatorConfigText` so the digest depends only on the record's row. Settle the remaining no-argument calls in one decision across the tree.
- **Revisits:** none.

## 5. Missed opportunities (ranked by value against cost)

### M1. A self-describing, archive-backed reader rerun (merges the "author repos" and "no `lean-toolchain`" findings)
- **Severity:** medium.
- **Where:** `generate.ts:59-65`, `cli/certify.ts:104,153-158`, `certify/project.ts:153-175`, `generate.ts:337-344`, `captures/seal.ts:35`, `spec_v2_draft.md:1793-1810,1904-1906`, lax-website `shared.ts:231-244`, `TODO.md:932`.
- **Problem:**
  - The sealed bundle has no `lean-toolchain`. The by-hand recipe and the website line ("in the fetched bundle, `lake comparator`") run under elan's default toolchain, which may lack `lake comparator` or carry different kernels.
  - Every record package is a git require on the **author's** repository. A deleted, private or GC'd repo makes the certificate, and every relative certificate through it, unrerunnable. The archive meanwhile holds digest-addressed captures containing those very sources.
  - Spec 1 never depended on author repos after registration; spec 2's headline artifact reintroduces that dependency.
  - Both the toolchain and the source URLs are inside the bundle digest, so this is cheap now and a format migration later.
  - "Historical replay of the judged exports" is the already-tracked `--historical` TODO and is not counted here.
- **Recommendation:**
  1. Make `lean-toolchain` a sixth sealed file, and drop the separate write in `certify.ts`.
  2. Before the first record, decide where sources come from: an archive-owned preservation remote pushed by the publish job (only git objects, never executed; integrity stays on the SHA), or explicitly accepted author-repo dependence. Record the choice in the plan.
  3. Let `lax certify --run` satisfy record packages from the verified captures' **source** trees through Lake package overrides, as the runner does. Never use captured build products as the default.
  4. Narrow "every certificate can be rerun from its bundle" to what is guaranteed.
- **Revisits:** stage-4 deviations.

### M2. Add an illegal-axiom probe to the judge self-test
- **Severity:** medium (one verifier said low).
- **Where:** `certify/self-test.ts:8-24,61-71,~338-349`, `contracts.ts:628-637`, `generate.ts:297`, `verdict.ts:117-123`.
- **Problem:**
  - S3–S5 cover accept, statement mismatch and kernel forgery. None of their Solutions uses an axiom.
  - Under decision 10 the comparator's `checkUsedAxioms`, driven by `permitted_axioms`, is the only authenticated "no sorry, no declared axiom" check of an edge.
  - A wrong-but-valid `permitted_axioms`, or a comparator regression, would still pass the self-test. CI e2e covers the parser, not the runner on each run.
- **Recommendation:**
  - One extra run, `judge("comparator-rejects-axiom", challengeExport, "violation illegal-axiom")`. The Challenge's `sorry` already supplies `sorryAx`, so no new build is needed.
  - Assert that `sorryAx` is named.
  - Add the probe to `SELF_TEST_PROBES` and to the parser's list.
  - Optionally make the self-test theorem depend on a `def P : Prop` so the definition comparison is exercised.
- **Revisits:** none.

### M3. No CI job runs the real-container Certify
- **Severity:** medium (one verifier said low).
- **Where:** `test/smoke/submission-validation.ts:112-123,450-470`, `.github/workflows/ci.yml:77-100,228-232`, `environments.ts:122`, `.github/workflows/environments.yml:102`, `TODO.md:53-70`.
- **Problem:**
  - CI's smoke runs at `epoch()`, and `spec2-certify` exists only for spec-2 rows.
  - The mount *plan* is unit-tested with a fake runner (`certify-phase.test.ts`). `run-certify.mjs` in the real image, docker's readonly and tmpfs enforcement, and the self-test probes are not.
  - The stage-6 plan makes `v4.35.0` the epoch, after which CI covers this on every push. Until then, every change ships untested, which is the repo's own smoke-gating lesson.
  - `environments.yml` injects candidates without `specVersion`/`libraries`, so an admission run would exercise a spec-2 row as spec 1.
- **Recommendation:**
  - Run the smoke's spec-2 cases for every admitted spec-2 row.
  - Add a mathlib-free docker CI step now that runs the core-only judge self-test on the cached rc3 toolchain.
  - Turn the owed `docker inspect` checks into assertions: A2/B2 `.lake` read-only, no warm store or capture mount in C, the `/tmp` options.
  - Fix the admission injection.
- **Revisits:** none.

### M4. The composed Solution grows exponentially on shared sub-proofs
- **Severity:** medium.
- **Where:** `certify/compose.ts:79-127`.
- **Problem:**
  - `term()` re-expands every witness subtree inline with no memo.
  - Measured on a chain of diamonds: n=8 gives 22 KB, n=12 gives 481 KB, n=16 gives 9.7 MB.
  - This is liveness and readability only, since the comparator still checks whatever is emitted.
- **Recommendation:**
  - Emit one `have` per (statement, level-instance) in topological order, ending with the target's term, memoised on that key. The key must include levels, because one statement can be demanded at two instances.
  - The body becomes linear, and each line reads as one edge.
  - Add diamond and size-bound tests.
- **Revisits:** none.

### M5. Near-miss proofs silently become helpers, and the build never lists its edges
- **Severity:** medium.
- **Where:** `inspect-spec2.ts:140,143,159-161`, `inspect.ts:162,290-326`, `host/pipeline.ts:637-639`, `cli/build.ts:273-280`, `spec_v2_draft.md:730-734`.
- **Problem:**
  - A null telescope, or a chain over an untagged `Prop` def (a forgotten `@[lax_statement]`), hits a silent `continue`.
  - If another proof uses the theorem, nothing is reported. Otherwise the author gets the shape-blind `unused-lemma` warning.
  - The success line says only "N edges".
  - The draft's "fails loudly instead of silently becoming a helper" covers only ported spec-1 frontmatter, so a fresh spec-2 author loses edges unnoticed.
- **Recommendation:**
  - List the edges read (`euclid: {ExistsPrimeDivisor} → InfinitelyManyPrimes`) in the build detail and the report.
  - Add a narrow `near-miss-proof` warning: (a) the conclusion head is a statement but the telescope is null or has a non-statement link, naming the link; (b) a chain link is an untagged `Prop` def of an own or direct concept package.
  - No unfolding; that stays deferred per `axiomfree-plan.md:638`.
- **Revisits:** decision 3 (kept; adds its diagnostic).

### M6. The author cannot read their own Challenge.lean before submitting
- **Severity:** low.
- **Where:** `host/pipeline.ts:644`, `cli/build.ts:340-380`, `cli/certify.ts:106-118,280-298`, `certify/host.ts:11-13`.
- **Problem:**
  - `lax build` deletes the bundle along with its temporary workspace. The PDF is copied out; the bundle is not.
  - The Challenge text is in `build-output.json` under `certificate.challenge`, and `lax serve` will render it once the renderer is re-pinned.
  - After `lax submit` the draft can be certified with `lax certify lax-N` before `lax register`.
  - The `host.ts` header promises a local `lax certify` target that does not exist.
- **Recommendation:**
  - Copy `Challenge.lean` next to `build-output.json` (git-ignored) and print its path in the certify row.
  - Fix the `host.ts` header.
  - Say in the guide where to read the Challenge.
  - A folder target for `lax certify` is optional.
- **Revisits:** none.

### M7. Ask upstream Lake for a structured verdict before v4.35.0 final
- **Severity:** low.
- **Where:** `certify/verdict.ts:57-221`, `sandbox/tools/run-certify.mjs:56-65,235`, `certify/lean-name.ts`, Lake `CLI/Check.lean:226-261,444-452,619`.
- **Problem:**
  - Lax works around three upstream behaviours:
    - about 9 regexes over English `error:` lines, needed because "<kernel> kernel rejected the solution" is printed for every nonzero exit, crashes included;
    - an unconditional `whichExe "git"` even when unsandboxed, hence the git shim;
    - `decodeNameLit` panics on non-ASCII bare names.
  - Every epoch bump has to re-verify the strings.
- **Recommendation:**
  - File Lake issues or PRs for a JSON verdict line with a separate crashed status, no git probe when both exports are given, and the name-literal panic.
  - Record the links in the plan.
  - Keep `verdict.ts` for frozen v4.35-era rows, add a golden transcript test per admitted environment, and switch parsers per environment once a toolchain ships the flag.
- **Revisits:** none.

### M8. Point from the website's proven statements to their certificate command
- **Severity:** low.
- **Where:** lax-website `pages/concept.ts:71`, `pages/shared.ts:232`.
- **Problem:** axiomfree.md asks for an export in "the CLI *or* website", and the CLI already composes certificates. The site gives no pointer from a proven statement to `lax certify <statement-id>`.
- **Recommendation:**
  - Print the statement-level command beside `countsPill`.
  - Do not compose Challenges site-side; that would show text the comparator never ran, and decision 8 stands.
  - Add one sentence to the warm-manifest-pin TODO noting that a pinned manifest makes every bundle a pure function of database plus row.
- **Revisits:** none (decision 8 kept).

## 6. Lean idiom and author experience

**Lean idiom.** The items above that a Lean reviewer would flag first:
- C2: `checkBinderAnnotations false` in a published Challenge, and the false instance-binder advice.
- C3: a private name encoding instead of `Name.toString`/`String.toName`.
- C1: a wrapper theorem judged instead of the author's constant.
- M4: an exponential proof term instead of a `have` chain.
- S5: un-mangled extension matching.

**Author experience.**

- **A1. `lax port` prints pre-rekey names.** Low. `cli/port.ts:174-187,198-221`, `cli/rekey.ts`, `test/unit/cli-port.test.ts:258`.
  - `rekeyed` rewrites only paths. The printed statement and proof ids, the proof chain and own constants inside signatures keep `Lax<old>`. The test asserts the stale `Lax100009.Primes.Bounded` while reading the module from the new id.
  - Fix: export `rekeyText(text, old, new)` from `rekey.ts` (the Proofs package first, then the `(?![0-9])` guard), use it in both places, and fix the test.

- **A2. macOS gets an unfixable "install bubblewrap".** Low. `cli/certify.ts:666-672`, `cli/doctor.ts:555,1006-1018`, `assets/instructions.md`.
  - doctor supports darwin. The spec-2 Sandbox row warns and `--run` refuses with advice that cannot be followed on macOS. Nothing says the rerun is Linux-only.
  - Fix: branch on platform. On non-Linux, report the row as informational and point to a Linux VM or container. Add one sentence to the guide. The per-kernel doctor rows are a deliberate plan choice; leave them.

- **A3. Nine positional parameters with structurally identical neighbours.** Low. `phases/inspect.ts:48-72`, `phases/inspect-common.ts:26-29`, `phases/inspect-runner.ts:33-43`, `pipeline.ts:330-366`, `host/pipeline.ts:558`.
  - `siblings` and `libraryRoots` are both `{concepts, proofs}` and adjacent, so swapping them compiles. Doing so would make `LaxCore.*` "direct" statements.
  - Fix: take named options objects for `judgeInspection` and `runInspector`. Make `specVersion` required, since a silently defaulted content spec is the worse mis-wiring.

- The author-facing parts of C6, I7, I8, M1, M5 and M6 also belong here.

## 7. Rejected on verification

- **Keep concept-package Replay only on the argument that dropped proof Replay.** Concept declarations no edge reaches yet are not dead content; they are the statement surface later records import. Two of three verifiers rejected.
- **A1/A2 split does not make the Challenge export verifier-owned.** A2's LEAN_PATH does lead with A1's tree, but code running in A1 is part of the design (the draft names A1 as the place concept code runs). The defence is the structural telescope check plus the kernel, not A1's tree being clean. No exploit was built. Two of three rejected.
- **Build the Challenge from the telescope without elaborating text, and delete A1.** The judge would no longer read the bundle's own export, which breaks the reader-rerun property. The macro_rules attack is already closed by the challenge check.
- **Spec 2 lost the binding between the references layer and the judged capture.** The same trusted host code builds both from the same read-only directory in one call; there is nothing independent to re-bind.
- **Global delaborators and unexpanders missing from the global-syntax rule.** They affect display only. A1 runs concept code by design, and the Challenge's meaning is checked structurally.
- **Manifest `specVersion` is redundant with `leanVersion`.** In spec 1 it already meant the content spec (spec.md:169); the two-version distinction is deliberate and stated in the draft.
- **Metadata-only resubmission keeps the bundle pinned to the old commit.** Already reported as Codex-intents-2 finding 5 and still an open decision; a re-report.
- **Private proof-shaped theorems should be helpers (the second half of I1).** A recorded decision (`axiomfree-plan.md:659`, draft 722-728): loud failure with a hint, never a silent helper.
- **Append-only `attestations[]` as a required fix (the high variant of S6).** Optional redesign; the plan deliberately chose rewrite-on-revalidate with git history. Only the parse split is required.
- **Collapse the host Certify path into a single `lake comparator` run (the first variant of C4).** It loses the `translation`/`judge` attribution of build failures and the telescope check that runs before the Solution.
- **Make the website require `selfTest.passed` as a second gate (part of I6).** That copies a rule to another call site; render the field instead.
- **Make a capture/olean-based `--archived` mode the reader's default (part of M1).** It would consume products of untrusted builds; use source trees only.
- **Site-side composed certificates (the main recommendation of M8).** Composition depends on the selection and would show Challenges the comparator never ran; decision 8 stands.
- **Move comparator-only facts to a keyed v4.35 row (part of I9).** Only spec-2 paths read them; it would duplicate `SHARED` for no gain.
- **Collapse the doctor certification rows (part of A2).** The plan deliberately shows them only for spec-2 environments.
- **"Container B" in `lean-facts.ts` is a stale comment.** Containers A and B still exist; only "the comparison in container B" is wrong, and that is folded into I9.
