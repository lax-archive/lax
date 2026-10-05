Date: 2026-10-05, Codex gpt-6-astra at xhigh; read-only. Round 2: the fixes of the night review (lax 565b8be..0b41dc6, lax-website 3217abc9c8..453bd394ef).
Command: `codex exec -s read-only -C /home/jan/git/lax --ephemeral -o <scratch>/report.md - < brief.md`.

Recorder's note (Claude): no verified defects. f28e960 (validation reads a sorryAx refusal as the archive's fault) landed during this run and is outside it; round 3 below covers it.

---

**No verified defects found in the requested committed ranges.** R1, R4, R5, and R6 close the reported cases. R2 and R3 were excluded.

For R1, the conclusion depends on the intended trust in the validate job’s verdict. The publisher still accepts that verdict and the tool/export hashes as attestations; I found no additional verified defect at that boundary.

One compatibility qualification: the trusted parser now rejects older, eight-probe spec-2 certificates. No production spec-2 environment is admitted yet, and I found no affected current fixture. The website still loads its previous fixture.

Verification was read-only: both no-emit TypeScript checks passed, alongside focused in-memory and Lean checks. Full container suites were not run. Uncommitted edits appeared during the review; those remain outside this report’s scope.

Checked and found sound:

- **R1:** [planCertificate](/home/jan/git/lax/src/submission-validation/certify/project.ts:202) selects exactly non-pending proofs for validation and publisher regeneration. The configuration permits exactly `propext`, `Classical.choice`, and `Quot.sound`. Regeneration rejects a consistently rehashed bundle that additionally permits `sorryAx`.
- **R1 probe:** [self-test.ts:351](/home/jan/git/lax/src/submission-validation/certify/self-test.ts:351) requires both an illegal-axiom verdict and the exact `sorryAx` diagnostic. Direct execution of the comparator’s comparison and axiom-check functions on the sorry-backed export produced successful comparison followed by `Illegal axiom detected: 'sorryAx'`.
- **R4:** [proofJudgment](/home/jan/git/lax-website/src/sitegen/pages/shared.ts:135) displays proof parameters and ordered endpoint instances, with HTML escaping. Universe-free and spec-1 judgments compared byte-for-byte equal to their previous output.
- **R5:** Position comparisons preserve adjacent-theorem warnings and exclude nested helpers. Reports without columns still parse. Both goldens matched on v4.33.0; the spec-1 golden also matched on v4.35.0-rc3.
- **R6:** The statement example elaborated exactly as printed. The revised Euclid proof elaborated against the described statements and shown imports; its axiom list contained only `propext`.

---

Round 3 (Codex gpt-6-astra, xhigh, read-only): `git show f28e960` alone. One low finding, the spec draft's Certify and Verdict passages not stating the sorryAx exception; fixed in the commit that records this file. Report verbatim:

The implementation looks correct and complete. I found one documentation inconsistency.

- **R1 — low — [spec_v2_draft.md:2024](/home/jan/git/lax/spec_v2_draft.md:2024), also [line 1562](/home/jan/git/lax/spec_v2_draft.md:1562).** These passages still classify comparator illegal-axiom refusals as author-facing `judge` violations without stating validation’s new `sorryAx` exception.
  
  **Concrete scenario:** validation encounters a non-pending proof containing `sorryAx` and correctly returns an infrastructure failure, but the Verdict section predicts a violation and conditionally recommends reporting a bug only when `lax build` succeeds—even though that local build now also fails operationally. Add the exception here, consistent with the updated [lifecycle wording](/home/jan/git/lax/spec_v2_draft.md:1362), and distinguish validation from reader reruns.

What I checked and found sound:

- **Caller coverage:** both [container validation](/home/jan/git/lax/src/submission-validation/certify/phase.ts:425) and [local validation](/home/jan/git/lax/src/submission-validation/certify/host.ts:194) use `validationVerdict`. The [reader](/home/jan/git/lax/src/cli/certify-run.ts:482) and [self-test](/home/jan/git/lax/src/submission-validation/certify/self-test.ts:351) retain `interpretComparatorRun`. Pending proofs are excluded by [certifiedProofs](/home/jan/git/lax/src/submission-validation/certify/generate.ts:121).
- **Workflow consequences:** the failure remains `retryable: false`, produces exit **1**, stops before certificate sealing, and is preserved in the report artifact. [Publication requires successful validation](/home/jan/git/lax/.github/workflows/submission.yml:304), so the database remains unchanged. The [issue reporter](/home/jan/git/lax/src/workflows/submission.ts:203) and [CLI](/home/jan/git/lax/src/cli/build.ts:481) correctly describe an infrastructure failure. There is no automatic validation retry loop.
- **Author-defined axioms:** `Lax38Proofs.sorryAx` does not match the exact root-name special case; ordinary authored axioms are independently [rejected during inspection](/home/jan/git/lax/src/submission-validation/phases/inspect-spec2.ts:354). A Lean stdin check confirmed that redeclaring root `sorryAx` fails and a namespaced axiom retains its qualified name. Other illegal axioms remain forbidden even alongside `sorry`.
- **Multiple errors and paranoid kernels:** the installed comparator source checks axioms before running kernels and throws on the first illegal axiom. A normal run therefore cannot combine that refusal with a later kernel verdict. Earlier mentions of `sorryAx` do not override another final diagnostic; existing kernel-failure classifications remain unchanged.
- **Comments and verification:** the new wrapper comments accurately describe its behavior. Typechecking and **130 in-memory verdict/exit-code cases passed**. Full integration tests were not run because their setup writes files. No files were changed.
