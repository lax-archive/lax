**Verdict: revise the security argument before adopting it.** The separation of responsibilities is useful, and dropping proof-package Replay can preserve certified-edge correctness. But the stated trust boundary is incomplete, the Challenge alone is insufficient evidence, and the name translation contains a concrete ambiguity.

Static review only; no files modified, builds, or tests run. Reviewed `axiomfree` at HEAD `0da3139`, including working-tree changes. Files changed concurrently during review; the last inspection included the Replay exemption and intent plumbing. Palomar’s security policy was fetched.

**1. High — Lean name serialization can bind a certificate to the wrong registered statement**

Locations: [lean/inspector/Main.lean:379](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:379), [Main.lean:609](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:609), [certify/lean-name.ts:121](/home/jan/git/lax/src/submission-validation/certify/lean-name.ts:121), [phases/inspect.ts:326](/home/jan/git/lax/src/submission-validation/phases/inspect.ts:326).

The inspector serializes names using `Name.toString (escape := false)`. The generator reconstructs them by splitting on `"."`. This representation is not injective:

```lean
Lax1.C.«A.B»
Lax1.C.A.B
```

These are different Lean names but become the same inspector string. The identifier regex accepts that flattened string, and `uniqueDeclarations` silently retains the first declaration with it.

An attack shape is a tagged `«A.B» : Prop := False` and an untagged `A.B : Prop := True`. If inspection retains the tagged declaration, a theorem proving the untagged constant can be classified under the registered statement’s flattened identifier. Generated Challenge and Solution both name the unquoted, nested constant. The comparator can correctly accept that theorem while the archive associates it with the other declaration.

This is a static counterexample shape, not an executed reproduction. The lossy serialization and silent deduplication are directly present in the code. Replay does not resolve this: both definitions can be perfectly well typed.

**Required change:** preserve structured `Lean.Name` components, including string versus numeric constructors, through inspection and generation. Alternatively, reject unsupported names in Lean before flattening them. Reject ambiguous identities rather than deduplicating them. The round-trip property must cover statement names, proof names, and universe parameters.

This also answers the inspector-input question: its telescope can be an untrusted proposal, but the encoding that connects that proposal to registered statement identities is part of the translation boundary.

**2. High — The missing fourth responsibility is provenance and attestation binding**

Locations: [axiomfree-plan.md:71](/home/jan/git/lax/axiomfree-plan.md:71), [certify/phase.ts:179](/home/jan/git/lax/src/submission-validation/certify/phase.ts:179), [certify/project.ts:288](/home/jan/git/lax/src/submission-validation/certify/project.ts:288), [certify/verify-bundle.ts:100](/home/jan/git/lax/src/submission-validation/certify/verify-bundle.ts:100).

Container C establishes a property of two exports under a configuration. It does not establish that:

- the Challenge export represents the published Challenge source;
- its constants are the concept definitions the record and website identify;
- the actual library artifacts correspond to the recorded pins;
- the successful invocation is attributed to the correct published record.

Those links depend on capture production, dependency resolution, search paths, environment provisioning, export handling, the publisher, and the database. The three-container arrangement protects an important boundary, but does not eliminate these responsibilities.

In particular, A builds against **captured concept artifacts**, including the submission’s own concepts. Concept code can execute during Challenge compilation. Concept Replay checks declaration validity relative to imports; it does not authenticate source-to-olean correspondence, initializers, or the meaning of the source a reader sees. The explicit trust in concept authors is therefore substantial and must include the submission’s own concept package.

The publisher’s regeneration is valuable: it prevents publishing an unrelated five-file bundle. It is nevertheless another correctness-critical mechanism, and it uses the same generator, so it cannot independently detect finding 1.

There is also an acknowledged provenance gap: [verify-bundle.ts:59](/home/jan/git/lax/src/submission-validation/certify/verify-bundle.ts:59) accepts transitive warm-manifest entries from the supplied bundle after shape checks; only the named environment libraries receive URL/revision checks. Regeneration does not authenticate the complete dependency closure. This is not, by itself, evidence that ordinary candidate code can alter the trusted warm store, but it limits what publication verification proves.

Digest-addressed storage need not be trusted to return correct bytes when consumers verify hashes. The **record assigning those hashes to packages and sources** remains trusted.

A defensible formulation is:

> The judge is the sole proof-validity checker for certified edges. Archive edge soundness additionally requires faithful translation, authentic Challenge inputs, and correct binding of the verdict to the published record.

Palomar explicitly makes this distinction: supplying both exports means the comparator does not check their correspondence with the project; its verifier owns that provenance obligation. [Palomar security policy](https://raw.githubusercontent.com/PalomarRegistry/PalomarSubmission/main/SECURITY.md).

**3. Medium — Showing Challenge.lean is useful, but does not remove the TypeScript or publication chain from trust**

Locations: [axiomfree-plan.md:85](/home/jan/git/lax/axiomfree-plan.md:85), [certify/generate.ts:59](/home/jan/git/lax/src/submission-validation/certify/generate.ts:59), [artifact-schema.ts:379](/home/jan/git/lax/src/submission-validation/artifact-schema.ts:379), [cli/certify.ts:560](/home/jan/git/lax/src/cli/certify.ts:560).

Reading the Challenge checks the visible implication and universe instantiations. It does not establish what imported constants mean, what was actually exported, or whether the published success belongs to those bytes.

A complete reader’s audit needs:

| Evidence | Purpose | Publication status in this implementation |
|---|---|---|
| Challenge source | Inspect endpoints, hypotheses, universes | Stored verbatim and included in bundle |
| Solution source | Inspect application of the named proof and proof attribution | Included in bundle |
| `comparator.json` | Check target list, permitted axioms, absence of definition holes | Included in bundle |
| Concept definitions and dependencies | Establish the meaning of endpoints | Source/captures are published; semantic correspondence still needs trust or independent checking |
| Lakefile, full manifest, toolchain identity | Establish resolution and build inputs | Lake files in bundle; toolchain name in record; full warm-closure authentication is incomplete |
| Actual judged exports | Recheck the exact historical evidence | Hashes recorded; exports are not included in the five-file bundle |
| Tool/verifier identity and verdict binding | Authenticate the historical run | Toolchain name, kernel names, and exit code recorded; binary digests/self-test evidence remain TODOs |

The export hashes are only format-checked by the publisher. Furthermore, `lax certify --run` invokes the comparator over a rebuilt project; it does **not** compare newly produced exports with `challengeExportSha256` and `solutionExportSha256`. Default regeneration also permits a different bundle digest while requiring the same Challenge text ([cli/certify.ts:393](/home/jan/git/lax/src/cli/certify.ts:393)).

Thus “independently prove this proposition again” and “replay exactly the archive’s historical evidence” are presently different operations.

**Required change:** narrow the website claim, publish the exact exports or a supported reconstruction-and-comparison procedure, and provide a reader checklist covering the table above. A successful independent rerun can remove substantial trust in lax; merely reading the displayed Challenge cannot.

The renderer is another deployment qualification: [cli/website.ts:1230](/home/jan/git/lax/src/cli/website.ts:1230) still withholds spec-2 capture addresses from the pinned renderer. The separate website branch described in the plan was outside this code review.

**4. Medium — Dropping proof Replay preserves a narrower guarantee than the plan describes**

Locations: [axiomfree-plan.md:102](/home/jan/git/lax/axiomfree-plan.md:102), [pipeline.ts:300](/home/jan/git/lax/src/submission-validation/pipeline.ts:300), [phases/replay.ts:19](/home/jan/git/lax/src/submission-validation/phases/replay.ts:19), [spec_v2_draft.md:363](/home/jan/git/lax/spec_v2_draft.md:363).

**For certified edges, the removal is defensible**, assuming authentic Challenge inputs and the fresh export-based judge remain mandatory. A forged helper used in an exported edge’s proof cone must survive kernel replay there. A later record’s certified edge gets the same protection.

However, proof packages are not necessarily leaves: the specification explicitly permits other proof packages to require them.

The losses extend beyond a permanently dead helper:

- A malformed helper can be archived and later imported by ordinary Lean users, whose import does not establish its validity.
- A downstream proof package can use that helper outside every certified edge cone. Its standards inspection still reads unchecked declaration data.
- A package with no classified edges runs no Certify operation.
- Classification completeness, helper descriptions, and other non-certified observations receive no theorem-validity guarantee from the judge.

A concrete case is a forged helper claiming `False` with an invalid, axiom-free-looking body. Its axiom walk may find no forbidden axiom. A downstream ordinary import can trust the claim. A downstream certified edge using it should fail the fresh judge; a downstream unused helper need not reach that judge at all.

The argument that “no standards check consumes Replay’s output” is not sufficient. A successful gate can establish a precondition for later reads without returning a data object.

There is also an important limit to the loss: Replay already did **not** authenticate docstrings, source correspondence, or `.ilean` metadata. The references layer currently contains only concept sources and concept `.ilean` files ([captures/seal.ts:118](/home/jan/git/lax/src/submission-validation/captures/seal.ts:118)); dropping proof Replay therefore creates no direct proof-`.ilean` route into that layer.

**Required change:** advertise “certified edges checked; other proof-package declarations not independently replayed.” Keep every downstream certificate mandatory, and offer whole-package replay for consumers who need checked reusable helpers.

**5. Medium — Private-name exemption does not establish composition against hostile artifacts**

Locations: [phases/inspect-common.ts:48](/home/jan/git/lax/src/submission-validation/phases/inspect-common.ts:48), [inspect-common.ts:84](/home/jan/git/lax/src/submission-validation/phases/inspect-common.ts:84), [lean/inspector/Main.lean:191](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:191).

The exemption recognizes any flattened name beginning `_private.`. It does not check that the embedded module identity belongs to the declaring module.

Compiler-generated private names are normally disjoint because Lean inserts their module name. A hostile artifact can manufacture a name under another module’s private prefix. Two individually accepted packages can then contain incompatible declarations with that same name and fail when imported together. Kernel-valid bodies do not prevent this, so retaining Replay would not establish ownership either.

The reserved-name exemption has a related limitation: the inspector explicitly acknowledges that forged matcher metadata can exempt names from namespace enforcement. Its description of this as hygiene-only is inconsistent with a strong promise that the namespace rules guarantee arbitrary composition.

**Required change:** distinguish a convention for normally elaborated packages from an adversarial composition guarantee. For the latter, validate structural name ownership and tightly constrain exceptions; do not treat a private-looking prefix or metadata-derived reserved status as authenticated provenance.

**6. Medium — The intent categories are useful routing labels, not complete or disjoint security properties**

Locations: [contracts.ts:39](/home/jan/git/lax/src/submission-validation/contracts.ts:39), [phases/inspect-spec2.ts:137](/home/jan/git/lax/src/submission-validation/phases/inspect-spec2.ts:137), [phases/inspect.ts:156](/home/jan/git/lax/src/submission-validation/phases/inspect.ts:156), [certify/verdict.ts:136](/home/jan/git/lax/src/submission-validation/certify/verdict.ts:136).

Several rules need more precise descriptions:

| Rule | Appropriate interpretation |
|---|---|
| Universe rule | Translation invariant required for the name-only graph’s generality claim |
| Registered statement identity | Translation invariant, dependent on authenticated registry/concept provenance |
| Direct rather than transitive require | Primarily an archive policy; a transitively available, correctly identified statement is not mathematically invalid. The current generator makes directness an implementation precondition |
| Root-module exactness | Standards rule with operational significance: certification imports package roots. “No docstring” is editorial; reaching the certified declarations is necessary for the build |
| Import rule | Direct-import conventions are standards; preventing proof artifacts from entering A and authenticating its dependency closure are security boundaries |
| Whole-package axiom hygiene | Standards outside edge cones; the judge independently enforces the axiom restriction within certified cones |

Keep an author-facing primary intent if useful, but document these dependencies separately. Provenance failures and infrastructure failures should not be forced into “your proof is wrong.”

The current verdict parser does exactly that for some failures: `Error while interacting with ... kernel` and arbitrary kernel exit failures become `kernel-rejected` violations. The inspected comparator implementation converts kernel crashes and invocation errors into exit 1 too. A kernel that failed to run has supplied no mathematical rejection.

Additionally, the shared `REPORT` message says comparator refusal necessarily indicates a lax bug. After dropping Replay, a forged proof artifact reaching the judge is an expected adversarial rejection, not evidence of a generator defect.

**Required change:** reserve mathematical rejection for recognized comparison, axiom, or kernel diagnostics; report crashes, launch failures, and unexplained stops as operational failures. Separate intent from diagnosis and responsibility. Also reconcile the promise of a label on every finding with `intent` remaining optional for shared phases.

**7. Low — The plan and draft still describe incompatible validation contracts**

Locations: [axiomfree-plan.md:180](/home/jan/git/lax/axiomfree-plan.md:180), [axiomfree-plan.md:242](/home/jan/git/lax/axiomfree-plan.md:242), [spec_v2_draft.md:1350](/home/jan/git/lax/spec_v2_draft.md:1350), [spec_v2_draft.md:1688](/home/jan/git/lax/spec_v2_draft.md:1688).

The remaining contradictions affect the security explanation:

- The hygiene paragraph still says inspection runs over Replay-authenticated oleans.
- The main Certify design and draft describe B running the comparator and C as optional, despite C being implemented as the isolated judge.
- The draft retains mandatory proof Replay and the old kernel-grade trust-chain explanation.
- The draft certificate schema still stores an edge list and omits both export hashes ([spec_v2_draft.md:1023](/home/jan/git/lax/spec_v2_draft.md:1023)).
- The draft describes every generated binder as explicit, while `theoremText` preserves binder kinds ([certify/generate.ts:194](/home/jan/git/lax/src/submission-validation/certify/generate.ts:194)).
- Decision 10 calls the translation the only correctness-critical component outside the kernel while also relying on trusted concept authors and authenticated captures.

At the last read, private exemptions, intent plumbing, and the proof Replay skip had appeared in the working tree. They should no longer be reported simply as unimplemented TODOs.

**Best practices**

- **Judge:** make the existing self-test TODO an admission/runtime requirement *before Compile executes candidate code*. Exercise a passing pair, statement mismatch, invalid proof export, and sandbox negative controls. Record toolchain release identity, executable/shared-library integrity, verifier revision, configuration, export hashes, and probe results. Add independent kernels as additional attestations; they do not authenticate statement provenance. Palomar provides concrete precedent for pre-candidate probes and tool hashing. [Security policy](https://raw.githubusercontent.com/PalomarRegistry/PalomarSubmission/main/SECURITY.md).
- **Translation:** fix name serialization first. Extend the golden corpus to quoted dots, numeric components, duplicate identities, universe permutations, repeated hypothesis universes, and declaration-kind mismatches. Add an independent structural checker over the generated/exported Challenge and registered statement identities; regenerating with the same TypeScript is insufficient independence.
- **Provenance and audit:** commit the complete environment dependency lock; publish exact judged exports and a verdict manifest binding them to the record, configuration, tools, and source/capture identities. Provide separate commands for historical replay and fresh source verification.
- **Standards:** retain hard violations for explicitly chosen axiom/sorry hygiene and structural package requirements, while stating their enforcement limits. Keep unused-helper and proof-dependency findings advisory. Document each rule’s rationale and primary intent; do not infer security irrelevance from the `standards` label.
