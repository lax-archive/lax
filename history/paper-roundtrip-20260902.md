# The paper-layer production round trip (2026-09-02)

Closed record of the first real archive round trip of a paper-bearing
submission, run on the day the paper layer's stages 1–3 landed
(`f835a09`, "Add the paper layer: contract, host path, and trusted path").
It stands in for the stage-3 scratch-repo rehearsal TODO.md still lists:
this went through **production** — issues on `lax-archive/lax`, the real
Validate job, `lax-archive/lax-database`, and
`ghcr.io/lax-archive/lax-captures` — on a throwaway draft that was deleted
afterwards. Everything the plan promised landed; nothing failed.

## What was submitted

- Submission **lax-61**, issue <https://github.com/lax-archive/lax/issues/61>,
  title "Paper layer round trip (throwaway)", owner jan3er.
- Source: `https://github.com/jan3er/lax-paper-roundtrip-20260902`,
  commit `52ee6ad86bb676382945da0d6cd57a50f99a12ad`, folder `submission`.
- Content, modelled on `makePaperSubmission` in `test/support/host.ts`: two
  concept modules (`Lax61.Zero`, `Lax61.One`, each a frontmatter docstring
  plus one `axiom`), one proof module (`Lax61Proofs.Basic` with
  `zero_eq` and `one_eq`, both `:= rfl`), and a one-page `paper/main.tex`
  (article + amsthm) with four markers: an inline phrase
  (`Lax61.One`, horizontal mode), a theorem block (`Lax61.Zero`), and two
  proof environments (`Lax61Proofs.zero_eq`, `Lax61Proofs.one_eq`).
  Manifest block: `paper: {folder: paper, main: main.tex}`, engine
  defaulted to pdflatex.
- The CLI ran from source at `f835a09` (`npm run lax -- …`, 0.1.31); the
  control plane ran the same commit, which was already pushed. CI for it
  (run 33624290055) was green: `check` 4m26s, `Container smoke` 6m14s.

The scaffold from `lax init` already listed `paper.pdf` in `.gitignore`;
nothing had to be added.

## Local build

`lax build` on a TeX Live 2023/Debian host (latexmk 4.83, pdfTeX 1.40.25):

    ✓ Compiled the paper        1 page · 4 marks          3s
    Built lax-61 in 7s

`build-output.json` carried the full `paper` key: engine, `pdf.digest`
`4decd1cca949839bb509086b16ee3abb982b2e881069aa6b44db8f5280ff6922`
(91 588 bytes, 1 page), `pageSizes [[595.28, 841.89]]`, and four marks in
document order with `kind` `concept`, `concept`, `proof`, `proof` and the
expected modes (`h` for the inline pair, `v` for the three block pairs).
`paper.pdf` was written beside it. No local fixes were needed.

## The archive run

`lax submit` finished in about three minutes:

    ✓ Checked your source       jan3er/lax-paper-roundtrip-20260902 @ 52ee6ad · submission
    ✓ Built on your machine     3s
    ✓ Rebuilt in the archive    2m25s
    ✓ Wrote the public record   33s

    lax-61 is a draft in the archive
    https://laxarchive.org/lax-61/

That is the whole output: a clean submit collapses the archive run into one
row and says nothing paper-specific — no page count, no mark count, no
mention that a paper was compiled at all. The stage-3 item asked to see
`lax submit` "render a paper finding"; findings evidently only surface on
failure, which this round trip therefore did not exercise.

Run <https://github.com/lax-archive/lax/actions/runs/33625215029>
("submission control plane"): route ✓ 17 s, Validate ✓ 2 m 23 s
(11:33:48 → 11:36:11 Z), publish-submit ✓ 34 s; `publish`,
`report-validation-failure` and `report-workflow-failure` skipped. Total
3 m 22 s. The report artifact has `ok: true`, no violations, no warnings.

Timings from `validation-profile.json` (validate stage, 88.4 s total):

    static validation                  55 ms
    dependency resolution               3 ms
    paper                           86855 ms
      container image-inspect          1271 ms
      container image-pull            84420 ms      <- TeX Live
      container image-inspect            14 ms
      container paper-compile           832 ms
    validation runtime              15541 ms
      container image-pull            14249 ms      <- node:22
    compile concepts                 4514 ms
    compile proofs                   3916 ms
    replay concepts                  7667 ms
    replay proofs                    6816 ms
    inspect concepts                  609 ms
    inspect proofs                    618 ms
    resolve marks                       4 ms
    emit                              159 ms

So: the TeX image pull took **84.4 s** (the spike measured 93 s), the
compile itself **0.83 s**, and the join piece (`resolve marks`) 4 ms, as
predicted. The concurrency works — the paper span (86.9 s) and the whole
Lean chain (~40 s including the node pull) fit inside 88.4 s — but on a
submission this small the pull *is* the critical path: it roughly doubled
a validate that would otherwise have been about 45 s. The paper container
peaked at 113 MB, far under the shared 16 GB cap.

## Verification

- **Database record** (`lax-archive/lax-database/lax-61/build-output.json`,
  archive commit `fdd6706dd7830280fa80c8ce5499215e007478e9`):
  - `paper.pdf.registryBlob` =
    `ghcr.io/lax-archive/lax-captures@sha256:dc85c6eea24da834717681bca1833cd0f745c6e262ca8e81ad6354ebe569d34d`,
    `bytes` 91 575, `pages` 1;
  - `paper.marks` = the four expected ids with kinds concept/concept/
    proof/proof, modes h/v/v/v, coordinates identical to the local build's
    to the two recorded decimals;
  - `capture.registryBlob` =
    `ghcr.io/lax-archive/lax-captures@sha256:0bfa01ffdd7fce0ebbc5a9e7a3f86fb29d104475d3ecdc2421850da98039aa5c`;
  - the capture file list contains `paper/main.tex` (941 bytes), the
    author's **unrewritten** source — extracted from `capture.tar` and
    `diff`-identical to the file in the source repository, markers intact.
- **ghcr blob**: anonymous pull token from
  `https://ghcr.io/token?scope=repository:lax-archive/lax-captures:pull&service=ghcr.io`,
  then `GET /v2/lax-archive/lax-captures/blobs/sha256:dc85c6ee…` → HTTP
  200, 91 575 bytes, `%PDF-1.7`, sha256 of the bytes equal to the recorded
  digest.
- **ghcr manifest by tag**: the tag computed from `captureTag` is
  `cap-52ee6ad86bb6-2700b15a32204fcb16610d8e9ccd1594026376a64032a5a4c727d676ee0411a4`
  (over `["https://github.com/jan3er/lax-paper-roundtrip-20260902",
  "submission", "52ee6ad8…", "leanprover/lean4:v4.30.0",
  "c5ea0035…"]`). It resolves, and has exactly two layers: the capture tar
  (`application/vnd.lax.capture.v1+tar`, 102 400 bytes) and the PDF
  (`application/vnd.lax.paper.v1+pdf`, `sha256:dc85c6ee…`, 91 575 bytes).
- **Validate artifact**: `gh run download 33625215029` yields
  `submission-validation-61/` with `capture.tar`,
  `generated-build-output.json`, `paper.pdf`, `validation-profile.json`
  and `validation-report.json`. The artifact's `paper.pdf` hashes to
  `dc85c6ee…`, the recorded digest.
- **Website**: rebuild dispatched and run —
  `lax-archive/lax-website` run 33625508204, event `repository_dispatch`,
  `lax-db-updated`, success at 11:36:46 Z. `https://laxarchive.org/lax-61/`
  answered 200 while the draft existed. The page shows no paper (stage 4
  is not built yet), as expected.
- **Issue**: the outcome comment is "Updated **lax-61** from its validated
  immutable source. Archive commit `fdd6706d…`. The Website rebuild event
  was accepted.", with the `lax-result-comment-id`,
  `lax-workflow-run-id:33625215029` and `lax-outcome:success` markers.

### Host vs. archive PDF: different bytes, expected

The two PDFs differ, so the digest is a reproducibility claim only for the
pinned image, exactly as paper-plan.md says:

    host    sha256 4decd1cca949839bb509086b16ee3abb982b2e881069aa6b44db8f5280ff6922   91 588 bytes
    archive sha256 dc85c6eea24da834717681bca1833cd0f745c6e262ca8e81ad6354ebe569d34d   91 575 bytes

The cause is only the TeX version: the host's
`/PTEX.Fullbanner (This is pdfTeX, Version 3.141592653-2.6-1.40.25 (TeX Live 2023/Debian) kpathsea version 6.3.5)`
against the image's
`(This is pdfTeX, Version 3.141592653-2.6-1.40.28 (TeX Live 2025) kpathsea version 6.4.1)`
— a shorter banner plus the shifted xref offsets accounts for the 13
bytes. `SOURCE_DATE_EPOCH` did its job: both files carry the identical
`/CreationDate (D:20260902113235Z)`, and every mark coordinate matches.

## Deletion

`lax delete --yes` finished in 7 s. The record is a tombstone:
`record.json` is `{specVersion, id: lax-61, state: "deleted", createdAt,
deletedAt: "2026-09-02T11:39:20Z"}`, `build-output.json` is back to the
`{specVersion, id, issue}` stub (the `paper` key and both `registryBlob`s
are gone), `owner-list.json` is unchanged. Archive commit
`98c001ee4d91d72bb8a4b82fbffaac91f49882d5`; the issue carries "Deleted
**lax-61**; the id is permanently retired." and the website dispatch was
accepted again. Delete run: 33625733172.

Two observations, neither a failure:

- The issue stays **open** after deletion (nothing in `src/` closes an
  issue), so the retired id keeps a live-looking thread.
- The ghcr capture and PDF blobs and the `cap-…` tag are still pullable
  after the record was tombstoned — expected (tags exist for
  discoverability and GC, and no GC runs today), but the paper layer now
  puts author PDFs into that set too.

## Left over

- **`jan3er/lax-paper-roundtrip-20260902` still exists.** `gh` here has no
  `delete_repo` scope: `gh repo delete` answered
  `HTTP 403: Must have admin rights to Repository.` /
  `This API operation needs the "delete_repo" scope.` Jan deletes it with

      gh auth refresh -h github.com -s delete_repo
      gh repo delete jan3er/lax-paper-roundtrip-20260902 --yes

  (or in the repository's GitHub settings). The local clone
  `/home/jan/git/lax-paper-roundtrip-20260902` has been removed; the
  submission itself is reproducible from `makePaperSubmission`.
- `lax delete` does **not** drop the folder from `~/.lax/submissions.json`;
  the entry was removed by hand. Worth a CLI fix.
- The stage-3 item in TODO.md asked for this on scratch repos. It ran in
  production instead, on a throwaway draft, and measured what the
  rehearsal was meant to measure (image pull 84.4 s, two-layer manifest,
  `paper.pdf` in the artifact). What it did *not* exercise: a paper that
  fails to compile (the log-tail finding path), a multi-file paper with a
  bibliography, foreign marker ids, and the size caps.
