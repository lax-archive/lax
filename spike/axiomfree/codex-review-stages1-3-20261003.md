# Review: axiom-free stages 1–3

**Verdict: request changes before stages 4/5.** The two-container design does not isolate the kernel checks from the Solution build. A writable PATH directory provides a concrete way to substitute the checkers. The publisher also does not bind the displayed Challenge to the contents of the published certificate bundle.

Reviewed `main` **305040d** through `axiomfree` **2d5076d**, with the specified design records and pinned Lean/Lake sources. This was static review: no builds, tests, or exploit executions. No files were modified; the Markdown report is provided here under the read-only constraint.

## Findings, ordered by severity

### 1. High — Solution code can substitute every certification kernel

**Locations:** [run-certify.mjs:94](/home/jan/git/lax/src/submission-validation/sandbox/tools/run-certify.mjs:94), [container.ts:199](/home/jan/git/lax/src/submission-validation/sandbox/container.ts:199), [phase.ts:225](/home/jan/git/lax/src/submission-validation/certify/phase.ts:225), [verdict.ts:43](/home/jan/git/lax/src/submission-validation/certify/verdict.ts:43).

The comparator runs with `--inadvisably-no-sandbox`, under the same UID as its build subprocesses. Its PATH begins with a writable directory in `/tmp`, created for the failing `git` shim.

In pinned Lake, `whichExe` executes bare `which` and trusts its stdout. `runExternalKernel` calls it **after** building/exporting the Solution, including when locating the built-in Lean checker through its absolute path. See [`Lake/CLI/Check.lean`](https://raw.githubusercontent.com/leanprover/lean4/v4.35.0-rc3/src/lake/Lake/CLI/Check.lean).

**Failure scenario:** a proof-module initializer places an executable named `which` in that directory. It returns `/bin/true` for subsequent checker lookups. The comparator then reports kernel acceptance without running those kernels. This also affects paranoid mode. The host accepts comparator exit zero and records the requested kernel list.

The read-only Challenge export and configuration do not prevent this. There is also a broader integrity problem: the Solution export resides in writable temporary storage and is read separately for structural comparison and kernel checking.

Replay remains an earlier defense. This finding establishes that Certify is not an independent kernel attestation; it does **not**, by itself, demonstrate acceptance of a false theorem through the entire pipeline.

**Fix:** export the Solution in an untrusted container, terminate it, then judge both frozen exports in a fresh container containing no submission build execution or writable executable-search locations. Merely hardening the `git` shim leaves the shared-filesystem problem.

**Confidence: high. Basis: verified repository and pinned Lake code; exploit not executed.**

### 2. Medium — The publisher accepts a certificate bundle unrelated to its displayed Challenge

**Locations:** [artifact-schema.ts:401](/home/jan/git/lax/src/submission-validation/artifact-schema.ts:401), [submission.ts:730](/home/jan/git/lax/src/workflows/submission.ts:730), [capture-store.ts:236](/home/jan/git/lax/src/shared/capture-store.ts:236).

The publisher establishes two separate properties:

- `certificate.challenge` equals regeneration from the submitted proof metadata.
- `certificate.tar` hashes to the submitted bundle digest.

It never connects them by inspecting or regenerating the tar’s members.

**Failure scenario:** start with an otherwise accepted artifact, replace `certificate.tar` with an unrelated bundle, and update its digest consistently in the report and standalone build output. Leave the displayed Challenge unchanged. These checks accept the mismatch. Even arbitrary nonempty bytes satisfy the bundle checks if their hash matches.

Additional attestation fields have weaker checks than their presentation suggests:

- `challengeExportSha256` is checked only for SHA-256 syntax.
- `kernels` must contain known, unique names including Lean, but need not equal the configured kernel set.
- `judge.toolchain` **is** correctly tied to the runtime.
- Published `registryBlob` **is** correctly tied to the bundle digest.

This is a crafted-artifact acceptance defect. I did not establish that ordinary submission code can replace the host’s entire report or sealed bundle.

The negative at [artifact-schema-spec2.test.ts:94](/home/jan/git/lax/test/workflows/artifact-schema-spec2.test.ts:94) does not exercise coherent forgery: it changes the telescope without regenerating the Challenge.

**Fix:** verify an exact, bounded bundle against regenerated content and authoritative package sources/pins. Prefer regenerating and sealing the expected bundle, then comparing its digest. Bind kernel claims to the configured run and decide how the export hash receives independently checkable provenance.

**Confidence: high. Basis: verified code paths; no crafted artifact executed.**

### 3. Medium — Spec-2 cached captures lose content-integrity verification

**Locations:** [prooftree.ts:492](/home/jan/git/lax/src/cli/prooftree.ts:492), [prooftree.ts:589](/home/jan/git/lax/src/cli/prooftree.ts:589).

Fresh downloads verify the tar digest. Existing cache directories skip downloading and call `verifyCapture`.

For spec 2, that function now checks regular-file structure and `fileCount`, but no file hashes. The downloaded tar has already been deleted.

**Failure scenario:** after a successful download, a cached `.olean` is corrupted or replaced without changing the number of files. The next invocation accepts it under the original digest-addressed cache directory. Changing names or contents while preserving the count also passes. Spec 1 still verifies its per-file hashes.

Dropping the recorded inventory is compatible with integrity, but only if consumers retain another authenticated representation to verify on reuse.

**Fix:** retain and verify the original tar, then recreate or validate the extracted cache against it. Share this verification boundary with other capture consumers.

**Confidence: high. Basis: verified code.**

### 4. Medium — Lean names do not round-trip through the inspector and generator

**Locations:** [Main.lean:344](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:344), [Main.lean:725](/home/jan/git/lax/src/submission-validation/lean/inspector/Main.lean:725), [lean-name.ts:15](/home/jan/git/lax/src/submission-validation/certify/lean-name.ts:15), [lean-name.ts:84](/home/jan/git/lax/src/submission-validation/certify/lean-name.ts:84).

The inspector serializes names with `Name.toString`, whose default is escaped output. The TypeScript contract and generator expect unescaped canonical components and reject guillemets.

**Failure scenario:** a valid universe parameter `«λ»` is reported as `«λ»`; the generator rejects it. A quoted declaration component such as `«定理»` has the same mismatch. The escaping fixture supplies handwritten `"λ"` and `"定理"` instead of the inspector’s actual representation: [certify-generate.test.ts:77](/home/jan/git/lax/test/unit/certify-generate.test.ts:77).

The reserved-name handling is also incomplete. `_` passes `isPlainIdentifier`, although it is syntactic hole notation. Lean’s name printer deliberately leaves that particular name unescaped, so an explicitly quoted universe name `«_»` can become an invalid generated universe binder.

These are rejection/availability defects. I did not establish successful source injection or a certificate proving a different proposition through these names.

**Fix:** define one name representation at the inspector boundary, preferably structured components with an explicit supported subset. Decode/encode it consistently, and quote components conservatively rather than maintaining a partial keyword list. Test real Lean declarations through Inspect → generation → elaboration.

**Confidence: high for the serialization mismatch; medium for the unexecuted `_` example. Basis: repository and pinned Lean printer/parser code.**

### 5. Medium — Spec-2 metadata-only resubmissions cannot use the fast path

**Locations:** [metadata-resubmission.ts:278](/home/jan/git/lax/src/submission-validation/metadata-resubmission.ts:278), [metadata-resubmission.ts:173](/home/jan/git/lax/src/submission-validation/metadata-resubmission.ts:173), [metadata-publisher.ts:125](/home/jan/git/lax/src/shared/metadata-publisher.ts:125), [metadata-publisher.ts:178](/home/jan/git/lax/src/shared/metadata-publisher.ts:178).

These paths were not migrated to the new serialization boundary.

**Failure scenario:**

- A spec-2 record with proofs contains `certificate`, which `parseCurrentBuildOutput` excludes from its exact key list.
- A record without proofs gets farther, but the candidate uses the expanded manifest—including `id`—where the spec-2 stored parser forbids that field.
- The metadata publisher likewise parses and serializes expanded payloads directly.

Classification exceptions deliberately fall back to full validation, so ordinary title/author/abstract changes trigger a complete rebuild. This fails closed, but defeats an existing feature.

**Fix:** route metadata candidates and final writes through `recordedBuildOutput`; share the envelope rules instead of maintaining another exact-key list.

**Confidence: high. Basis: verified code.**

### 6. Medium — Certify rejects supported local sibling dependencies

**Locations:** [inspect-spec2.ts:88](/home/jan/git/lax/src/submission-validation/phases/inspect-spec2.ts:88), [project.ts:142](/home/jan/git/lax/src/submission-validation/certify/project.ts:142), [host.ts:51](/home/jan/git/lax/src/submission-validation/certify/host.ts:51).

Inspect explicitly accepts direct sibling concept packages for nonstrict local builds. `planCertificate` only recognizes archive-resolved dependencies.

**Failure scenario:** a spec-2 proof names a statement from a direct local sibling. Inspect accepts it, then certificate planning throws “does not require directly.” The host’s sibling lookup cannot help: planning happens before that lookup, and the later package list is derived from the archive-only plan.

**Fix:** make local package sources part of certificate planning, with explicit distinction between local and publishable plans. Add a nonstrict sibling case that reaches certification.

**Confidence: high. Basis: verified code.**

### 7. Low — Container A mounts dependency proof artifacts despite its exclusion claim

**Locations:** [phase.ts:93](/home/jan/git/lax/src/submission-validation/certify/phase.ts:93), [materialize.ts:94](/home/jan/git/lax/src/submission-validation/captures/materialize.ts:94), [materialize.ts:136](/home/jan/git/lax/src/submission-validation/captures/materialize.ts:136).

Both runs mount the entire dependency root. Materialized captures contain both concept and proof subtrees, including for records required only as concepts.

**Failure scenario:** Challenge-side code can access `/deps/<record>/proofs/...`, including dependencies outside its intended concept closure. The current submission’s own proof capture is excluded correctly, but “no proof package anywhere in A” is false.

The test checks mount names and the own-proof source path, not nested dependency contents: [certify-phase.test.ts:147](/home/jan/git/lax/test/unit/certify-phase.test.ts:147).

This does not automatically execute those proofs. Exploitation would require Challenge-side code to access them, and the design explicitly trusts selected concept authors. Hence the lower severity.

**Fix:** mount only the concept subtrees in `challengeClosure`, and test with dependency captures containing proof artifacts.

**Confidence: high for exposure; no independent exploit established. Basis: verified code.**

## Other conclusions from the requested checks

**CI credentials and environment.** The validation job holds a read-scoped repository token, not App credentials or archive/registry write permissions. Submission containers receive explicitly selected environment variables. I found no new route from submission data to the library test seams, writable warm-store contents, or a credentialed publisher executing submission code. The checker substitution above nevertheless lets build-side writes influence a trusted verdict.

**Generator semantics.** For the admitted, correctly represented names, `_root_.` addresses namespace capture of referenced constants. Universe parameters are supplied explicitly, and `set_option checkBinderAnnotations false in` scopes the exception to the following theorem. The comparator configuration and generated theorem declarations derive names from the same ordered proof list. I found no additional universe-shadowing exploit. Challenge-text equality establishes consistency with the metadata; it does not establish correspondence with captures or the downloadable bundle.

**Classification.** I found no direct soundness bypass in the listed stage-2 attack shapes:

- Tagged definitions containing `sorry` fail the body-aware axiom walk.
- Hygiene also covers helpers, rather than only exported proof entries.
- An untagged auxiliary proposition in a telescope makes it a helper, not an archive edge.
- The conclusion’s distinct-parameter rule and hypothesis parameter-membership rule implement the stated universe policy.
- Ordinary foreign-name redeclarations encounter namespace/import checks; differing referenced definitions are also comparator inputs.
- `implemented_by`, externs, unsafe code, and partial definitions do not themselves replace the kernel proof obligation. Their executable behavior makes finding 1 relevant.

The extension entry casts have toolchain-shape guards, not runtime validation of arbitrary malformed serialized objects. I did not establish a successful malformed-entry attack.

**Verdict parsing.** Attacker-produced transcript text can influence rejection diagnostics, but cannot turn a nonzero result into acceptance. Acceptance depends on exit zero; finding 1 compromises what that exit code means.

**Spec-1 compatibility.** The serializer returns spec-1 payloads unchanged, and I found no concrete stored-byte regression. The identity assertion in the test is weaker than an end-to-end byte comparison. Spec-2 keys are refused by the strict publication parser, but **not everywhere**: [archive-schema.ts:90](/home/jan/git/lax/src/shared/archive-schema.ts:90) accepts a broad envelope, and [artifact-schema.ts:185](/home/jan/git/lax/src/submission-validation/artifact-schema.ts:185) selects capture shape by field presence without its owning spec.

**Capture layers.** The new media types, upload hash checks, and digest/address comparisons are consistent. The bundle sealer fixes mode, ownership, timestamp, member order, zero terminators, and 10,240-byte blocking. Fresh dependency materialization verifies the whole capture digest before extraction. The cache-hit exception is finding 3. New certificate/reference consumers still need strict member validation after authenticating the blob.

## Fix now before stage 4/5

1. Separate Solution building/exporting from judging frozen exports; add a hostile initializer test that attempts checker substitution.
2. Bind the published bundle’s actual contents to regenerated certificate content and authoritative sources. Test coherent artifact changes.
3. Repair spec-2 cache verification on reuse.
4. Establish one Lean-name representation and test actual inspector output.
5. Move metadata publication through the shared serialization boundary.
6. Include local siblings in certificate planning.
7. Restrict Challenge mounts to their declared concept closure.

## Later

- Consolidate archive/capture readers so spec selection comes from the owning environment rather than field sniffing.
- Before using [readBundle:81](/home/jan/git/lax/src/submission-validation/certify/bundle.ts:81) on downloaded data, validate checksums, member types, duplicate names, termination, and trailing data. Its current use is in tests.
- Use explicit byte ordering for reference members; [seal.ts:239](/home/jan/git/lax/src/submission-validation/captures/seal.ts:239) currently uses locale-dependent sorting.
- Fix [runToFile:123](/home/jan/git/lax/src/submission-validation/host/proc.ts:123): spawn failure can emit both `error` and `close`, causing the descriptor to be closed twice. **Confidence: high; code and Node event semantics.** Also make timeout ownership explicit—the helper’s comment claims callers bound it, but the host certificate calls supply no timeout.
- Strengthen integration tests at the boundaries identified above. The handwritten escaping fixtures, shallow mount assertions, and one-sided certificate mutations currently miss the failures they appear intended to exclude.