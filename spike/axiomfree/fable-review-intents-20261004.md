# Review: division of intents (decision 10) — a third pass

**Verdict: the division is right and the code mostly follows it, but the judge's answer still rests on one standards rule, because container A produces the Challenge export, the Challenge olean, and the new telescope report in the same container, the same writable tree, and the same process lineage as the step that executes closure concept code. Move the export (and the telescope inspection) out of the build container before calling the judge independent.**

Static review of `axiomfree` at `0da3139` plus the working tree, 2026-10-04 afternoon. Files changed under me while I read: `phases/inspect-spec2.ts` (the canonical-name, private-exemption, intent, and `checkInitializer` rules landed), `certify/phase.ts` (the E1 telescope check landed, `readChallengeReport`/`checkChallengeReport`). Line numbers below are from the last state I read; `phase.ts` is cited at its post-change lines. Nothing in the repository was modified except this file. No tests, no docker; one `node` one-liner against `LEAN_NAME_PATTERN`. Lean source consulted from the rc3 toolchain (`Lean/Environment.lean`, `LeanExport.lean`). The Palomar policy was fetched.

Known findings from `codex-review-intents-20261004.md` (1–7), `namespace-review-20261004.md` (B2, F1, E1, D2), and `codex-review-stages1-3-20261003.md` are not re-reported except where the fix in the tree is incomplete (section 3).

## 1. New findings, by severity

### 1.1 High (Medium once `checkInitializer` is the only code path into A) — Container A's three outputs are not isolated from the step that runs concept code

**Where.** `src/submission-validation/sandbox/tools/run-certify.mjs:86-100` (one container runs `lake build <module>`, then opens `plan.output` *by path* and streams `leanexport` into it), `:103-112` (the same container then runs the inspector and writes `plan.inspect.report` to the same `/out`); `src/submission-validation/certify/phase.ts:230-233` (`output` and `inspect.report` both under `CERTIFY_PATHS.out`), `:261-267` (the host digests the export and reads the telescope report from that directory); `src/submission-validation/sandbox/container.ts:197-215` (no `--init`, nothing kills the process group between steps; `/tmp` is `rw,nosuid,nodev` with no `noexec`, contrary to the comment at `phase.ts:18`); `src/submission-validation/certify/phase.ts:139-150` (`exportedFile` checks "regular, non-empty", which is a symlink guard, not provenance).

**What runs in A.** `lake build Challenge` elaborates `Challenge.lean`, whose imports load every concept module of the closure with `loadExts := true` (that is what `lean` does): every module initializer of the submission's own concept package *and of every dependency concept package* runs inside A, with the same uid, the same writable `/cert/project/.lake` and `/out`, and nothing that ends them when `lake` returns. `leanexport` itself runs no initializers (`LeanExport.lean:16`, `importModules imports {}` — `loadExts` defaults to false, `Environment.lean:2404` only finalizes extensions under that flag), and neither does the inspector; so the *tools* are clean, but they read from, and write into, trees the untrusted step owned a moment earlier.

**Failure scenario (design level).** A concept package in the Challenge closure — the record's own, or any dependency's — carries module-initialization code that leaves work running after `lake build` has returned. From then on `/out/challenge.export`, `/out/challenge-report.json`, and `.lake/build/lib/Challenge.olean` are all reachable by that code for the rest of the container's life, which extends through the `leanexport` and inspector steps. Whatever is at those two `/out` paths when `node` exits is what the host digests (`challengeExportSha256`) and checks (`checkChallengeReport`). An export is a flat file with no duplicate-constant check, so it can carry a statement constant with a body the capture does not have; container B is run for the same author, so its export agrees; C accepts; the record stores a Challenge text that *reads* correctly, a telescope check that *passes* (the `Cert.*` types are the recorded ones), and an export digest of bytes nobody but that code wrote. The E1 telescope check does not close this: it compares the certificate theorems' types, read from a report produced in the same container, and says nothing about the statement constants' bodies in the export.

**Why it matters for decision 10.** As of this afternoon `checkInitializer` (`inspect-spec2.ts`, F1) refuses `@[init]` entries, and that detection is sound for this vector (the attribute entries are what drive `runModInit`, so an olean without them runs nothing). But it is a *standards* rule in the inspector, and the whole point of decision 10 is that "nothing else in the pipeline contributes to [the judge's] answer." Today the soundness of a certified edge against a hostile concept author is exactly: "the inspector's `initialize` rule caught every initializer in every concept package of the closure." Any future way for code to run during `lake build Challenge` (a Lake feature admitted to the toml whitelist, precompiled modules, a plugin, a build hook) reopens the hole silently, and nothing in the judge path would notice.

Note also the asymmetry with "concept authors are trusted for their meaning": a *dependency* concept author gets to forge the Challenge export of every downstream record that imports them — more than meaning.

**Fix.** Palomar's rule: the exports are written "to a verifier-owned file that no candidate phase can write to, then snapshotted." Concretely:

- Split A into A1 (`lake build Challenge`, writable `.lake`, no `/out`) and A2 (`leanexport` + inspector over A1's `.lake` mounted **read-only**, with `/out` as the only writable mount; A2 runs no candidate code — `leanexport` and the inspector both import with `loadExts := false`). Same for B (B1 build, B2 export). The container boundary then does what the comment at `phase.ts:25-29` already claims for C.
- Alternatively capture `leanexport`'s stdout through docker's stdout rather than a mounted file, but a lingering process shares that stdout, so the split is cleaner.
- Add `noexec` to the `/tmp` tmpfs (the comment says it is there; the flag is not).
- Keep `checkInitializer` as the standards rule it is, and stop describing it as what protects the judge.

### 1.2 Medium — The reader's audit surface shows the judged bytes for tagged definitions only; everything a statement's body refers to is shown from source, which is not what was judged

**Where.** `src/submission-validation/lean/inspector/Main.lean:764-767` (`body` is pretty-printed only for tagged definitions), `:706-710` (`usedConstants` is already computed, package-local); lax-website `src/sitegen/pages/shared.ts:244` (trust note: "a reader need not trust this archive's pipeline") and `:265-270` (the Challenge panel); `src/submission-validation/captures/seal.ts:118-125` (the references layer ships concept *sources*, not bodies).

**What is actually judged.** The Challenge export is built from the concept *oleans* in the capture. The oleans are written in the compile container's shared writable `.lake` by a sequence of `lean` processes, each of which can run arbitrary compile-time IO from the source it elaborates (`#eval`, `run_cmd`, `run_meta` leave no trace in any olean and are banned by no rule). Concept Replay checks that each olean is kernel-consistent, not that it matches its source. So "the statement means what its source says" is a stronger assumption than "concept authors are trusted for their meaning" sounds: it assumes olean = source.

**Failure scenario.** A statement `Lax7.M.S := ∀ n, Lax7.M.Aux n` where `Aux` is an untagged definition. The website shows `S`'s body (from the olean) and links the source; `Aux`'s olean body is shown nowhere. If the compiled `Aux` differs from the committed `Aux` (a later module of the same package rewrites an earlier module's output before capture), the reader checks Challenge.lean, reads `S`'s displayed body, follows the link to `Aux`'s source, and is satisfied — and the certified edge is about a different `Aux`. Known in outline (codex finding 2's "source-to-olean correspondence"); what is new is that the *display* is where the gap becomes reader-visible and where it can be closed cheaply.

**Fix.** The reader's audit surface must be derived from the olean, for the whole package-local cone of each statement: have the inspector emit the pretty-printed body of every package-local constant reachable from a tagged definition's body (it has `usedConstants` already; follow it transitively within the package), store them beside `statements[].body`, and show them under the statement card. Say on the trust note that what is shown and judged is the *compiled* definition, and that the source link is a convenience. A stronger but costlier option is per-module compile isolation; not needed if the display tells the truth.

### 1.3 Medium — The archive admits names a reader cannot tell apart, and the Challenge text is the reader's audit surface

**Where.** `src/submission-validation/contracts.ts:366-367` (`LEAN_NAME_PATTERN` admits `\p{L}`, `\p{N}`, `\p{M}`); `src/submission-validation/certify/lean-name.ts:32-41` (Greek capitals `Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ` are letter-like, so they are emitted *bare*); `Main.lean:343-354` (`isCanonicalName` checks only for `.` and numeric components). Verified with node: `Lax1.M.Fermat` + U+034F (COMBINING GRAPHEME JOINER, invisible) passes the pattern; `Lax1.M.Fermаt` (Cyrillic а) passes; `Lax1.M.PrimeΟrder` (Greek Ο) passes and would be written bare in Challenge.lean; precomposed `é` and `e`+U+0301 are two different canonical names.

**Failure scenario.** A concept package declares `Lax7.M.Fermat` (the real statement) and `Lax7.M.FermΑt` (Greek Alpha, body `True`); the proof package proves the second; the record page shows a certified edge whose Challenge reads `_root_.Lax7.M.FermΑt`. A reader reading the Challenge "with their own eyes" (plan, decision 10) reads it as the first. Non-letter-like homoglyphs get `«»` in the Challenge (a hint, but the reader is not told what it means); Greek capitals get nothing.

**Fix.** Standards (translation-adjacent, since the Challenge text is the audit surface): require NFC, refuse `\p{M}` and `\p{Cf}`, require a single script per component (or ASCII plus lower-case Greek, which is what Lean authors actually use), and refuse a name that is confusable (UTS #39 skeleton) with another name in the same closure. On the website, link every constant in the rendered Challenge to its statement/proof card by exact id, so a reader's click resolves the name, not their eyes.

### 1.4 Medium — The publisher's regeneration cannot repeat the direct-require rule and accepts a warm closure that can make a reader's rerun lie

**Where.** `src/submission-validation/certify/verify-bundle.ts:123-126` (`resolution: { concepts: [], proofs: dependencies, all: dependencies }` — every closure dependency counts as a direct require, so `planCertificate`'s "does not require directly" branch can never fire in the publisher); `:77-78` (warm entries may be `file://`, and any `https://` URL and any 40-hex rev for the non-library packages); `:86-90` (only the environment's libraries are pinned).

**Failure scenario (post-sandbox-escape only; the validate job holds no token).** A crafted artifact keeps the five files coherent — the publisher regenerates them from the artifact's own telescopes and tail-of-manifest — and points a warm entry (`batteries`, `aesop`, …) at a repository of the attacker's. The root manifest is authoritative for lake, so `lax certify --run` on a reader's machine fetches that package; a global `macro_rules` in it (namespace review E1) rewrites `theorem` in the reader's build, and the reader's rerun passes vacuously. The archive's own C judged the real thing; the *reader's* evidence is the thing corrupted. The TODO item "pin the warm manifest per environment" closes it; `file://` should be refused outside tests regardless; and the validation report should carry the direct-require set so the publisher can repeat the rule as trust rule 2 asks.

### 1.5 Medium — Signal-terminated tools are read as verdicts against the author

**Where.** `run-certify.mjs:71-74` (a child killed by a signal returns 1); `certify/verdict.ts:209-216` (only codes ≠ 0,1,2 are failures; 1 falls through to the generic `comparator` violation, intent `judge`); `phase.ts:245-260` and `:319-334` (A/B: `boundary` recognizes only `timedOut`, 137 and 125; anything else is `challenge-build` (translation) or `solution-build` (judge), both saying "report it as a lax bug"); `src/submission-validation/host/proc.ts` (same in the host path).

**Failure scenario.** `lean` dies of SIGSEGV or `LEAN_ABORT_ON_PANIC` fires in `leanexport` on a target it cannot decode (`Syntax.decodeNameLit` panics — `generate.ts:304-309` says so); the author is told their theorem is not the edge, or their proof is wrong. A comparator kernel subprocess killed by the container's `pids-limit` is reported by the comparator as `<kernel> exited with N` without the rejection notice and is correctly a failure — but the comparator *itself* dying by signal is a `judge` violation with the transcript as message.

**Fix.** Return a distinct code (3) on `result.signal` in `run-certify.mjs` and in the host runner; `interpretComparatorRun` already maps ≠0,1,2 to infrastructure; make A/B's `boundary` treat it the same.

### 1.6 Low — Two intent labels that would misdirect an author, and one Replay-drop consequence in failure classification

- `phase.ts:326-334` and `verdict.ts:270-281`: `solution-build` is labelled `judge` ("the proof does not establish the edge", `cli/findings.ts:12`) while its message says "report it as a lax bug". Pick one. With proof Replay dropped, the honest reading is: a Solution that does not elaborate against a package `lax build` compiles cleanly is a lax bug; against a package that does not, it is the judge's "no". The message's conditional ("if your package builds cleanly with `lax build`") carries that; the label does not.
- `inspect-spec2.ts:114-120`: `@[lax_statement]` in the proof package is labelled `translation`. The classifier never reads proof-package tags for edges (`ownStatements` is built from concept declarations only), so nothing about "which edge" depends on it; it is a house rule — `standards`.
- `src/submission-validation/phases/inspect-runner.ts:71-78`: a non-zero inspector exit is `infrastructureFailure` ("the archive's failure, retry"). Under spec 1 the proof oleans met `leanchecker` first, whose refusal was `replayFailure` → `submissionFailure` (`failures.ts:127-136`). With proof Replay dropped, the inspector is the first process that loads the proof oleans, and an olean `importModules` refuses (a within-package duplicate constant, a malformed object, "environment already contains") now becomes an infrastructure failure with no finding and, if retried, the same failure again. Classify the inspector's import-time refusals as submission failures (the message shapes are Lean's and belong in `lean-facts.ts` like `missingModulePattern`).

### 1.7 Low — `lax certify` as a reader's tool: two small truths it does not tell

`src/cli/certify.ts:161-165` reports "kernels: lean, …" from the flag the user passed, not from the transcript; `:400-409` lets `--run` proceed on a regenerated bundle whose digest is not the archive's with only a note. Both fine as behaviour; the first should read the kernel list from the comparator's own notices (`verdict.ts` already parses them) so "Certified · kernels: …" is evidence rather than an echo. The known gap (fresh exports never compared to the recorded digests) is in TODO.

## 2. The data flow, traced end to end (what each hop trusts)

| Hop | Produces | Trusts | Verified in this review |
|---|---|---|---|
| Fetch → Static → Compile (concepts) | concept oleans in a shared writable `.lake` | the container; compile-time IO is unbounded (1.2) | concepts are compiled **and captured before** the proof package compiles (`pipeline.ts:224-273`), so proof code never reaches the concept capture — no finding |
| Capture (seal.ts) | `concepts/{package,lib,ir}` with `.trace`/`.hash`/`.c` companions, references layer | the compile container's output; symlink-free, inside the build root (`seal.ts:97-108`) | ok |
| Replay (concepts only) | nothing (a gate) | leanchecker over the capture; kernel consistency, not source correspondence | ok as stated in the draft (`spec_v2_draft.md:1374-1396`) |
| Inspect | report: names (canonical or escaped+flagged), telescope, levelParams, axioms, bodies of tagged defs, `initializer` | `loadExts := false`: no imported code, builtin delaborators only (`Environment.lean:2404`, so no unexpander/delab from a package can alter a displayed body — checked, no finding) | ok |
| Classifier (inspect-spec2) | proof entries with telescopes; findings with intents | the report; the database's `statements` of direct requires | ok; labels in 1.6 |
| Generator (generate.ts) | five files, names through `leanName` | the telescopes | ok; names in 1.3 |
| A | `challenge.export`, `challenge-report.json` | **the build step's process lineage and writable tree** | **1.1** |
| B | `solution.export` | nothing — a forged Solution export must still contain a kernel-valid proof of the Challenge's statement, so forging it gains nothing (Palomar relies on the same) | ok |
| C | exit code + transcript | the toolchain; both exports mounted alone, read-only; PATH has no writable entry | ok |
| phase.ts → build-output | digests, kernels, Challenge verbatim | A's and B's `/out` | 1.1 |
| artifact-schema | `judge.toolchain` = runtime, `kernels` = configured set exactly, `challenge` = regeneration | the artifact | ok (stages-review finding 2's kernel item is fixed) |
| verify-bundle (publisher) | the five files regenerated and re-sealed, digest held | the artifact's proofs and the tar's warm tail | 1.4 |
| capture-store → database | `registryBlob` digest = bundle digest | ghcr, CAS commit | ok |
| website | Challenge escaped (`shared.ts:270`), digests, trust note | the database | 1.2, 1.3 |
| `lax certify` | regenerated or fetched bundle; comparator over a **rebuild from source** | the pinned source commits; the reader's lake/bwrap | 1.4, 1.7, TODO's export-publication item |

## 3. Earlier findings whose fix in the tree I judge incomplete

- **Codex intents 1 (name round-trip).** Fixed: `Main.lean:343-354` escapes and flags non-canonical names, `inspect-spec2.ts checkCanonicalName` refuses them, `inspect.ts uniqueDeclarations` refuses repeated non-theorem names (translation). One loose end: two theorem-kind entries of one name are still merged first-wins without comparing types; Lean's own import would already have refused differing types — at the inspector's `importModules`, which under 1.6 becomes an *infrastructure* failure rather than a finding. The queued D2 fix (dedupe by `(name, module)`) should land together with 1.6's reclassification.
- **Codex intents 5 (private exemption).** Fixed properly: `inspect-common.ts privateOwner` requires one of the package's own modules; anything else private-looking takes the prefix test un-mangled.
- **Codex intents 6.** Kernel crash, launch failure, and unexplained stop are failures now (`verdict.ts:282-326`); `REPORT`'s "lax bug" wording survives but conditioned on "if your package builds cleanly with `lax build`", which is defensible. The `solution-build` label is 1.6.
- **Codex intents 7 (plan/draft contradictions).** Still present at my read: `axiomfree-plan.md:226` ("run over Replay-authenticated oleans as today" — false for proof packages now), `spec_v2_draft.md:1749-1765` ("Two containers", B runs the comparator, C "belt-and-braces"), `:1736` ("every binder explicit" vs `generate.ts:194-206` copying binder kinds). The draft's Replay paragraph (`:1374-1402`) *is* reconciled.
- **Namespace review E1 (Challenge held to the telescope).** Landed in `phase.ts:262-267` via an inspector run *inside container A* writing to A's `/out` — i.e. inside the trust boundary 1.1 describes. It is the right check in the wrong place: run it in the A2 container of the split, over A1's read-only build tree. It also checks the certificate theorems' types only; the statement constants' bodies in the export are checked by nothing but C's comparison with B's export, which the same author produced. The independent structural check the Codex review asked for ("the exported Challenge's theorems reference exactly the registered statement constants") is therefore still only half there: names and levels yes, bodies no — and bodies are what 1.2 is about.
- **Namespace review F1 (`initialize`).** Landed as `checkInitializer` (standards) reading the `init`/`builtin_init` attribute entries (`Main.lean:621-640`). Sound for the vector; see 1.1 for why the judge must not lean on it.
- **Stages review 7 (A mounts proof subtrees).** Fixed: `dependencyMounts` mounts the dependency's kind subtree only (`project.ts:402-415`).

## 4. Dropping proof-package Replay: every reader of proof oleans after Compile

| Reader | Reads | What it now trusts without Replay | Verdict |
|---|---|---|---|
| Inspector (`run-check.mjs` → `laxinspector`) | constants, types (telescope), values (axiom walk, `usedConstants`), docstrings, ranges, init entries | the olean as the author's *claim*; the axiom set and `initialize` facts are standards facts over unverified values | acceptable per decision 10, **but** an olean the inspector cannot load is now an infrastructure failure (1.6) |
| Container B's `lean` (Solution build) | the proof olean's declared types for `@p h₁ …`; runs its initializers (until F1 refuses them) | nothing — C re-checks | ok |
| `leanexport Solution` | the proof term, exported | nothing | ok |
| Container C | the export | the kernels | ok — the only reader whose answer counts |
| Downstream Compile (another proof package requiring this one) | imports the capture: runs its initializers in the downstream author's container; elaborates against unverified helper types | the downstream edge's own A/B/C; helpers used outside any edge cone carry no guarantee | known (codex 4), stated in the draft |
| Downstream Replay (concept package) | `/deps/<id>/proofs/lib` on the search path (`replay.ts:27-29`) but concept packages cannot require proof packages | n/a | ok |
| `lax build` host mode on a downstream author's machine | the capture, outside any container | arbitrary initializer IO on the author's host — true before the Replay drop too; F1 narrows it for validated records | unchanged, mention in docs |
| `lax certify --run` on a reader's machine | **source**, not the olean | the pinned commit; `lake comparator`'s bwrap | ok; the olean/source divergence of 1.2 shows up here as a *failing* rerun, which is the right direction |
| Website | nothing from oleans | — | ok |

So the drop is safe for certified edges, with the single operational regression in 1.6 and the documentation duty the draft already discharges.

## 5. Intent labels as assigned (grep `intent`)

Correct: every `verdict.ts` refusal → `judge`; `phase.ts challenge-build`, `nameViolation` → `translation`; `inspect-spec2` statement rules, transitive-require, private proof, universe rule, `name-not-canonical`, `duplicate-name` → `translation`; namespace, axiom-free, frontmatter, annotation, `initialize`, imports, root-module, lakefile → `standards` via `findings.defaultIntent("standards")` (`inspect.ts:156`). Infrastructure failures carry no intent and are not findings — correct. Mislabelled: the two in 1.6. Missing: nothing a spec-2 author sees is unlabelled; spec-1 findings carry none by design, and `artifact-schema.ts:1071-1085` keeps the field optional accordingly.

## 6. Best practices, per piece

**Judge.** (a) Isolate the export step from the build step (1.1) — this is the one change that makes "the judge is the sole source of edge soundness" literally true of the code. (b) The pre-candidate probe already in TODO (a known-good and a known-bad pair through A/B/C before Compile) plus tool hashes before and after; Palomar hashes `lake`, `lean`, `leanexport`, `leanchecker`, the kernels, bubblewrap, its supervisor scripts, the configuration, both exports, and the verifier itself. (c) Record in `certificate.judge` the exact comparator invocation and the kernel notices parsed from the transcript, not the setting. (d) `noexec` on `/tmp`, as the comment claims.

**Translation.** (a) Name hygiene for readers (1.3). (b) Extend the E1 check to the bodies: after the split, have A2's inspector also report the statement constants' pretty-printed bodies and hold them to the record's `statements[].body` — then the exported Challenge is held to the archive's reading in full, and the publisher's regeneration is no longer the only non-kernel check. (c) The golden corpus the Codex review listed (quoted dots, numeric components, repeated hypothesis universes, instance binders) — `test/unit/certify-generate.test.ts` should run real inspector output through `leanName`, not handwritten strings.

**Standards.** (a) Keep `initialize`, global syntax (E1 rule), B2, D2 as hard standards and write beside each its enforcement limit, as the Codex review asked; never let a comment say a standards rule is what makes the judge sound. (b) Show the package-local cone of every statement (1.2). (c) `file://` warm entries are a test seam; refuse them in production (`verify-bundle.ts:77`).

**Provenance and binding.** (a) Pin the warm manifest per environment (TODO) — 1.4 shows it is a reader-integrity item, not only hygiene. (b) Carry the direct-require set in the report so the publisher repeats the rule. (c) Publish the judged exports (TODO) so `lax certify` can offer a historical replay; until then the website's "every certificate can be rerun from its bundle" (`shared.ts:244`) is true of the *proposition*, not of the *evidence* — say which.

**Contradictions with the stated division.** `axiomfree-plan.md:226` (hygiene "over Replay-authenticated oleans"); `spec_v2_draft.md:1749-1765` (the two-container design); `phase.ts:18` vs `container.ts:214` (`noexec`); and — the substantive one — `phase.ts:1-29`'s claim that "nothing B writes reaches C" is true while the symmetric claim for A ("nothing the build writes reaches the export") is not made and does not hold (1.1).

## 7. Palomar, for comparison

Same split (comparator judges two exports it did not produce; the verifier owns provenance), and three things Palomar does that lax does not yet: exports written to a verifier-owned location no candidate phase can reach (1.1); sandbox probes and tool hashes before candidate code runs (TODO); and a canonical Challenge that imports *no* candidate code at all. The last is structural — lax's Challenge must import concept packages — which is exactly why the two concept-side findings here (1.1, 1.2) have no Palomar analogue and need lax's own answer.
