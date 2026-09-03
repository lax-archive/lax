# Spec amendment notes

Proposed amendments to [spec.md](spec.md), written while implementing — one
entry per change, with the implemented behavior and the reason it diverges
from or refines the current text. To be folded into the spec manually; this
file is not normative. (Entries of earlier milestones were folded into
spec.md on 2026-07-22 and removed here.)

## The paper layer: archive-compiled PDF and derived web view (implemented, 2026-09-02)

A submission may carry the paper itself — a LaTeX document the archive
compiles and shows beside cards for the marked concepts, proofs, and
submissions. The layer sits strictly on top of the existing content:
concepts keep being defined by the Lean module and its annotation, and the
paper only points at them. Both halves below are implemented on both
validation paths; the design records (paper-plan.md, paper-web-plan.md)
retire into `history/` after the Jan-owned production round trips.

**Manifest.** One optional block:

    paper:
      folder: paper       # a plain directory inside the submission, may be "."
      main: main.tex      # a regular file inside folder
      engine: pdflatex    # pdflatex | lualatex | xelatex, default pdflatex
      web: false          # optional: opt out of the derived web view

The vocabulary mirrors arXiv's 00README (compiler, entry file) so an author
carries the same choices there; containment is the `source.folder` rule.
`web` defaults to true and gates only the derived view below.

**Markers.** Passages are marked with bare comment lines — `% lax begin
<id>` … `% lax end` — that the author's own build ignores completely: no
package, no preamble change. A marker is an unescaped `%` whose text is
`lax begin <id>` or `lax end` (optional id, which must equal the innermost
open marker); any other `% lax` comment is a violation, so a typo cannot
silently drop a passage. Markers nest, close in the file that opened them,
and are read from every `.tex` file under the folder. `<id>` is a concept
id (`Lax261.Treewidth`), a proof id (`Lax261Proofs.Q`), or a submission id
(`lax-42`) — three card kinds; statement ids, package roots, and mathlib
names have no card and are violations. Ids resolve against the submission
itself and the union of `requiredByConcepts` and `requiredByProofs` —
directly required only, exactly as for assumptions: to talk about it,
require it. Anything else is a citation and belongs in the bibliography.

**Build.** The archive rewrites each marker comment — on a copy, never in
the author's tree — into a `\laxmark{b|e}{<n>}%` call (numbers, never ids,
so no escaping question exists) and compiles with latexmk:
`-halt-on-error`, restricted shell escape as on arXiv, bibtex/biber or a
shipped `.bbl`, `SOURCE_DATE_EPOCH` from the source commit, and
`assets/tex/laxmark.sty` injected through `-usepretex` in front of the
author's `\documentclass`. The package lowers each call to a PDF named
destination `lax.<n>.<b|e>.<v|h>` (the `v`/`h` mode tag disambiguates
line-start geometry for the viewer), with a glue lift in vertical mode so
the whatsit stays layout-neutral. pdf.js reads the destinations back, and
every mark must leave exactly one begin and one end — a marker swallowed
by verbatim or a moving argument is caught here, by count, naming the id.
A compile error fails validation exactly as a broken frontmatter does; TeX
warnings and overfull boxes never do, and the log tail rides the report
artifact.

**A second digest-pinned image** (Archive Environment): the trusted
compile runs in `PAPER_IMAGE` (`src/submission-validation/pins.ts`,
`texlive/texlive:TL2025-historic`) — a full historic TeX Live, so the
author's package set is present and the text layer gets real fonts —
pulled on demand only for paper-bearing submissions, driven through the
same hardened container runner with none of the Lean mounts, concurrent
with the Lean chain. Locally `lax build` compiles with the host latexmk
(≥ 4.77; skipped with a note when absent) as a preview; the archive's run
is the authority.

**Recorded shape and storage.** `build-output.json` gains one optional
`paper` key, present iff the manifest declares a paper: the echoed block
(folder/main/engine), `pdf` (digest, bytes, pages — published records add
`registryBlob`), `pageSizes`, and `marks` in document order (id, kind,
begin/end as page + PDF coordinates + mode). The PDF bytes become a
**second layer of the capture's OCI manifest**
(`application/vnd.lax.paper.v1+pdf`, `src/shared/capture-store.ts`) so one
manifest keeps capture and PDF alive together and consumers fetch the PDF
alone by digest; the original paper sources ride in the capture tar under
`paper/`, so a registered record stays self-contained. Caps: folder
50 MiB / 2 000 files, PDF 25 MiB / 500 pages.

**Byte identity, the final form.** Text positions in the archive's PDF are
byte-identical to the author's own build for all measured marker patterns,
with one deliberate placement deviation: an own-line end marker directly
followed by a blank line is lowered *after* the blank line, in vertical
mode (a run of consecutive ones moves as one block, order preserved). Left
in place it was the sole content of the paragraph TeX resumes after an
`\end{equation}`-style display — TeX discards an *empty* resumed segment
but not one holding a whatsit — and the resulting glyph-free line pushed
everything below by one `\baselineskip` (~12 pt measured). The relocation
lives in the rewriter (`paper/rewrite.ts`), not the package, because
sty-level fixes are provably unsound: without lookahead the macro cannot
tell a following blank line from continuing text (`\par`-ing an empty
resumed segment visibly splits the continuation case), and a one-token
lookahead cannot fix a run of end markers — the peek sees the next
`\laxmark`, and the first whatsit in the segment already forces the
phantom. `laxmark.sty` is unchanged. The mark table is unchanged too
(each mark keeps the marker comment's own file:line), and both consumers
read the moved destination as the same range close: in vertical mode the
destination reports the preceding line's baseline either way, and the web
stream records the same between-paragraphs position. Residual non-neutral
shapes, each costing exactly one `\baselineskip`: an own-line end marker
whose paragraph ends on the very next line with no blank line adjacent —
`\section` or `\par` directly after it, or a `% lax begin` line separating
the marker from the blank line. `instructions.md` tells authors to give
such an end marker a blank-line neighbor. Measured with pdflatex and
lualatex (`test/e2e/paper-neutrality.test.ts`); xelatex is untested for
the relocation.

**The derived web view.** Beside the PDF, the archive derives a reflowable
HTML rendering of the same sources — ReflowTeX, our pinned fork of
`radek-p/reflowtex`: LuaTeX serializes the finished node list (paragraphs
unbroken, displays as finished boxes) and the site's viewer re-runs line
breaking at the reader's width, so width, zoom, and theme become reader
parameters while intra-line typesetting stays genuine TeX. The derivation
is **transparent** — no new author vocabulary, no source restructuring: a
fresh rewritten copy of its own compiles under lualatex (regardless of the
manifest engine, which keeps governing the PDF) with
`assets/tex/laxreflow.sty` injected the way `laxmark.sty` is, and the same
markers surface as exact content-stream positions (no coordinates, no mode
tags on this target). One flag deviation from the PDF compile:
`-shell-escape`, which tikz's external library requires for its picture
sub-runs — contained by the sandbox (no network, read-only root, resource
caps, none of the Lean mounts) and used by nothing else; every converted
picture passes an element/attribute-allowlist SVG sanitizer. And it is
**never blocking**: every derivation failure — lualatex error, marker
count mismatch in the stream, cap overrun, oracle divergence — is a
warning finding with a `web-*` rule on the `paper` phase; `paper.web` is
omitted, the reason rides the report and `lax submit`, and the PDF path
never notices. `paper.web: false` opts out (then: not attempted, no
warning).

**The oracle.** Before a bundle is recorded, the stream's glyph text must
agree with the PDF's text layer as normalized token sequences —
hyphenation rejoined, ligatures/accents/casing folded, PDF-side furniture
stripped, `\marginpar`-style captured-but-unreferenced paragraphs
tolerated and each reported as its own warning — within a 0.98 similarity
floor (`paperWebOracleSimilarity`); divergence skips the web view naming
the first mismatch. This converts reflow's silent misread class into loud,
attributable skips.

**Web shape and storage.** `paper` gains one optional `web` key, present
iff derivation succeeded: `format` — the pin that keeps the bundle
interpretable (`tool`, fork `rev`, wire-schema hash) — and `bundle`
(digest, bytes; published records add `registryBlob`). The bundle is one
tar — `index.json`, `blocks/*.pb`, content-hashed `fonts/*.otf`, and its
own `schema/latex.proto`, so it is self-describing — stored as a **third
layer of the same capture OCI manifest**
(`application/vnd.lax.paper-web.v1+tar`, 25 MiB cap). Its digest is a
**content address, not a reproducibility claim** — the deliberate opposite
of the PDF digest: within-run integrity is inherited (hash → push →
verify → record), but a re-derivation may produce a new digest while any
of the encode stack floats; upgrading to a reproducibility claim is a
later, additive tightening. Homes and join keys are frozen, formats are
not: the site build gates each record's schema hash against the viewer's
supported set and drops a mismatch to the PDF-only page rather than
rendering it wrong.

**Licensing.** ReflowTeX is AGPL-3.0-or-later. No upstream source file is
committed to this repository: `reflowtex/fetch.mjs` obtains the pinned rev
of our public fork `lax-archive/reflowtex` (its `lax` branch carries our
changes as AGPL-labelled commits; created 2026-09-03, replacing the interim
upstream-plus-patches fetch), and the npm `files` allowlist excludes the
directory — `laxreflow.sty` ships but is lax-authored and only *loads* the
serializer. The website serves
the fork's viewer unminified with its license text (source availability,
AGPL §13), and the packaged page-builder that vendors it into the `lax`
npm tarball is **aggregation with notices**: `page-builder:package` writes
a deterministic `THIRD-PARTY-NOTICES.txt` and refuses vendored code whose
license text is missing; `page-builder:verify` re-checks it. lax's own
code stays Apache-2.0.

Spec touchpoints: manifest.yaml (the optional `paper` block); Submission
Layout / Archive Environment (the second pinned image and the ReflowTeX
pin); Build Pipeline (the concurrent paper phase, the static marker gate,
the non-blocking web derivation); Archive Database (the `paper` and
`paper.web` shapes; the second and third capture layers); Site Generator
(the paper page's two surfaces); CLI (`lax build`'s preview compile,
doctor's LaTeX row, `lax serve`'s paper and bundle caches).

## `lax init --offline`: the placeholder id `lax-0` (implemented, 2026-08-24)

`lax init` opens an issue to allocate `lax-N` before it writes a single file
(spec.md, Actions/Init). `--offline` skips that half: it signs in to nothing,
opens no issue, and scaffolds under **`lax-0`** — `id: lax-0` in the manifest,
packages `Lax0` and `Lax0Proofs`. Nothing is reserved, so a folder that turns
out to be a false start burns no id, and the scaffold needs no login at all.
Mathlib provisioning is unchanged: init still seeds the warm store's overrides
and manifests, and still only warns when it cannot.

GitHub numbers issues from 1, which is what makes 0 usable: no record can ever
carry it. Refusing it therefore stays the default everywhere.
`SUBMISSION_ID_PATTERN` is unchanged, and `validateSubmissionId` /
`normalizeSubmissionId` accept the placeholder only when a caller passes
`{ placeholder: true }`. Exactly three do: `packageNameForSubmission` (naming
a package is not a decision about the archive), the manifest validator (so an
offline scaffold reads the id-mismatch violation rather than a syntax one —
in the trusted path the expected id comes from the issue number, so `lax-0` is
refused either way), and `submissionIdFromFolder` in the CLI. Everything on
the archive side — `validationRequestFromUnknown` and the container entry
point, the trusted publisher, the database schema, dependency ids,
`supersedes`, the capture store — is untouched and refuses `lax-0` as before.

What works with the placeholder: `lax build` (a full local validation,
`build-output.json` and all), `lax serve` (the preview renders it as a
synthetic draft beside the database records), and `lax doctor`, which labels
such a folder by its basename rather than its id — every offline scaffold
shares `lax-0`, so three of them would otherwise be three identical rows.
What refuses it: `lax submit`, `lax register`, `lax delete` and `lax owners`,
all four of which resolve their target through `issueNumberFromFolder`. That
function now names the placeholder and says what to do instead; on the way,
`resolveIssueReference` stopped swallowing a folder's manifest error and
answering it with a lecture about issue URLs.

There is no renumbering command. Moving an offline scaffold to a real id
means `lax init` in a fresh folder and carrying the sources across, because
package names, imports and namespaces all embed the id — the open item is in
TODO.md.

The author entry is the one thing an offline init cannot know: `lax init`
writes the GitHub handle it just authenticated as, `--offline` writes the name
Git is configured with, and when Git has none either it writes the empty
`authors:` list the spec already allows.

Spec touchpoint: the CLI `lax init` description and the Actions/Init
paragraph — init no longer always allocates an id.

## Versioning: `supersedes` successor chains (implemented 2026-08-23; authorization tightened 2026-09-01)

Submissions stay frozen in time (spec.md, Versioning), but work improves.
The implemented mechanism is the arXiv model: a new version is an ordinary
new submission with a fresh, unrelated id, and `manifest.yaml` gains one
**optional** key, `supersedes: lax-N`, naming the registered submission it
replaces. Fresh ids are essential, not incidental: package names derive from
the id, so both versions can coexist in one dependency graph, every
dependent's rev-pinned require stays valid forever, and citations to the old
id keep meaning what they meant.

Semantics, all enforced by the control plane:

- **Only a registered submission can be superseded.** Drafts are updated by
  re-submitting; deleted ids are retired.
- **A submission has at most one successor** — the chain is a list, never a
  tree. The claim travels through drafts *provisionally* and **binds at the
  successor's registration**; competing drafts may claim the same target,
  and the first to register wins the slot. A deleted draft never bound
  anything, so the slot reopens by itself.
- **Only the target's owners may supersede it**: the canonical GitHub identity
  executing `/lax submit` or `/lax register` must appear in the target's
  frozen owner list. The ordinary command authorization also requires that
  identity to own the successor. Manifest `authors` play no role — they are
  credit, not rights-management.
- **The superseded record is never touched.** The forward pointer lives only
  in the successor's validated manifest, echoed into its
  `build-output.json` (`inputs.manifest.supersedes`); "superseded" is a
  property the site generator *derives* from reverse pointers. Registered
  immutability survives unmodified, and cycles are structurally impossible:
  when a claim binds, its target is already immutable.

Where the checks run: shape and self-reference in the manifest validator;
target existence/state, the necessary owner-list overlap, and slot uniqueness
in the resolution phase against the pinned Archive snapshot (so `lax build`
and the read-only gate answer before anything compiles); and — trust rule 2 —
the canonical command actor's membership in the target owner list, together
with the other admission checks, in both trusted publishers at the
CAS-consistent snapshot (`supersedesProblems` in `src/shared/publisher.ts`,
slot scan in `ArchiveRepository.listRegisteredSuperseders`). `lax register`
runs the structural checks in its local preflight and names the permanence in
its notes before the typed confirmation. `lax submit` refuses a claim from a
non-owner actor, or one that can never bind because the target is unregistered
or its slot is occupied, while the author still holds a fresh build.

The website (lax-archive/lax-website) derives the chains: a superseded
submission's pages carry a prominent banner linking to the latest version, a
Versions list renders the whole chain, superseded work is grouped after
current work in the library, and its BibTeX gains a `note = {superseded by
lax-N}`. Endorsements do **not** carry over — they attest specific code —
so both versions' standing stays visible.

Accepted limitations, on record: no retro-linking (two already-registered
submissions can never be joined into a chain afterwards — the claim lives in
the immutable manifest) and no undo (a bound claim is as permanent as
registration itself; the CLI's typed confirmation is the guard). The
acyclicity argument rests on registered-record immutability; the designed
`admin reset-draft` verb (admin-plan.md, unimplemented) would break that
premise and must carry its own chain check when it lands — the caveat is
recorded there. If the
retro case ever becomes real, the alternative is a `/lax supersede` command
writing into `record.json`, at the cost of a hole in registered-record
immutability — deliberately not built now.

Spec touchpoints: manifest.yaml key list ("no keys beyond these" needs the
optional `supersedes`), Lifecycle/Actions (what registration additionally
binds and checks), Site Generator (the derived chain views).

## The CLI prints one report, not a log (implemented, 2026-08-09)

spec.md's command list (~1135–1155) says what each command *does*; it says
nothing about what each one *prints*, and the CLI had drifted into narrating
its own internals — issue numbers, workflow run ids, archive commit SHAs, "the
three stub files", "the Website rebuild event was accepted", the words
*lax-database* and *control plane* — interleaved with the two or three facts
that are the author's business. `lax init` said "initialized" three times in
nine lines and buried its one actionable line ("not inside a git repository")
in lowercase log voice in the middle. The redesign (`cli-output-draft.md`, Jan's
brief in `jans_list.md`) is now implemented.

The rules, enforced in one place (`src/cli/ui.ts`) so no command has to
remember them:

- **No command-name prefixes.** `lax init:` on every line is a log format, not
  a UI. Gone everywhere, errors included — a failure is `✗ <message>`.
- **One title, one verdict.** A slow command opens with a title line, spins a
  declared row per stage, and closes with a bold one-line verdict. A fast
  command prints only the verdict (`lax owners`, `lax sync`, `lax logout`).
- **Step lists only where there is real waiting**, and nothing is said twice.
- **Internals are a `--verbose` concern.** `-v`/`--verbose` is on every
  command; so is `--no-color` (and `NO_COLOR`, and not-a-TTY). Run ids, comment
  URLs, archive commits, dispatch outcomes, `build-output.json`, credential
  paths and App client ids reach the screen only there. They stay reachable
  because they are exactly what a bug report needs.
- **One link, and it is the author's own page** — hence the new
  `WEBSITE_BASE_URL` / `submissionUrl()` in `src/shared/constants.ts`; the CLI
  had no website base URL before, only `WEBSITE_REPOSITORY`.
- **Notes last, in one block, each with its fix.** `!` yellow, the fix on the
  line below.
- **Elapsed time on anything over three seconds**, so four silent minutes read
  as work rather than as a hang.
- **Piped output is the same words**: no spinner, one line per settled row,
  still complete. Agents drive this CLI and read what it prints.
- **The author's nouns**: *your machine* and *the archive*, not *local
  validation* and *the trusted workflow*; *mathlib*, not *warm store*; *your
  copy of the archive*, not *the local lax-database checkout*.

What that changed behind the surface:

- `follow.ts` is a progress source: it returns an outcome and reports stages
  through `onStage`/`onPreview`/`onValidationReport` instead of printing. The
  caller composes the screen, so a submit's five rows and a register's one row
  come out of the same machinery. `renderComment()` survives for the one case
  that still needs the workflow's own words: a refusal.
- `lax build`'s nineteen internal phases map to six rows, and Lean's transcript
  moved behind `--verbose` — with `echo` off a failing `lake build` folds its
  whole output into the violation, so nothing is lost. The host pipeline gained
  an `onDetail` hook so a row can settle with the answer next to it
  (`Resolved dependencies   mathlib, lax-12`).
- `lax doctor`'s twelve machine-named rows became eight author-facing ones:
  platform/node/npm/renderer collapse into `Lax` and elan/lake/toolchain into
  `Lean` while they pass, and split back out — first broken link only — the
  moment one does not. Paths leave the happy path; each registered submission
  is a row under the id the author calls it by.
- `lax serve` picks a free port when the requested one is busy (Jan's call),
  and says so once.
- `lax update` always reports `before → after`, both ends, even when the two
  are the same version: it is the one question the command exists to answer,
  and "up to date" without a number sends the author to `lax --version` to find
  out what they are running. Both halves of that had to become true first.
  The install now always asks the network what `latest` is, under three flags
  rather than one: `--prefer-online` (off by default, and what makes `@latest`
  mean the registry's latest — without it npm resolves the tag from its cached
  packument and only revalidates past the registry's max-age, so an update in
  the minutes after a release reinstalls what is already there and exits 0),
  plus `--no-prefer-offline` and `--no-offline` to override the same two
  settings turned on in the author's `~/.npmrc`. Command-line flags beat npmrc,
  so there is no configuration of npm under which `lax update` installs a
  cached version. And the `after` is read back with `npm ls -g` rather than
  taken from the registry, so it describes what npm did rather than what it was
  asked to do. (This closes the 2026-08-07 TODO item.)

Two renames and one addition, all Jan's calls in the draft's open questions:

- **`lax pull-db` → `lax sync`.** It was the last command named after the
  machinery rather than after the thing. No alias: this repo's rule is that
  every meaning has exactly one word.
- **`lax spec` → `lax print spec`**, plus a new **`lax print instructions`**
  printing `assets/instructions.md` — the guide an author hands to a coding
  agent. Both print verbatim and deliberately bypass `ui`: their reader is an
  agent, not a terminal.
- **A registered submission prints its citation key.** "Registered" and
  "citable" are the same sentence, and the citation is the payoff.

Spec touchpoints: the command list (~1135 for the database refresh, ~1153 for
`lax spec`), and anywhere the spec describes CLI output shape.
## `lax doctor` builds the warm mathlib store too (implemented, 2026-08-09)

**Supersedes the "stays a `warn`, not an install" paragraph of the entry
below**, which is the same day's work one step short. `lax doctor` now builds
the warm mathlib workspace when the machine has none, so `npm i -g lax-archive
&& lax doctor` provisions everything a build needs rather than everything but
the largest piece. The gap it closes is a setup script that exits 0 on a
machine that cannot build anything: the store was a `warn` with "the first
`lax build` builds it once" as its fix, and a cloud environment's setup script
has no first `lax build` in it.

The store is the one check that costs tens of minutes and gigabytes, so:

- It runs **last in the Lean chain**, behind the toolchain that builds it, and
  reports `building` / `sealing` on its spinner row (`ensureLocalWarm` grew an
  `onStage` callback: `lax build` still wants the prose notices, but a console
  write from underneath scribbles over doctor's live block).
- With no pinned toolchain installed it names that dependency and stops,
  rather than spending the download on a `lake` that is missing — the lake row
  above already carries the fix.
- Under `--dry` it is a ✗ with "run `lax doctor` without --dry", like the elan
  and toolchain rows. A missing store is now a gap doctor would close, so it
  fails the script check instead of passing as a note.

**A doctor that provisions changes what a test home is.** Any suite that runs
`lax doctor` against a temp `LAX_HOME` now has a store built and **sealed
read-only** inside it, which `fs.rmSync` cannot remove — the seal strips write
permission from directories, and rm needs it back to unlink their contents.
Root ignores permission bits, so this passes locally in a root container and
fails on an unprivileged CI runner with `EACCES ... rmdir .../warm/.../.lake`.
Test homes therefore either link the machine-shared warm store
(`linkSharedDirs`) or keep doctor from provisioning at all (an empty
`ELAN_HOME` plus an offline `fetch` stub, which stops the chain at its first
link — an empty `ELAN_HOME` alone does not, because doctor installs elan into
it). Cleanup goes through `removeTree` (`test/support/tmp.ts`) either way.
Verify anything touching the seal as a non-root user.

**A latent bug surfaced on the way** and is fixed in `buildWarmWorkspace`
rather than in doctor, because it was never doctor's alone: the warm build ran
a **bare `lake`** and inherited whatever PATH the caller had. Since elan is
installed with `--no-modify-path`, on a machine lax provisioned that is either
nothing (ENOENT, after a preflight that probed the *installed* binary and
passed) or another elan's shim resolving `elan default`. The build now runs
`toolchainBinDir()/lake` explicitly and composes the child's PATH with the
toolchain's bin dir first. The PATH half is load-bearing on its own: mathlib's
`cache` executable resolves **`leantar`** through it, and without it `lake exe
cache get` fails with "leantar not found in Lean sysroot" — which
`buildWarmWorkspace` reports as a network problem, sending the author off to
debug the wrong thing. `ensureValidationHost` had been masking this for the
trusted VM and the smoke by mutating `process.env.PATH` (setup.ts); `lax
build` never did, so it shared the bug.

## `lax doctor` installs elan, not just the toolchain (implemented, 2026-08-09)

spec.md (~1141) has `lax doctor` "check ... and report concrete fixes"; it
already installed the pinned toolchain and refreshed the database clone
instead of only naming them. It now also installs **elan** itself, with the
pinned bootstrap script (`ELAN_COMMIT`, the same one the trusted VM setup
runs, shared as `installElan`), into `elanHome()` and with
`--no-modify-path`. The motive is a bare container: `npm i -g lax-archive &&
lax doctor` is now the entire host setup, which is what a Claude Code cloud
environment's setup script gets to run. Without it the elan row was a ✗ with
a link, the lake row a ✗ behind it, and nothing was provisioned at all.

Two consequences worth recording:

- **PATH is no longer the resolver.** `--no-modify-path` means a
  doctor-installed elan is invisible to the user's shell, so the tool probes
  (`toolVersion`, and with it `lax build`'s preflight) look in the
  lax-owned locations first — `elanHome()/bin/elan`, `toolchainBinDir()/lake`
  — and fall back to PATH. Otherwise the preflight refused to build with the
  toolchain the CLI had just installed and was about to use, which is how
  every build path already runs them (leanenv.ts).
- **The elan that counts is `elanHome()`'s**, not any elan on PATH:
  `toolchainDir()` hangs off `elanHome()`, so an elan installed elsewhere
  owns toolchains lax never looks at. The check therefore probes that path and
  installs there when it is missing, even on a machine that has some other
  elan.

The warm mathlib workspace stayed a `warn`, not an install: it is gigabytes,
and `lax build` built it once with progress. So "full environment" here meant
elan + toolchain + database clone, and a first build still downloaded.
**Superseded the same day** — see the entry above.

**`lax doctor --dry`** is the same report with every change suppressed — the
spec's original reading of the command, kept as a flag now that the default
provisions. Five things it declines: the elan install, the toolchain install,
the warm-store build, the database clone/update (freshness is a question only a
fetch answers, and a fetch writes), and the credentials refresh behind `github
auth` (renewing
rotates the stored `ghr_` and invalidates the old one *on GitHub*, so it is a
change on both sides — `githubAppUserToken` grew a `refresh` option for it).
The background release probe in main.ts is skipped too: its cache file under
`~/.lax` would otherwise be the one write a read-only run still made. Exit
codes are unchanged, so `lax doctor --dry` is usable as a script's check.

## The run artifact carries the report; comments record the outcome (implemented, 2026-08-07)

**Partially supersedes "Result comments carry the diagnosis and a
machine-readable outcome" below**: the diagnosis moved out of the comment,
the outcome marker stayed. The validation report now reaches the author as
the Validate job's own artifact — `lax submit` downloads
`submission-validation-report-<issue>` from the run it is already following
and renders the findings with the formatter `lax build` uses locally
(`src/cli/run-artifacts.ts`, one renderer for local and remote builds), so a
failed submit ends in the terminal, with the transcripts intact, the moment
the validate job concludes and before anything is written on the issue. The
failure comment shrank to what a reader of the issue needs: one paragraph
naming the outcome and the id, saying lax-database was not changed, quoting
the first finding's `[phase/rule]` line, and linking the run. The hidden
marker protocol is untouched, so released CLIs keep their exit codes and
simply see less prose.

The deviation from the full-report comment the spec implies is deliberate,
and so is its price: **failed-build transcripts are no longer permanent.**
Run artifacts expire (retention raised from 30 days to the 90-day maximum),
and after that a failed validation is a dated outcome record with one finding
line and a run link, not a diagnosis. Accepted by Jan: the durable record is
the database, which never held failed builds anyway, and a diagnosis is worth
most in the seconds after it is produced, in the terminal that asked for it.
Reading the artifact needs the **Actions: read** user-token permission; there
is no comment-parsing fallback, and the CLI hard-errors on 403/404 naming
`lax login` and `lax submit --resume`.

**Phase order restored, not deviated.** The validate job runs fetch → static
validation → resolution as a gate (`run.js --gate`) *before* it restores the
toolchain cache and provisions the host, and `prepareValidation` orders the
same way, so both the trusted and the local pipeline now follow spec.md's
Static → Resolution → Provision sequence that the previous implementation
inverted by provisioning first. A manifest typo costs seconds instead of a
multi-GB cache restore and a warm-mathlib build. The cache-poisoning stance
is narrowed accordingly, and the workflow says so: the gate *fetches and
parses* submission bytes on the host before the cache save (git plus
in-process node, into the job dir, disjoint from the cached `~/.elan` and
`~/.lax` paths), while execution still begins only in the containers, after
the save.

**Both publisher App keys now live in the publish jobs.** The separate
Website dispatch job is gone: whichever job created the lax-database commit
mints the dispatch token and sends the rebuild in the same process, so
`lax-database-publish` becomes the one home of both keys and the
`lax-website-dispatch` environment is retired. This narrows the
credential-separation posture on purpose. The surviving invariant is trust
rule 1 — no job holding an App key ever checks out or executes submission
code — rather than mutual isolation of the two publisher keys, which bought
little once both are reachable only from reviewed workflow code inside one
protected environment, and cost a job hop plus the `archive_commit` /
`title_sync_error` output plumbing that carried state between them.

Spec touchpoints: "Validation artifacts and captures" and "Asynchronous
results" (how the report reaches the author, and what a result comment
contains), "Website dispatch" (no separate job and no `lax-website-dispatch`
environment), and the Build Pipeline phase list (now honored by the
workflow's step order — the text itself already says Static → Resolution →
Provision and needs no change).

## `lax submit -f/--force` skips all local checks (implemented, 2026-08-07)

spec.md ~1056 gives `-f`/`--force` to the dirty-worktree override. The
implementation had already renamed that override to `--allow-dirty` — the
long name says what it does, and "force" claimed too broad a word for one
narrow permission. `-f`/`--force` now means the broad thing instead:

- **`--allow-dirty`** (long form only, no short flag) is unchanged: submit
  the committed HEAD, validating it in an isolated worktree so uncommitted
  files are never mistaken for the submitted source.
- **`-f`/`--force`** skips *every* client-side check — the dirty-worktree
  refusal, the HEAD-present-on-`origin` refusal, the `lax-database` refresh,
  and the local validation build — and posts the `/lax submit` comment with
  the triple derived from the current HEAD. Only the `origin` URL is still
  required, because it is half of the triple rather than a check.

This weakens nothing: the trusted workflow re-validates every submission
from scratch and is the sole authority on admission, so the local build is a
fast-feedback convenience, not a gate. What `--force` buys is skipping
minutes of local Lean when the author wants the workflow's verdict directly;
what it costs is that an unpushed commit or a broken proof now fails a
workflow run instead of failing instantly. Submit prints a warning naming
what it skipped, so a silent absence of checks cannot read as passing ones.
`--force` is refused with `--resume` (which takes no other options) and with
the explicit source triple (which never validates locally anyway, so the
flag would be a second word for the default).

## Command naming: one word per meaning (implemented, 2026-08-06)

Every issue-protocol verb is now exactly the CLI verb that posts it, and
each meaning owns exactly one word:

- **`/lax update` → `/lax submit`.** The comment `lax submit` posts is the
  same word as the command. The issue protocol is therefore `submit`,
  `owners`, `delete`, `register` — a one-to-one map onto `lax submit`,
  `lax owners`, `lax delete`, `lax register`, with no verb appearing under
  two names on either side. Internally the publisher, its module, and the
  workflow jobs follow: `SubmitPublisher` in `src/shared/submit-publisher.ts`,
  and the `prepare-submit`/`publish-submit` jobs and entry-point modes.
  (`Publisher`'s file-scoped `plan.mode === "update"` is unrelated — it
  names a database-files-changing commit shared with delete/register — and
  keeps its name.)
- **`lax update` self-upgrades the CLI again** (spec.md ~1069), with
  `lax upgrade` kept as an alias. This restores the spec's original
  meaning and resolves that reconciliation point: the source-triple sense
  the rewrite had briefly given the word now lives in `submit`, so the
  collision that forced the retirement tombstone is gone and the tombstone
  is deleted.
- **`lax pull-db` refreshes the database clone**, superseding the earlier
  note below that renamed it `lax update-db` with `pull-db` as an alias.
  `update-db`/`update-database` are dropped outright rather than aliased —
  pre-release, nothing depends on them — so "update" means one thing.
- **`lax owners`** is the only spelling; the `set-owners` primary name is
  removed rather than kept as an alias.

The website dispatch's `client_payload.action` value changes with the
internal rename (`"update"` → `"submit"`). No compatibility shim is
needed: `lax-archive/lax-website`'s deploy workflow triggers on the
`repository_dispatch` event type `lax-db-updated` only and never reads
`client_payload.action`.

Spec touchpoints: the command list (spec.md ~1069 for `lax update`, ~1070
for the database refresh) and every occurrence of the `/lax update` issue
command.

## Local builds compile cross-submission dependencies from source (implemented, 2026-08-06)

Local `lax build` no longer downloads dependency captures from ghcr. For
every resolved cross-submission dependency, the host pipeline seeds a locked
**git** entry into the generated `lake-manifest.json` — the database
record's canonical repository URL, its full commit as the locked rev, and
the package's folder as `subDir`, i.e. exactly the triple resolution just
validated the author's declared rev-pinned require against — and plain
`lake build` clones it at that rev into `.lake/packages/` and builds it
in-workspace (verified at the pinned v4.30.0: no `lake update`, no
post_update hook, the overrides file still redirects the dependencies'
inherited mathlib to the warm store, and `LAKE_ARTIFACT_CACHE=false` stays
effective). **The trusted container path is unchanged**: captures remain
the archival and trusted mechanism, materialized read-only and verified
against the record's digests before any untrusted code runs.

Rationale: source semantics match what the author's lakefile already
declares (since the sibling-paths removal, every cross-submission edge is a
rev-pinned git require — the chain workflow in instructions.md), the
dependency builds are incremental across runs in `.lake/packages/` instead
of multi-GB re-downloads into a fresh temp dir per build, and the
security-sensitive download/verification code no longer runs on author
machines at all. Trade-offs, accepted: the first local build pays a
dependency compile (cached thereafter); a local build breaks if a
dependency's upstream repository vanishes while CI, holding the capture,
still works (the registered-repo-mirrors TODO idea would close this); and
capture-materialization bugs now surface only in the container-side tests
and the docker smoke, not in local builds.

Spec touchpoint: the local-validation paragraph (local mode "may omit only
server-only fetching, mandatory replay, and publishable artifact
creation") — dependency provisioning now *differs in mechanism* locally
(source builds) rather than being the same capture materialization; the
validated dependency graph is identical.

## Multiple statements per concept (implemented, 2026-08-06)

**Supersedes "One statement per concept" below**, which is now history. A
concept module may declare any number of axioms; every one of them is a
statement of that concept, with its own id, and each may independently be
the `conclusion` of a proof or appear in an `assumptions` set. The
`one-statement` violation kind no longer exists. Reason (rewrite.md,
"multiple statements per concept"): the bound existed for the website —
one concept, one status — and Jan has a presentation for several
statements per concept (anonymous per-statement indices in the proof
network and proof list), so the backend constraint is no longer bought by
anything. That presentation is lax-website work; nothing in this
repository presents statements.

The `type`-frontmatter consistency questions one-axiom-plan.md raised
(theorem/lemma/proposition/corollary ⇒ exactly one axiom, definition ⇒
zero) stay **deliberately punted**, per rewrite.md: `type` remains a
required key with a free prose value and nothing mechanical hangs off it.

Record schema unchanged — `statements` was always an array, and the
trusted artifact parser's cap on it (previously 1) is now just a size
bound — so no `specVersion` bump and no re-verdict machinery.

Spec touchpoint: **none, and that is the point.** The superseded entry's
amendment was never folded in: spec.md §Concept packages still reads
"The statements of a concept are the axioms whose module of origin it
is" (plural, no cardinality), which is exactly the restored rule. The
cardinality sentence that entry proposed must simply not be added.

## GitHub Actions rewrite: control plane and auth model (implemented, 2026-08-05)

This repository is the rewrite of the archive onto GitHub Actions (charter:
rewrite.md + rewrite-plan.md). Spec-relevant deviations of the new
architecture, recorded here until the spec is reconciled:

- **The archive server is gone.** GitHub issues are the control surface:
  the issue number permanently determines the id (`#42` → `lax-42`), `/lax`
  issue comments request state changes, and trusted Actions jobs publish
  them. The database is the public `lax-archive/lax-database` repository,
  written through the GitHub API with a non-forced ref update
  (compare-and-swap) instead of the spec's single-writer server lock;
  dependency captures are published as immutable GitHub Releases.
- **Auth model changed.** The CLI authenticates with a GitHub App user
  access token (`ghu_`) obtained via the App device flow; refresh tokens
  rotate in `~/.lax/credentials.json`. This supersedes the OAuth-App
  device flow + `LAX_GITHUB_TOKEN` fallback recorded in the "Go-live"
  entry below — PATs and generic OAuth tokens are now rejected, and a
  `LAX_GITHUB_TOKEN` override is intentionally unsupported
  (`LAX_GITHUB_APP_USER_TOKEN` exists for non-interactive use). App
  private keys and installation tokens exist only in trusted workflow
  jobs, never in the CLI.
- Spec touchpoints: the server/Actions sections, the auth paragraphs, and
  the single-writer/locking language. README.md documents the full trust
  model; rewrite-plan.md lists the further planned deviations (sibling
  path requires removed, multiple statements per concept, single
  validation job).

## spec.md edited by the rewrite: continuous preview (needs reconciliation, 2026-08-05)

Commit `01e4700` inserted a subsection "Continuous preview while authoring"
into this repo's spec.md (after the ~line-1026 serve/build material) —
an agent edit, contrary to the do-not-edit rule, flagged here for Jan to
bless in place or strip. Its substance, so stripping loses nothing: keep
`lax serve` running in one terminal and run `lax build` after each
completed proof in another; a successful full build atomically replaces
`build-output.json` and regenerates the preview, while failures and
`--only concepts|proofs` builds deliberately leave the preview at the last
validated milestone. The behavior is implemented and uncontroversial; only
its normative placement needs the call.

## Concept dialect: second draft, advisory model (proposed, 2026-07-29)

[spec_conceptdialect_draft.md](spec_conceptdialect_draft.md) is a proposed
replacement for spec_conceptdialect.md, written after the first real corpus
existed (nine submissions, ~4,800 lines of concept source) and revised
twice the same day after two rounds of review. Until Jan reconciles it,
spec_conceptdialect.md stands — **with the security hole of the next
bullet still open in it**. The deltas, in short:

- **The mention rule (list 8), closing a hole both drafts shared.** The
  second review found the safety argument false as written: it claimed
  code runs only where a *name in the source* selects a program, and
  closed each such position with a list of admissible syntax forms.
  `autoParam` breaks that. Its signature in the pin is
  `abbrev autoParam (α : Sort u) (tactic : Lean.Syntax) : Sort u`
  (Init/Tactics.lean, 4.30.0) — the tactic to run is a **data value**, so
  an author can apply the constant to a `Syntax` they assembled from
  ordinary inductive constructors, leave a structure field open, and have
  the elaborator run `run_tac` (hence arbitrary IO) while every node in
  the file's syntax tree is whitelisted. No tree-walk can see it;
  `Lean.reduceBool`, which makes the *kernel* run compiled code, is the
  same shape. The fix is a second axis: a rule over **resolved names** —
  no `autoParam`/`optParam`, and nothing in the `Lean` namespace or whose
  type mentions a type from it. Consequences: the door list gains the
  value-door entry, the term snapshot's generation-time exclusions gain
  name literals (three entries now), the gate gains an identifier-
  resolution check before elaborating each command plus an info-tree
  check afterwards for the spellings that need elaboration to resolve
  (dot-notation, field notation), and the schema file gains a generated
  excluded-name set beside the term snapshot. The after-the-fact half
  reads **source occurrences from the info tree, never the elaborated
  Exprs**: a concept extending a mathlib structure inherits `autoParam`
  and `Lean.Syntax` into its own types without mentioning them, so an
  Expr scan would mislabel legitimate mathematics. Deferring that half is
  sound because applying a constant to a fabricated `Syntax` runs
  nothing; only `autoParam` does, and it is a bare root-level name that
  cannot be dot-notated, so the pre-elaboration check always sees it.
  The invariant the rule actually protects is not "no `autoParam` in a
  concept" (inherited ones and the `(h : P := by simp)` field default are
  both fine) but: every tactic that runs was either chosen by pinned code
  or written out in a `by` block that passed the tactic list.
  Verified: **zero** mentions of any excluded name across the 264
  authored concept files in `~/git/lax-submissions`, so the rule costs
  the corpus nothing. Honest cost to the design: list 8 is a blacklist,
  the only one in the document — a whitelist over names is impossible —
  so its completeness is an audit, mechanized as a generated set whose
  diff is reviewed at each pin bump. The draft now says so in three
  places rather than claiming there are no blacklists.

- **Advisory, not blocking (Jan's call)**: "safe dialect" is a label, a
  moving target fixable later — every submit records an own-package
  verdict (pass/fail + dialectVersion, never a violation), *safe* is
  derived transitively (own pass ∧ all concept deps safe), the website
  displays it, and the CLI warns pre-Compile naming every closure member
  that is not safe (off-dialect concepts, foreign proof packages,
  unknowns) — nothing is ever refused. Replaces the first draft's
  admission gate, the `--allow-foreign-proofs` flag (gone;
  `--require-safe` reserved as strict opt-in), and the entire
  quarantine/verdict-voiding evolution ceremony (any schema change = one
  batch re-verification in dependency order). Anti-forgery rule: the gate
  loads dependency artifacts only when their own verdict is `pass`.
- **Tactics: closers only** (eleven one-step closers + termination
  annotations; no conv sub-language), enabled by restructuring the corpus
  instead of growing the dialect: the survey found the only real tactic
  proofs in Lax3's ScatterChoice witnesses (verification content — moves
  to the proof package; no concept references the witnesses, verified)
  and two off-dialect forms in Lax5 (`@[implicit_reducible]`,
  `deriving Language.IsRelational` — on-dialect substitutions). The
  restructure plan lives in
  `lax-submissions/plans/submission-polish.md`, "Dialect-driven
  restructures"; after it the corpus needs zero tactics in concepts.
- **Term layer becomes a literal whitelist**: the origin rule
  ("background-registered minus a ban list") is replaced by a generated,
  checked-in snapshot of every term-category syntax kind the pinned
  background registers, with the two capability exclusions (`include_str`,
  syntax quotations) applied at generation time and the snapshot *diff*
  reviewed on every pin bump. Same audit as before; the audited object is
  now an explicit file. Adds a dump mode to the gate executable.
- **Restructured** into an author-facing Part I (readable by a Lean
  non-expert, per the design goal) and a condensed enforcement Part II;
  gate mechanism, capture isolation/provenance, and the non-goals carry
  over unchanged.

## Inline math in authored prose (implemented, 2026-07-29)

Abstracts and concept/proof annotation prose render inline expressions
delimited by either `$...$` or backticks through KaTeX. Backticks are a
site-level shorthand on these author-authored surfaces only: site-owned
Markdown retains ordinary inline-code semantics, and fenced code blocks
remain code everywhere. Invalid expressions are shown verbatim with the
existing math-error treatment rather than disappearing.

Spec touchpoints: abstract Markdown rendering and the concept/proof annotation
body semantics.

## Submission deletion: `lax delete` and the `deleted` state (implemented, 2026-07-29)

spec.md's Lifecycle lists three states and five transitions, and its Actions
say the CLI has "three write actions". Authors need a way to throw away a
mistake before it is registered, so both grow by one.

- **A fourth state, `deleted`, and two transitions:** `init -> deleted` and
  `draft -> deleted`. `registered` remains terminal and immutable — deletion
  is exactly as impossible there as re-drafting.
- **`deleted` is a tombstone, not a removal.** The record folder survives
  with a `record.json` carrying `{specVersion, id, state, createdAt, owners,
  deletedAt}`: no source triple, and `build-output.json` is deleted. The
  content leaves the archive; the *id* does not come back. This is the whole
  reason the folder stays — the server allocates the next id by counting
  record folders, so removing one would hand a retired id to a different
  submission, and a citation, a store capture or an external link pointing at
  `LaxN` would silently mean something else. A tombstone also lets the
  archive explain an absence rather than 404 into nothing.
- **The delete is `POST /delete` with `{id}`**, one endpoint per write
  action as before, gated by the same allowlist and ownership rules as
  `set-owners`: the actor must be an owner, and the record must be mutable.
  Refusals are 409 for a registered record (as elsewhere) and **410 Gone**
  for one already deleted — a distinct status because "this id will never
  work again" is a different answer from "you may not do this now".
- **Every other write refuses a tombstone through the same gate.** Submit
  (single and every member of a wave), re-submit, set-owners and a second
  delete all fail with the 410 above, because they share `requireMutable`.
  A submit already in flight when its record is deleted fails at the
  trusted half's re-validation under the write lock; the drafted prefix of
  a wave stands, as it does for every other mid-wave failure.
- **The website skips deleted records entirely** — no page, no listing, no
  graph node, not counted in the statistics — keyed on the state rather
  than on the missing build-output, so a stale clone cannot resurrect a
  page.
- **A deleted dependency is named as deleted.** Resolution and the CLI's
  submit pre-flight report "was deleted … its id is retired" instead of
  their generic misses, and deliberately omit the "your database may be
  stale, try `lax update-db`" hint the other misses carry: deletion is
  monotone, so a refresh can never bring the record back. The advice to
  submit both folders together is likewise suppressed for a deleted path
  target, since no wave can resurrect a retired id.
- **Store captures of a deleted submission become garbage** and are
  collected by the ordinary sweep, since no build-output references them
  any more. One refinement was needed there: the pre-keyed-layout spare
  rule now fires only when a build-output exists but names no capture,
  rather than whenever no capture is named — a tombstone has no
  build-output at all, and its legacy entry is as dead as any other.
- **Deletion is irreversible for the content**, so the CLI treats it like
  registration: it names the drafts the deletion strands (read from the
  local database clone, the same reverse walk `lax submit` uses), then
  asks the user to type the id back; `--yes` covers scripts.

Spec touchpoints: "Lifecycle" (the state and its two transitions), "Actions"
(a fourth write action), the CLI command list, and the endpoint list under
"Archive Server". Left unedited pending manual reconciliation.

## Sibling path requires and batch submit (implemented, 2026-07-28)

Implements lax.md's "v0.2 sibling path requires" (design session and full
rationale: sibling-paths-plan.md, written 2026-07-28). A `[[require]]` with
`name`/`path` keys may now point at another submission folder of the same
repository, in both packages; `lax submit` takes several folders of one
repository and submits them as one wave. Deviations and refinements vs.
lax.md's plan text:

- **In-batch triple references are banned (H1).** Within a wave, a git
  require naming a co-member's package is a Resolution violation; sibling
  references must be path edges. Rationale: a *same-commit* triple onto a
  co-member is literally unwritable (the lakefile would have to contain the
  hash of the commit containing it), so any triple onto a co-member is an
  older-commit pin — stale by construction after the wave's commit, and it
  puts two sources for one package name into the dependent's workspace.
  Zero false positives.
- **Batch processing is sequential bottom-up commits plus an atomic
  register flip**, not an in-memory overlay: the wave runs as N ordinary
  submits committed one at a time in dependency order, so when a member
  builds, its co-members are plain database records and the existing
  machinery (trustedDepDirs, upstreamStatements, captures, sweep) needs
  zero changes. Soundness: every prefix of a topological order is a valid
  sequence of individually-admitted single submits. lax.md's "one db
  commit per wave" is therefore softened: a draft wave is one commit per
  member (`draft LaxN by <handle> (wave i/n)`); atomicity is applied where
  it genuinely matters — registration. Registering waves draft every
  member (register-strict resolution, draft commits), then one locked,
  build-free **flip** commit (`register LaxA+LaxB by <handle>`) moves all
  records to registered; any record that moved in between aborts the flip
  and the wave stays drafted (harmless, overwritable, no repins on
  retry). A failure mid-wave leaves only the drafted prefix — a state the
  archive already admits. Consequence: a registering *single* runs through
  the same loop and now commits draft-then-flip (two commits,
  init→draft→registered — both legal transitions).
- **The server is order-agnostic; the CLI topo-sorts.** The plan's rule
  (a) ("member of the same batch") collapses into rule (b) ("the target
  record's current triple is exactly this repo, this commit, that
  folder"), which is the whole server-side gate; a path edge to a
  not-yet-committed co-member simply fails rule (b) with the "list both
  folders in one `lax submit`" message. The CLI orders member folders
  dependencies-first along their path edges (light lakefile parse, Kahn),
  refuses cycles before submitting, and sends the legacy single shape for
  one folder (old-server compatible) or a `members` array for waves.
  Per-member fetches replace lax.md's "one clone" (N shallow fetches of
  one pinned commit are content-addressed and equivalent); per-member
  Compile copies are fresh and pristine — never a shared build tree, since
  an earlier member's Compile runs arbitrary author code that could
  rewrite sibling *sources*.
- **Manifest seeding flattens the closure (empirical checkpoint 1).** The
  plan preferred listing only direct requires per package and letting lake
  resolve transitively through the siblings' own seeded manifests; lake
  refuses that ("dependency … not in manifest" — it materializes every
  workspace dependency from the *root* manifest only). So each member
  package's `lake-manifest.json` carries the flattened sibling closure:
  path entries rebased relative to the package dir plus the closure's git
  requires, deduped by name. Siblings get no seeding of their own — their
  git deps clone into the requiring workspace's `.lake/packages`, their
  sources build in place as path deps (checkpoint 2 confirmed).
- **Local statement authority for path-required siblings (H2)** is the
  sibling environment itself: when Resolution filled no `upstreamStatements`
  entry (local builds — no record checks locally, by design), Inspect
  derives the sibling's concept-package inventory and runs the inspector
  over it, taking its axioms as the statement set. Self-selecting, no mode
  flag: on the server, rule (b) guarantees committed build-outputs and
  Resolution fills the map. The sibling's own layout/annotation problems
  are discarded (its build's violations, not the member's); only an
  inspector *failure* is the member's violation.
- **One unified source-map check** subsumes several plan edge cases: over
  my two packages ("root"), my git and path requires, and the closure's
  git requires and path entries, every package name must have exactly one
  source — catching a closure sibling git-pinning my name, duplicate ids
  among involved folders, conflicting pins for one name across sibling
  lakefiles, and a sibling path edge pointing back into my own root.
- **Repo-wide submission scan (H5).** A "submission folder" is a folder
  whose `git ls-files --cached --others --exclude-standard` manifest.yaml
  carries a valid Lax id (`.lake/` segments excluded; invalid/missing ids
  ignored — vendored fixtures). Nesting between two such folders and
  duplicate ids are violations, on every build inside a git repository.
  Consequence worth a doc sentence: a submission at the repository root
  excludes any second submission in that repo.
- **Realpath containment (H6)** for the member folder and every sibling
  package dir: after the lexical check, the target's realpath must equal
  the lexical resolution against the realpath'd base. This also fixes a
  pre-existing single-submit hole: `runBuildJob` resolved `folder`
  lexically and then copied *outside* the sandbox, so a hostile repo
  containing a symlink could make the copy read host files.
- **Documented consequences, unchanged behavior:** cross-owner path edges
  are effectively unusable (the actor must be in every member's owner
  set) — same-repo siblings need shared ownership, triples remain for
  cross-owner deps. The accepted draft race extends to waves: a
  co-member's later re-draft swaps its capture under dependents and can
  surface as a confusing-but-sound Replay failure on the next wave.

- **Submit pre-flight over the database clone (added 2026-07-28, after the
  first real wave).** The CLI holds the same records rule (b) consults, so
  `lax submit` now answers the two record-level questions before the
  upload: it quietly fast-forwards `~/.lax/db` and (i) refuses a wave whose
  path edge targets a folder outside it whose record is not at exactly
  (this repository, this commit, that folder) — the refusal the server
  would issue after minutes of building; (ii) warns about the reverse
  case the server never sees: draft records *outside* the wave that
  require a moved member (path or pin, read from their build-outputs) and
  are stranded at their old commit. Refusals demand a freshly pulled
  clone; when the pull fails the findings demote to warnings and the
  server stays the authority. `lax doctor` now also compares the clone's
  HEAD against the remote instead of blessing any directory.

Spec touchpoints: Packages (the path-require whitelist grows the sibling
shape), Resolution (rule (b), H1), lax submit (several folders, the wave),
Processing (per-member commits + flip), Archive Server (whole-checkout
Compile copy when path edges are present).

## Concept `type` is required (implemented, 2026-07-27)

Amends the decision recorded below ("type stays free prose-level
metadata"): the *presence* of the `type` frontmatter key is now enforced —
an "annotation" violation at Inspect, in both `lax build` and the server
pipeline — while the *value* remains free prose (no vocabulary, and still
no consistency check against the axiom count). Rationale: the website
leans on the badge as the concept's visual marker, and an "untyped"
fallback state is one more thing every legend and filter must explain;
requiring the key removes the state instead of styling it. Sitegen fails
fast on pre-gate records without a type (same posture as the
one-statement throw); the db conformance scan in TODO.md now covers both.
Spec touchpoint: the concept-annotation frontmatter table, `type` moves
from optional to required.

## One statement per concept (implemented, 2026-07-27)

A concept module declares at most one axiom: it is either a
definition-concept (zero statements, contributing vocabulary) or a
claim-concept (exactly one, and the concept *is* that claim). The
**cardinality bound is all that is enforced** — consistency between the
`type` frontmatter key and the axiom count (theorem/lemma/proposition/
corollary ⇒ exactly one, definition ⇒ zero) was proposed in the plan but
deliberately dropped on Jan's call: `type` stays free prose-level
metadata, and nothing mechanical hangs off it. Full rationale in
one-axiom-plan.md (deleted in `edf2e70`, in git history only); the
2026-07-27 survey of `~/git/lax-submissions` found all 28 existing
concept modules already conform, so there is no migration. Spec
touchpoint: Concept packages, "The statements of a concept are the
axioms whose module of origin it is" gains the cardinality (not a type
table). Record schema unchanged (`statements` stays an array, length
≤ 1); no `specVersion` bump. Enforced as an Inspect-phase violation in
both `lax build` and the server pipeline; never checked on foreign
content at resolution time, since the server enforces it at submit. The
companion website rewrite that this enables is
[`lax-website/old-logic/website-plan.md`](https://github.com/lax-archive/lax-website/blob/main/old-logic/website-plan.md).

As implemented (`src/pipeline/inspect.ts`, after the concept declaration
loop): violation kind `one-statement`, message `concept <module> declares
<n> statements (<axiom names>); a concept module declares at most one
axiom (none for a definition-concept, one for a claim-concept)`. Test
fixtures that carried several axioms per concept module (pipeline
`Lax2`/`Lax23`, edge `Lax6`) were split one-axiom-per-module rather than
exempted — they were pre-rule shorthand, not counterexamples. The db
conformance scan over live records is still open (TODO.md).

## Build-keyed store captures (implemented, 2026-07-26; survives the 2026-07-27 revert)

Introduced for the front/worker deployment split
(history/front-worker-split.md, since reverted) but **kept**: reference-then-GC is a sounder store contract than
overwrite-under-lock even on one machine, and the live store already uses
it. Original rationale follows. Submission captures
move from `store/submissions/<id>` to `store/submissions/<id>/<captureId>`
(the job id), the build-output records the `captureId`, and dependency
resolution (`trustedDepDirs`) reaches the store through it. Promotion then
happens on the worker *before* the front commits the record — safely,
because an entry the db never references is garbage (swept by the worker
past a grace age), not a record/store disagreement. Today's design instead
promotes under the db write lock to keep entry and record atomic, which
cannot span two machines. Spec touchpoint: the Archive Server's store and
"Processing" wording that ties capture promotion to the commit; the
guarantee is unchanged — the artifacts Replay checked are exactly what the
record's build-output points at — but the mechanism becomes reference-
then-GC instead of overwrite-under-lock. Re-drafts stop overwriting
in place; each build is a fresh entry.

As implemented: `BuildOutput.captureId` is optional and server-set, so
records written before this change keep resolving to the unkeyed
`store/submissions/<id>` path and no migration of the live store was
needed. The sweep (`lax-server sweep`, and every `serve` startup) deletes
capture entries no build-output references past a grace age, sparing the
unkeyed layout and anything younger than the grace window.

## Two-machine processing: the untrusted half moves off the archive (implemented 2026-07-26, **reverted 2026-07-27**)

**Reverted**: the split ran in production for one day and was retired
(history/front-worker-split.md, "The revert"); the remote executor code is deleted as of
0.1.8. No spec amendment is needed anymore — the single-server "Processing"
text is once again literally what runs. The build/submit seam the split
introduced remains in the code as an internal boundary. Original entry
kept below for the record.

Also for the split. spec.md's "Processing" describes one server that
fetches, builds, validates and commits. The pipeline and the trust chain
are unchanged, but the *machine boundary* is now part of the design and
worth stating: the front holds the database, the write lock, the
allowlist and every secret, and never executes author code; the worker
executes author code and holds nothing but a per-boot token — it receives
`(id, repository, commit, folder, register)` and answers with a build
report. Author GitHub tokens are verified on the front and never travel.
Two failure edges the spec's single-process model does not have — no
worker takes the job, the worker dies mid-build — surface as ordinary job
failures ("worker lost"), which is the same lossy-restart contract jobs
already carry. Spec touchpoint: "Archive Server"/"Processing" gain the
split as a deployment shape, with `local` (one machine) remaining
conformant.

## Write allowlist on the archive server (implemented, 2026-07-26)

spec.md's Authentication says the server verifies a GitHub token and
checks ownership. The live archive additionally gates *who may write at
all*: an operational allowlist (`ops.sqlite` on the server, deliberately
outside the public `db.git`) checked right after token verification, so
`init`, `set-owners` and `submit` refuse accounts that were not granted
access, with a message saying how to ask. Reading, cloning the database
and `lax build` are untouched. This is deployment policy rather than
protocol — a self-hosted archive can seed it open — but the refusal is
visible to clients, so it belongs in the spec's error surface.

## Go-live UX: device-flow login, doctor, update-db, register confirmation (implemented, 2026-07-26)

Deployment-simplification pass; four spec touchpoints:

- **Authentication** — *superseded: folded into spec.md on 2026-07-26*
  (CLI preamble, the new `lax login`/`lax logout` entry, Archive Server
  "Authentication", the shell-out list, and ``LAX_GITHUB_TOKEN``).
  The primary login is now `lax login`, a GitHub
  OAuth **device flow with zero scopes** — the archive learns only the
  user's identity and the `gh` CLI is not involved at all. Resolution
  chain: ``LAX_GITHUB_TOKEN`` → the token stored by `lax login`
  (``~/.lax/credentials.json``). There is deliberately no `gh auth token`
  fallback: silently borrowing a full-scope `gh` token gave the CLI
  credentials far broader than the zero-scope one it asks for, and made
  `lax doctor` report a login the user never granted lax. The server side
  is unchanged (it verifies whatever bearer
  token arrives). The OAuth app's public client id lives in
  `src/constants.ts` (empty until the app is registered — see TODO.md);
  ``LAX_GITHUB_OAUTH_URL``/``LAX_GITHUB_API_URL`` are test seams faking
  github.com.
- **`lax pull-db` renamed `lax update-db`** (spec.md ~1070) — pairs with
  `lax update`; `pull-db` stays as an alias.
- **Registration confirmation**: `lax submit --register` now prompts
  (type the submission id back) since registration is the archive's one
  irreversible action; `--yes` skips the prompt, and non-interactive use
  without it is refused. The spec's Actions section doesn't prescribe CLI
  interaction, so this is a refinement, not a deviation.
- New commands outside the spec's command list: `lax login`, `lax logout`,
  `lax doctor` (environment checks with fixes). ``~/.lax`` gains
  ``credentials.json``.

## First-run warm build: fatal `cache get`, progress notes (implemented, 2026-07-24)

Field feedback: a first `lax init` looked hung — the warm mathlib build's
long silent stretches (the clone prints no progress into a pipe, then the
chmod and hardlink passes are quiet) plus the implicit hours-long
build-mathlib-from-source fallback when `lake exe cache get` fails. Changes:

- A failed `lake exe cache get` now **fails the warm build** with a clear
  message instead of silently compiling mathlib from source; the fallback
  is opt-in via `--build-from-source` on `lax init`, `lax build`, and
  `lax-server warm`.
- The first-run notice states an expected duration, and one-line status
  markers precede each quiet phase (artifact fetch, read-only chmod pass,
  package linking).
- Client HTTP requests to the archive get a 30 s timeout (`AbortSignal`);
  every endpoint answers quickly by design (submit is polled), so a
  stalled connection now errors instead of hanging.

Spec touchpoint: the Provision paragraph's "on a fresh machine" sentence
(spec.md ~725) — the one-time warm build is no longer allowed to degrade
to a source build without an explicit flag.

## Annotations — heading-split sections and a `type` key (proposed, 2026-07-23)

Two backward-compatible extensions to the annotation format, motivated by
the website (lax.md):

- **Heading-split sections** (concepts *and* proofs): the markdown body of
  an annotation is split at top-level ATX headings (`# Name`; headings
  inside fenced code blocks don't count). A body without headings is the
  description verbatim — today's behavior. With headings, the description
  is the text before the first heading *or* a section titled `description`
  (case-insensitive); providing both non-empty is an `annotation`
  violation, as are duplicate section titles. All other sections land in
  the build output as an ordered `sections: [{title, markdown}]` list —
  the one list that keeps source order rather than being sorted, since the
  order is authorial intent (and deterministic). The website renders each
  section as its own block (e.g. `# Review notes`).
- **`type` frontmatter key** (concepts only): an optional scalar beside
  `title`, an arbitrary string (`theorem`, `definition`, …). The website
  compresses it to a 3-letter sidebar badge; it carries no semantics in
  the pipeline. Missing `type` is fine (neutral badge).

Spec touchpoints: the concept-annotation and proof-annotation format
paragraphs (frontmatter key lists, body semantics) and the build-output
determinism sentence.

## `lax init` provisions mathlib; doctor gains a submission registry (2026-08-06)

`lax init` now finishes what the scaffold starts: after writing the two
packages it ensures the shared warm store exists (building it on first use)
and seeds the same generated Lake files a build would write — the package
overrides pointing the mathlib closure at the store plus the complete locked
manifest. Rationale: an agent (or author) that runs a bare `lake build`
straight after init would otherwise clone and compile mathlib inside the
submission; the overrides must exist *before* the first lake invocation, not
after the first `lax build`. When the store cannot be built (offline), init
warns and stays valid; `lax build` retries.

Companion: `lax init` and `lax build` record every submission root they
touch in `~/.lax/submissions.json` (pruned when a manifest.yaml vanishes),
and `lax doctor` runs local-only health checks over the registry — pin
drift against pins.ts, missing/dead package overrides, hardlink-farm-era
mathlib clones under `.lake/packages`, and git-tracked generated files.
No filesystem scanning: only roots lax has touched are checked.

Spec touchpoint: the CLI init/scaffold description (init is no longer a
pure scaffold step) and the doctor command summary.

## Result comments carry the diagnosis and a machine-readable outcome (2026-08-07)

The control plane's result comment is now the author's whole report, not a
summary of one. A failed validation renders each finding with its phase and
rule, and any multi-line message — a `lake build` transcript, a kernel
replay refusal, an inspector failure — keeps its lines inside a fenced code
block (`src/shared/comment-format.ts`: control characters stripped, fences
longer than any backtick run inside them, 12 k characters per finding and
40 k per comment, over-long transcripts keeping their *tail*). The pipeline
stopped flattening violation messages to one line for the same reason. This
restores what the old archive server sent as `transcriptTail`.

Every result comment also ends with `<!-- lax-outcome:success|failure -->`.
Prose says what happened to the reader of the issue; the marker says it to
the CLI, which previously exited 0 whether the workflow published the
submission or refused it. `success` means the command did what it said;
`failure` covers refusals, failed validation, and a lax-database commit
whose Website dispatch or title synchronization did not complete.

The CLI renders comments rather than echoing their markdown
(`src/cli/render.ts`), announces the workflow run once, suppresses the
submit preview (it repeats the triple the CLI just printed), and shows the
run's *stage* — "validating: compile, kernel replay, inspection" — instead
of GitHub Actions job and step names.

Spec touchpoint: the control-plane comment protocol (the marker set) and
the CLI's submit description.
