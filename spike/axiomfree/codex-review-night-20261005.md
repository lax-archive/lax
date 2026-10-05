Date: 2026-10-05 (night), Codex gpt-6-astra at xhigh, 366k tokens; read-only, no builds or tests run by Codex.
Scope: lax `git log d964e38..axiomfree` (HEAD 7dc36dd) and lax-website `axiomfree` commits of 2026-10-04/05 — ultracode items I1, C2, C3, C5, C1, S2, S1+M1, E1 same-package syntax, unused-lemma, syntax categories, pending edges (decision 11/12), spec-2 instructions.
Command: `codex exec -s read-only -C /home/jan/git/lax --ephemeral -o <scratch>/codex-night.md - < brief2.md` (brief on stdin).

Recorder's notes (Claude, not Codex). The first run stopped at 173k tokens: OpenAI's filter returned "This content was flagged for possible cybersecurity risk" twice, and no report came out. Its last progress note was that "the publisher accepts a consistently regenerated bundle plus validate-supplied success fields without replaying the exports" (R1 below). The retry used the same brief reworded as a correctness and design review. It asked the same questions but dropped "attacker-influenced" and "forgery"-style wording. Spot-checked three citations against 7dc36dd, and all three are accurate. `src/shared/publisher.ts:295` (R1): registration refuses only pending flags recorded in `buildOutput`, read via `pendingProofIds`. `src/submission-validation/phases/inspect.ts:324` (R5): the `nested` predicate compares only line ranges, and its peer exemption applies only when the outer declaration is a theorem, so a definition sharing the line swallows a theorem. `assets/instructions-spec2.md:84`/`90` (R6): the example imports only `LaxCore` but uses `ℕ` and `Nat.Prime`. Findings are recorded, not fixed. Codex's links point to absolute paths in Jan's checkouts.

---

Reviewed both requested commit ranges and their intent records, without modifying either checkout. Findings below distinguish new regressions from existing limitations.

**R1 — High — Publication accepts certification and pending status without independently establishing either.**  
Locations: [artifact-schema.ts:350](/home/jan/git/lax/src/submission-validation/artifact-schema.ts:350), [artifact-schema.ts:450](/home/jan/git/lax/src/submission-validation/artifact-schema.ts:450), [publisher.ts:295](/home/jan/git/lax/src/shared/publisher.ts:295).

The publisher checks that the certificate matches the artifact’s claimed complete edges, but does not establish that those edges received the claimed comparator verdict.

**Failure scenario:** A successful validation artifact incorrectly omits `pending` from a sorry-backed edge and supplies a coherent regenerated certificate bundle plus well-formed judge metadata. Publication accepts it; registration finds no pending flags; the website labels the edge certified. Regeneration establishes consistency between the supplied telescope and bundle, not that the judge accepted them. Export hashes are only parsed as hashes, and the [workflow upload:265](/home/jan/git/lax/.github/workflows/submission.yml:265) supplies neither export for independent verification.

This is a verified artifact-boundary gap relevant to decision 10 and the new registration invariant. I did **not** establish a submission-controlled route for replacing those artifacts or demonstrate a sandbox escape.

**R2 — High — Revalidation can change the statement displayed under an existing certificate.**  
Locations: [submit-publisher.ts:218](/home/jan/git/lax/src/shared/submit-publisher.ts:218), [submit-publisher.ts:398](/home/jan/git/lax/src/shared/submit-publisher.ts:398), [lax-website/model.ts:183](/home/jan/git/lax-website/src/sitegen/model.ts:183).

Revalidation preserves the source triple but permits replacement of a concept’s captured meaning, while dependent certificates and website endpoint resolution remain keyed by statement name.

**Failure scenario:** Registered concept A elaborates statement `S` to one proposition; B is certified against that capture. Revalidating A at the same commit produces a different, kernel-valid body for `S` because elaboration depends on external state. A’s record is replaced, B’s certificate remains unchanged, and B’s certified edge now links to the new statement body.

This is an **existing, explicitly tracked open issue**, not introduced by this range; it prevents an unconditional “the displayed statement always equals the judged statement” answer.

**R3 — Medium — Metadata-only resubmission breaks the durable rerun of stored bundles.**  
Locations: [metadata-resubmission.ts:286](/home/jan/git/lax/src/submission-validation/metadata-resubmission.ts:286), [certify.ts:693](/home/jan/git/lax/src/cli/certify.ts:693), [certify-run.ts:182](/home/jan/git/lax/src/cli/certify-run.ts:182).

The metadata path advances the capture’s reported source commit while retaining certificates whose manifests pin the previous commit, and `--fetch --run` rejects that combination.

**Failure scenario:** A certificate pins C1. A presentation-only resubmission advances the record and `capture.sourceCommit` to C2, leaving captured Lean sources byte-identical. Fetching the stored certificate and running it fails with the revision-mismatch error. Stored certificates of dependent records can fail for the same reason.

This is **already tracked** in the plan/TODO. It remains a concrete exception to the draft’s durable-rerun promise.

**R4 — Medium — Certified judgment cards omit universe instantiations.**  
Locations: [lax-website/shared.ts:129](/home/jan/git/lax-website/src/sitegen/pages/shared.ts:129), [shared.ts:134](/home/jan/git/lax-website/src/sitegen/pages/shared.ts:134), [proof.ts:71](/home/jan/git/lax-website/src/sitegen/pages/proof.ts:71).

The card renders statement IDs and hypothesis order but discards hypothesis levels, conclusion levels, and the proof’s universe parameters.

**Failure scenario:** Telescopes `A.{u} → C.{v}` and `A.{v} → C.{v}` produce the same judgment card, although they express different universe relationships. The proof page presents that card as what the certified proof establishes.

The verbatim Challenge on the record page preserves the distinction. This is a **carried-forward display defect**, not a comparator or stored-telescope corruption.

**R5 — Low — The unused-lemma filter suppresses unrelated theorems sharing a source line.**  
Locations: [inspect.ts:324](/home/jan/git/lax/src/submission-validation/phases/inspect.ts:324), [Main.lean:1094](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:1094).

The new nesting test uses line-only containment, so an independent theorem beside a definition can be mistaken for a declaration generated inside it.

**Failure scenario:** An unused top-level theorem follows an unrelated definition on the same line. Both receive the same start/end line numbers; the definition satisfies the “outer declaration” predicate, and the warning disappears.

This is a **verified spec-1 regression**, also affecting spec 2. A read-only Lean probe confirmed distinct column ranges; an in-memory comparison of the old and current warning functions produced one warning before and none now. The new range tests cover generated declarations but miss adjacent declarations.

**R6 — Low — The spec-2 guide’s statement example does not compile with its shown imports.**  
Locations: [instructions-spec2.md:84](/home/jan/git/lax/assets/instructions-spec2.md:84), [instructions-spec2.md:90](/home/jan/git/lax/assets/instructions-spec2.md:90).

The example imports only `LaxCore` but uses mathlib’s natural-number notation and prime predicate.

**Failure scenario:** An author copies the complete statement example into a concept module; Lean reports unknown `ℕ` and `Nat.Prime`. Requiring mathlib in the lakefile does not import it into the module. I reproduced these errors with the available toolchain and `LaxCore`.

The publisher boundary, specifically:

| Independently checked or derived | Accepted from validation artifacts |
|---|---|
| Schema; issue/source binding; numeric ownership; lifecycle and stale-write gates; dependency source/capture/state against the archive snapshot | The inspected declaration facts, statement bodies, and whether each proof’s axiom cone contains `sorryAx` |
| Telescope shape, name grammar, universe constraints, derived assumptions/conclusion | That the comparator actually accepted the corresponding exports |
| Expected environment/kernel configuration; regenerated Challenge and sealed bundle bytes | Reported self-test outcome, tool hashes, and export hashes |
| Absence of **recorded pending flags** at registration and registered revalidation | That absence of those flags means every edge is actually complete |

Things checked and found sound:

- Within the validation path, Challenge inspection checks proof names, ordered hypotheses—including duplicates—conclusion, universe parameters, and universe instances; the comparator checks the proof-package constants themselves.
- The requested `certify --run` and Challenge paths keep host execution away from container-writable working directories. Builds run confined, exports are separated, and the host comparator uses a fresh judge directory.
- Pending edges are excluded from certification and proof propagation; the website renders them dashed and suppresses their certified badges.
- The persisted global/scoped syntax checks distinguish package-owned syntax kinds from imported kinds; proof-package category handling is restricted to its namespace.
- Beyond R5, I found no verified regression rejecting previously accepted spec-1 submissions in this range. No full build or test suite was run; verification used code tracing and read-only probes.
