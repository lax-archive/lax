# `build-output.json`: what is in it, who reads it, and the spec-2 shape

Investigation, 2026-10-03. Read-only: nothing in either tree or in the
database was changed. Inputs: `~/.lax/lax-database` at `2167023` (104
records; 78 content-bearing, 26 init/deleted stubs), lax at `ab25644`
(branch `axiomfree`), lax-website at `aa6252864f` (main). Every number
marked **measured** comes from a script over the checked-out database
(method in the appendix); everything marked **reasoned** is an inference
from code or an estimate.

Scope note from Jan (relayed mid-task): the new shape applies to spec-2
records only (the v4.35.0 environment and later). Spec-1 records keep
their shape and are eventually ported as successor records, after which
the old reader is dropped. So this report designs the spec-2 shape on its
own merits and states separately what the website loader must do to read
both shapes side by side during the transition. "Additive" is not a
requirement.

## Verdict

The files are big for one reason, and it has nothing to do with the
record's content: `capture.files`, the per-file manifest of the sealed
Lake build (46,342 entries over 78 records, mostly `proofs/*.hash`,
`.olean`, `.ilean`, `.trace`, `.c`), is **55% of all bytes** (measured),
and in records with few concepts and large proofs it is 80% of the file
(lax-503819: 7 concepts, 5 proofs, 552 KB of manifest in a 698 KB file).
Every consumer of that list already holds the tar's own digest and
verifies it before trusting anything, and the website addresses only 1,804
of the 46,342 entries by name (the concept sources and their `.ilean`
files, 0.2% of the capture's bytes) — it carries the rest only to
reconstruct ustar offsets for ranged downloads. The second largest item,
`concepts[].sourceText` (13%), is genuinely needed by the website for
every concept page and is also already in the capture tar, byte-verified
(`references.ts:57`). The parsed annotations (`description`, `sections`,
`doc`, `title`) are 100% substrings of `sourceText` (measured, 675 KB,
5%) but are the parsed form the website cannot derive without the
docstring parser, so they stay. Nothing else is heavy: the whole proof
layer is 3.5%, the paper block 0.65%, and the coming `certificate` block
with the `Challenge.lean` verbatim would add about 1% (estimated 146 KB
over today's corpus, median 0.9 KB, max 34 KB). The spec-2 shape should
therefore (1) take `capture.files` out of the record — the website's
reference material becomes a small fourth OCI layer with its digest in
the record, and the lax-side consumers verify by tar digest as they
already do — which alone cuts the corpus from 13.4 MB to ~5.9 MB (−56%)
and the largest record from 1.39 MB to ~0.59 MB; (2) store the telescope
only and derive `conclusion`/`assumptions` in readers; (3) store the
`Challenge.lean` verbatim in `certificate.challenge` with no `edges` list
and let the publisher regenerate the Challenge from the telescopes and
compare bytes, which is a stronger fail-closed check than a stored edge
list; and (4) stay with one `build-output.json` per record: the site
generator parses the whole corpus in 145 ms and 24 MB of heap (measured),
so a per-concept or index/page split buys nothing today and would cost a
publisher tree-write path and two loaders. The split that is natural is
between the record and the capture store, not within the record.

## 1. Measurements

### 1.1 Size distribution (measured)

| | bytes |
|---|---|
| `build-output.json`, all 104 records | 13,436,207 (12.8 MiB) |
| content-bearing (78) | 13,433,294 — stubs are 108–110 bytes each |
| median (over 104) | 65,194 |
| mean | 129,194 |
| max | 1,386,749 (lax-253009: 66 concepts, 170 proofs, 4,678 capture files) |
| `record.json` total / median | 25,184 / 275 |
| `owner-list.json` total / median | 12,859 / 115 |
| pretty-printing overhead (file bytes vs minified JSON) | 2.06 MB, 15% — mostly the 2-space indentation of 46k five-line capture entries |
| git repository (`.git`, 669 commits) | 7.6 MiB packed |

The five largest records:

| record | bytes | of which `capture.files` | concepts / proofs / capture files |
|---|---|---|---|
| lax-253009 | 1,386,749 | 831,694 (60%) | 66 / 170 / 4,678 |
| lax-17 | 879,518 | 602,673 (69%) | 40 / 27 / 3,380 |
| lax-503819 | 697,552 | 552,237 (79%) | 7 / 5 / ~3,100 |
| lax-916827 | 397,869 | 220,159 (55%) | 29 / 23 |
| lax-759944 | 391,324 | 292,392 (75%) | 7 / 4 |

(Capture bytes here are the minified size of the `capture` key; the
record's file bytes include indentation.)

Each record directory holds exactly the three files; there are no
per-record subfolders in the live database (the paper PDF and web bundle
live in the capture registry, not in the repository).

### 1.2 Per-field byte breakdown (measured; minified bytes, share of the 11.34 MB minified corpus)

| path | bytes | share | n | notes |
|---|---|---|---|---|
| `capture` | 7,482,581 | **55.7%** | 78 | |
| `capture.files[]` | 7,358,775 | 54.8% | 46,342 | `.sha256` 3.06 MB, `.path` 2.60 MB, `.bytes` 0.17 MB |
| `concepts` | 3,067,129 | **22.8%** | 824 | |
| `concepts[].sourceText` | 1,766,093 | 13.1% | 824 | |
| `concepts[].description` | 410,700 | 3.1% | 824 | |
| `concepts[].statements` | 391,897 | 2.9% | 808 | |
| `concepts[].statements[].signature` | 251,384 | 1.9% | 808 | median 214 B, max 2,842 B |
| `concepts[].sections` | 243,938 | 1.8% | 363 | 36 records |
| `concepts[].statements[].doc` | 50,313 | 0.4% | 486 | |
| `concepts[].title` | 34,809 | 0.3% | | |
| `concepts[].path` | 33,940 | 0.3% | | derivable from `id` (824/824) |
| `concepts[].imports` + `mathlibImports` | 48,298 | 0.4% | | |
| `concepts[].statements[].id` | 38,994 | 0.3% | | 21.6 KB of it is the concept-id prefix |
| `concepts[].statements[].startLine/endLine` | 3,384 | — | | |
| `proofs` | 471,791 | **3.5%** | 805 | |
| `proofs[].sections` | 154,612 | 1.2% | 400 | 27 records |
| `proofs[].description` | 117,561 | 0.9% | | |
| `proofs[].conclusion` | 38,797 | 0.3% | | spec 2: derivable from telescope |
| `proofs[].assumptions` | 29,238 | 0.2% | | spec 2: derivable from telescope |
| `proofs[].id` / `path` | 38,037 / 34,002 | 0.5% | | |
| `inputs` | 206,538 | **1.5%** | 78 | |
| `inputs.abstract` | 114,759 | 0.9% | | |
| `inputs.manifest.bibEntries` | 66,270 | 0.5% | 203 | |
| `inputs.manifest` (rest) | ~23 KB | 0.2% | | |
| `paper` | 87,665 | **0.65%** | 11 | |
| `paper.marks` | 75,723 | 0.6% | 416 | lax-157538 alone: 42 KB, 210 marks, 179 pages |
| `paper.pageSizes` | 3,900 | — | | |
| `paper.pdf` / `paper.web` | 2,549 / 4,331 | — | | |
| `requiredByConcepts` / `requiredByProofs` | 1,006 / 1,957 | — | | |
| `issue` | 4,403 | — | 104 | |
| `capture` scalars (digest, pins, registryBlob, sourceCommit) | ~24 KB | 0.2% | | |

Dominant contributors, in order: the capture manifest (55%), concept
source text (13%), concept annotations (5.3%: description + sections +
doc + title), statement signatures (1.9%), proof annotations (2.1%). All
the rest together is under 3%.

### 1.3 What `capture.files` lists (measured)

| entries by top dir and extension | count | manifest bytes |
|---|---|---|
| `proofs/*.hash` | 14,475 | 2,341,657 |
| `proofs/*.lean` / `.olean` / `.ilean` / `.trace` / `.c` | 4,825 each | ~775,000 each |
| `concepts/*.hash` | 2,706 | 403,217 |
| `concepts/*.lean` / `.olean` / `.trace` / `.ilean` / `.c` | 902 each | ~133,000 each |
| lake manifests, lakefiles, toolchain files | ~470 | ~63,000 |
| `paper/*` | 57 | ~7,300 |

The captures themselves total 3.44 GB (sum of `files[].bytes`; median
tar 19.7 MB, max lax-17 at 484 MB). The subset the website addresses by
name — `concepts/package/**/*.lean` and `concepts/lib/**/*.ilean` — is
5.58 MB, **0.2% of the capture bytes**, median 36 KB per record, max
499 KB (lax-253009).

### 1.4 Duplication and derivability (measured unless noted)

| held as | also held as | bytes | verdict |
|---|---|---|---|
| `concepts[].description` | substring of `sourceText` (401,664 of 401,664 bytes) | 3.1% | parsed form; keep (the website has no docstring parser) |
| `concepts[].sections[].markdown` | substring of `sourceText` (222,431 of 222,431) | 1.8% | same |
| `concepts[].statements[].doc` | substring of `sourceText` (48,956 of 48,956) | 0.4% | same |
| `concepts[].title` | substring of `sourceText` (33,158 of 34,809) | 0.3% | same |
| `concepts[].sourceText` | the capture's `concepts/package/<path>` member, byte-verified by the website (`lax-website/src/references.ts:57`) | 13.1% | keep in the record (section 3c) |
| `proofs[].conclusion`, `assumptions` | the telescope (spec 2 only; the publisher already checks the derivation, `src/submission-validation/artifact-schema.ts:659-665`) | 0.5% | derive |
| `concepts[].path` | `"concepts/" + id.replace(".", "/") + ".lean"` for 824/824 | 0.3% | harmless; keep (readers key on it) |
| `inputs.manifest.id` | top-level `id` (78/78 equal) | — | drop in spec 2 |
| `capture.leanToolchain`, `capture.mathlibCommit` | the environment row named by `inputs.manifest.leanVersion` (78/78 equal); the publisher re-derives them from the table anyway (`artifact-schema.ts:336-341`) | — | drop in spec 2 (the row now pins four libraries, `ad12a62`) |
| `paper.folder`, `paper.main`, `paper.engine` | `inputs.manifest.paper` (the publisher checks the repeat, `artifact-schema.ts:348-356`) | — | drop the repeat in spec 2 |
| `capture.files[]` | the tar's own content, authenticated by `capture.digest` | 54.8% | move out (section 4) |
| `statements[].signature` | not in `sourceText` (pretty-printed by the inspector; 0 bytes overlap) | 1.9% | keep |
| sorted copies | none: `emit.ts` sorts in place, nothing is stored twice sorted | — | |
| counts | none stored | — | |

## 2. Consumers

### 2.1 Writers

Everything in a published `build-output.json` is assembled in one place:
`src/submission-validation/phases/emit.ts:30-51` (`inputs`,
`requiredBy*` from the lakefiles' git requires, `concepts` with
`sourceText` read from disk and bounded at 4 MiB (`emit.ts:54-58`),
`proofs` with `assumptions` sorted, `capture`, `paper`). The entries come
from Inspect:

- concept `title`, `type`, `description`, `sections`, `imports`,
  `mathlibImports`: `phases/inspect.ts:114-140`;
- spec-1 statements (`id`, `signature`, `doc`, `startLine`, `endLine`):
  `inspect.ts:182-188`; spec-2 statements add `levelParams` and `body`:
  `phases/inspect-spec2.ts:221-227`;
- spec-1 proofs (`conclusion`, `assumptions`, `description`, `sections`):
  `inspect.ts:255-266`; spec-2 proofs (`levelParams`, `telescope`, and
  the derived `conclusion`/`assumptions`): `inspect-spec2.ts:169-188`;
- `capture` (`formatVersion`, `digest`, `sourceCommit`, pins, `files`):
  `captures/seal.ts:108-160`, the file walk at `seal.ts:184`;
- `paper`: `src/submission-validation/paper/` (not re-traced here; the
  shape is `contracts.ts:201-211`).

The trusted publisher adds `specVersion`, `id`, `issue`, and the
`registryBlob` addresses, then re-parses the result through the archive
schema before the CAS write (`src/shared/submit-publisher.ts:333-347`).
A metadata-only resubmission rebuilds the file from the published payload
with new `inputs` (`src/shared/metadata-publisher.ts:120-128, 178-186`).
Local `lax build` writes the same payload beside the submission
(`src/cli/build.ts:294`).

### 2.2 Field → share → written by → read by

Readers are grouped as **P** = trusted publisher / validate job
(`src/shared/`, `src/workflows/`, `src/submission-validation/archive/`),
**C** = lax CLI and admin driver, **W** = lax-website site generator (and
`lax serve`, which embeds the same renderer through its own loader,
`src/cli/website.ts:127-137` and the duplicated `rendererOutput` at
`src/cli/website.ts:1223-1238`).

| field | share | written by | read by | notes |
|---|---|---|---|---|
| `specVersion`, `id` | — | publisher `submit-publisher.ts:334-335` | P `archive-schema.ts:91-99`; C `prooftree.ts:398`, `commands.ts:941-950`; W `database.ts:214` (record.json's id, not this one) | |
| `issue` | — | publisher `:336` | P `record-gates.ts:56-57`, `control-plane.ts:321-322`, `submit-publisher.ts:260`; C `commands.ts:1074-1075`, admin `scripts/admin/plan.ts:40` | W: nobody |
| `inputs.manifest.leanVersion` | — | emit | P `submit-publisher.ts:175`; C `cli/environments.ts:100-103`, `port.ts:362-372`; W `model.ts:144`, `machine-index.ts:67` | the record's environment |
| `inputs.manifest.title`, `authors`, `bibEntries`, `anonymous`, `unlisted` | 0.3% | emit | P `submit-publisher.ts:135` (title); W `pages/submission.ts:130-133` (bib), `pages/shared.ts:802-806` (authors), `model.ts:33`, `pages/*` (anonymous/unlisted) | |
| `inputs.manifest.supersedes` | — | emit | P `archive-schema.ts:139-148`, `submit-publisher.ts:215-228`, `publisher.ts:291`; C `archive-preflight.ts:321-327`, admin `plan.ts:34`; W `machine-index.ts:62`, `model.ts:114` | |
| `inputs.manifest.id`, `specVersion`, `mathlibVersion` | — | emit | P: equality checks at parse only (`artifact-schema.ts:485-570`); W `mathlib-links.ts:76` (mathlibVersion as fallback) | **nobody reads `manifest.id` back** |
| `inputs.manifest.paper` | — | emit | P `artifact-schema.ts:348-356` (repeat check); W: no | |
| `inputs.abstract` | 0.9% | emit | W `pages/submission.ts:149, 218` | P: non-empty check only |
| `requiredByConcepts`, `requiredByProofs` | — | emit `:39-44` | P `artifact-schema.ts:156`, `submit-publisher.ts:366-370`, `publisher.ts:276`, `archive/snapshot.ts:44-48`; C `prooftree.ts:433-434, 454`, `build.ts:262`, admin `plan.ts:44`; W `model.ts:342-348` | the dependency graph; small and load-bearing everywhere |
| `concepts[].id`, `title`, `type` | 0.6% | inspect | P: ids (`snapshot.ts:66-77`, paper marks); W `model.ts:145-152`, `machine-index.ts:71-75`, graph labels `graphs.ts`, `pages/shared.ts:476` (search text) | |
| `concepts[].path` | 0.3% | inventory | C `prooftree.ts:405`; W `references.ts:52-56` | derivable from id |
| `concepts[].description`, `sections` | 4.9% | inspect `:125` | W `pages/concept.ts:99, 145`, `pages/submission.ts:434, 442`, `pages/paper.ts:133`, `pages/index.ts:468` | P: shape only |
| `concepts[].imports`, `mathlibImports` | 0.4% | inspect `:137-138` | W `model.ts:155`, `source-links.ts:123, 205, 257`, `pages/concept.ts:101-103`, `graphs.ts:96`, `pages/submission.ts:43` | P: shape only |
| `concepts[].sourceText` | **13.1%** | emit `:32` | W `pages/concept.ts:114, 133, 143`, `source-links.ts:82`, `pages/paper.ts:122-123`, `references.ts:57, 88, 175` | P: 4 MiB bound only; C: nobody |
| `concepts[].statements[].id` | 0.3% | inspect | P `submit-publisher.ts:287, 373-384`, `snapshot.ts:52-61`; C `prooftree.ts:406-408`; W `network.ts:24`, `model.ts:153` | the network's vertices |
| `statements[].signature` | 1.9% | inspect `:184` / spec2 `:226` | W `pages/submission.ts:438` → graph detail (`graph-prepare.ts:186`) | P: 64 KiB bound only |
| `statements[].doc` | 0.4% | inspect `:185` | W `pages/open-problems.ts:68, 104` | |
| `statements[].startLine`, `endLine` | — | inspect `:186-187` | W `pages/concept.ts:114` (+`:33-39`), `highlight.ts:190-197, 241-246`, `source-links.ts:94, 117` | |
| `statements[].levelParams`, `body` (spec 2) | — | inspect-spec2 `:225-227` | nobody yet (stage 5: website cards) | |
| `proofs[].id` | 0.3% | inspect | P `snapshot.ts:77`; C `prooftree.ts:412`; W `model.ts:160`, `network.ts:26`, `machine-index.ts:76` | |
| `proofs[].path` | 0.3% | inventory | W `pages/submission.ts:472` (source link) | |
| `proofs[].conclusion`, `assumptions` | 0.5% | inspect `:263-264` / spec2 `:185-186` | C `prooftree.ts:100-206, 414-415`; W `network.ts:26-37`, `model.ts:162` | spec 2: derivable from `telescope` |
| `proofs[].levelParams`, `telescope` (spec 2) | — | inspect-spec2 `:183-184` | P `artifact-schema.ts:655-666` (consistency check); nobody else yet (stage 3 generator, stage 5 cards) | |
| `proofs[].description`, `sections` | 2.1% | inspect `:265-266` | W `pages/proof.ts:44, 64`, `pages/submission.ts:297, 346, 468-469`, `graph-project.ts:168` (tooltip), `pages/paper.ts:139-140` | |
| `capture.digest`, `registryBlob` | — | seal / publisher | P `submit-publisher.ts:275-280`, `snapshot.ts:81-120`, `captures/materialize.ts:73`; C `prooftree.ts:500-501`, admin `plan.ts:50`; W `references.ts:25-26` | |
| `capture.sourceCommit` | — | seal | P `artifact-schema.ts:337`; `capture-store.ts:160` | provenance; nobody else |
| `capture.leanToolchain`, `mathlibCommit` | — | seal | P `artifact-schema.ts:338-339`, `capture-store.ts:71-72` (tag); C `prooftree.ts:400` (captureEnvironment); W `mathlib-links.ts:76` | duplicate of the row |
| `capture.formatVersion` | — | seal | P parse; W `references.ts:26` | |
| `capture.files[]` | **54.8%** | seal `:184` | P `artifact-schema.ts:741-746` (parse), `submit-publisher.ts:280` (byte-equality with the validate-time copy), `materialize.ts:161-180` (verify an extracted dependency capture **after** `:73` checked the tar digest); C `prooftree.ts:582` (same, after `:501`); W `references.ts:31-41` (shape), `:55-56` (two entries per concept by name), `:98-126` (every entry, to rebuild ustar offsets), `:67, 141` (per-member verification) | 1,804 of 46,342 entries are addressed by name; the rest serve verification that the tar digest already provides, or offset arithmetic |
| `paper.pdf.{digest,bytes,pages,registryBlob}` | — | paper phase / publisher | P `submit-publisher.ts:93`, `workflows/submission.ts:451, 708`; C `run-artifacts.ts:203-207`, `commands.ts:527`; W `database.ts:84-135`, `:233` | |
| `paper.pageSizes`, `marks` | 0.6% | paper phase | W `database.ts:96-120` (validate), paper page / viewer | C `run-artifacts.ts:207` (count) |
| `paper.web.{format,bundle}` | — | web derivation | W `paper-web.ts:80-96`, `database.ts:53-76, 236-238` (schema gate, bundle digest) | |
| `paper.folder`, `main`, `engine` | — | paper phase | W `database.ts:86-87` (string check), `pages/paper.ts:301` (engine) | **`folder`/`main` read by nobody** |

### 2.3 Flags

Read by nobody (beyond the publisher's own shape check): `inputs.manifest.id`,
`paper.folder`, `paper.main`, `capture.sourceCommit` outside the
publisher's provenance check, and — the large one — the 44,538
`capture.files` entries that name no concept source or `.ilean` (they are
walked for verification and offsets, never addressed).

Read only to derive what the writer could store: nothing significant. The
one real case is inverted — the website rebuilds the ustar layout of the
whole capture from `capture.files` (`references.ts:98-126`, thirty lines
of tar-format reimplementation) to fetch two members per concept, because
the record stores the file list rather than the members' addresses.

Stored although derivable by every reader: spec-2 `conclusion` and
`assumptions` (the draft spec keeps them "so that readers of spec-1
records read spec-2 records unchanged", `spec_v2_draft.md`
"Each entry of proofs"); the planned `certificate.edges`, which the draft
itself defines as "the same list, in the same order" as the proofs.

The three-file layout and `hashFiles('data/lax-db/*/build-output.json')`
are the cache keys of the website deploy
(`lax-website/.github/workflows/deploy-pages.yml:66, 105, 117`): any
change to any record invalidates the graph, papers, and references
caches, independently of the file's size.

## 3. Where the natural split is

How the readers load the database (measured and traced):

- **lax-website** reads every `record.json` and every `build-output.json`
  into memory in one pass (`src/database.ts:191-241`), adapts the stored
  shape to the renderer's `BuildOutput` (`:138-155`), builds a `SiteModel`
  over all outputs (`sitegen/model.ts:127-166`) and renders every page
  from it (`sitegen/generate.ts:124-140`). There is no lazy loading and no
  per-record cache; the graph cache (`.lax-graph-cache`) keys on layout
  inputs, not on records. Parsing all 104 files takes **145 ms and 24 MB
  of heap** (measured with node on this machine). The files are not a
  build-time cost at the current scale; at 100× the corpus they would be
  a 2.4 GB heap, of which 55% would be capture manifests.
- **`lax serve`** does the same through its own copy of the loader
  (`src/cli/website.ts:127-137`, `rendererOutput` at `:1223-1238`), and
  already treats the paper PDF and web bundle as sibling files of the
  local `build-output.json` (`RENDERED_FILES`, `website.ts:338`).
- **The publisher** loads one record (plus each dependency record) and
  parses `build-output.json` fail-closed and in full
  (`artifact-schema.ts:266-320`: every concept, every statement, every
  source text to its bound, every capture entry) on every submit and on
  every metadata resubmission (`metadata-publisher.ts:120`). What it
  *uses* is small: identity and `issue`, `inputs.manifest`
  (`leanVersion`, `title`, `supersedes`), `requiredBy*`, statement ids,
  `capture.digest`/`registryBlob`/pins, `paper.pdf`/`web` digests.
- **The CLI** (`prooftree`, `environments`, `port`, `archive-preflight`,
  admin) reads whole files to get ids, `leanVersion`, `requiredBy*`,
  statement ids, proof edges, and the capture digest — never the prose,
  never `sourceText`.

(a) **Per-concept / per-proof files.** Reasoned: no. The generator loads
everything at once, so 824 + 805 files instead of 78 would multiply
reads without reducing what is in memory; the publisher's CAS write
(`publisher.ts:593-597`, three named files) would become a tree write of
hundreds of blobs; the CLI readers would each need a directory walk. The
only reader that benefits from per-entry files is a client-side site,
which this is not.

(b) **Index/graph data versus page data.** The split exists in the data:
everything P and C read, plus what the website's index, graph, search
text, and network need, is `id`, `issue`, `inputs`, `requiredBy*`,
concept `{id, title, type, imports, mathlibImports, statements[].id}`,
proof `{id, conclusion/telescope}`, and the digests — about 1.3 MB of the
11.3 MB (measured: the corpus minus `capture.files`, `sourceText`,
annotations, signatures, `doc`, and `marks`). The page-only remainder is
`sourceText`, `description`, `sections`, `signature`, `doc`, `body`,
`startLine/endLine`, proof prose, and paper `marks`/`pageSizes`. But no
reader today needs one half without the other at a different time: the
website wants both in one process, and the publisher must re-parse the
page half to shape anyway (a split would only move the bound checks to a
second file). Reasoned: the split is natural but has no consumer; do not
do it now. If a client-side site or a 100× corpus arrives, it is the
first split to make, and it is additive (`build-output.json` keeps the
index half; `content.json` takes the rest).

(c) **Large verbatim artifacts.** Three candidates:
- `capture.files` (55%): belongs with the tar, not the record. The record
  needs the tar's digest and address, which it has. See section 4.
- `sourceText` (13%): already in the capture tar byte-for-byte
  (`references.ts:57` verifies it). Moving it out would make every concept
  page depend on a registry fetch at site-build time, and `lax serve`
  would lose its registry-free local preview (local builds have no tar;
  `captures/seal.ts:164-182` only describes the files). Reasoned: keep it
  in the record. It is the page's primary content, not an artifact.
- `certificate.challenge` (coming; estimated 146 KB over today's corpus,
  median 0.9 KB, max 34 KB for lax-253009's 170 edges): 1% of today's
  bytes, 2.5% after the capture manifest leaves. It is the one artifact
  the plan wants shown without fetching (`axiomfree-plan.md:173-176`).
  Reasoned: keep it verbatim in the record; it is cheaper than the
  signatures it sits beside.
- paper `marks` (0.6%, one 42 KB outlier): the viewer's data; fine where it
  is.

(d) **What the publisher must re-parse fail-closed.** Today: the whole
file, because the whole file is one JSON value with exact keys
(`artifact-schema.ts:273-281`). The *decisions* it makes rest on the
small set listed above. With `capture.files` gone, the largest thing the
publisher still parses to shape is `sourceText` (bounded per concept),
and the file it parses is 44% of today's size. One file keeps the exact-
key, stale-write, and dependency checks in one parser, which is the
property trust rule 2 wants. Reasoned: keep one file; shrink it.

## 4. Recommendation

### 4.1 The spec-2 `build-output.json`

One file per record, the three-file folder unchanged. Changes against the
`spec_v2_draft.md` "Archive Database" shape, in order of effect:

1. **Drop `capture.files` from the record.** `capture` becomes
   `{ formatVersion, digest, registryBlob, bytes, fileCount, references: { digest, registryBlob, bytes } }`:
   - lax-side consumers (`materialize.ts:161-180`, `prooftree.ts:582`,
     `submit-publisher.ts:280`) verify the whole tar by `digest` before
     they touch it, as they already do (`materialize.ts:73`,
     `prooftree.ts:501`). The per-file walk after that is a second check
     of the same bytes; the tar's own member list, read after the digest
     check, replaces `capture.files` for the "unexpected file" and
     "missing file" findings. `submit-publisher.ts:280`'s "capture
     changed after validation" becomes a digest comparison.
   - the website gets a **fourth OCI layer**, `references`
     (`application/vnd.lax.references.v1+tar`): the concept sources and
     their `.ilean` files, sealed by the same `tar --sort=name` recipe
     (`seal.ts:120-135`), pushed before the CAS write like the paper
     layers (`capture-store.ts:197-240`). Measured: 5.6 MB over the corpus,
     median 36 KB, max 499 KB per record — one plain digest-verified
     download per record replaces the ranged-read machinery
     (`references.ts:98-126, 148-187`), and `references:fetch` keeps its
     cache key. The reference sources double as the byte-equality check
     on `sourceText` (`references.ts:57`).
   - Effect (measured on today's corpus as a model): 13.4 MB → ~5.9 MB
     (−56%); lax-253009 1.39 MB → ~0.59 MB; lax-503819 0.70 MB → ~0.15 MB;
     median 65 KB → ~48 KB. The parse time and heap scale the same way.
2. **Store the telescope only.** Drop `proofs[].conclusion` and
   `assumptions`; readers derive them (`conclusion =
   telescope.conclusion.statement`, `assumptions = sorted unique
   hypothesis statements`). The publisher's consistency check
   (`artifact-schema.ts:659-665`) disappears with the fields. Three
   readers need the derivation: `lax-website/src/sitegen/network.ts:26`
   and `model.ts:162`, `src/cli/prooftree.ts:414-415`.
3. **Drop the duplicates of the environment row and of `id`:**
   `capture.leanToolchain`, `capture.mathlibCommit` (the row named by
   `inputs.manifest.leanVersion` pins four libraries now; two of them in
   the record is neither one thing nor the other), `inputs.manifest.id`,
   and the `paper.folder/main/engine` repeat of `inputs.manifest.paper`.
   `captureTag` (`capture-store.ts:66-73`) and the provenance check
   (`artifact-schema.ts:336-341`) take the pins from the row. Keep
   `capture.sourceCommit`: it is the capture's provenance, not a repeat
   of the row.
4. **Keep** `sourceText`, the parsed annotations, `signature`, `doc`,
   `startLine/endLine`, `body`, `levelParams`, `imports`,
   `mathlibImports`, `path` (concept and proof), `abstract`, `bibEntries`,
   `marks`, `pageSizes`. Each has a reader, and none is big enough to move.

### 4.2 The `certificate` block

    "certificate": {
      "judge": "lake comparator",
      "kernels": ["lean"],
      "bundle": { "formatVersion": 1, "digest": "<sha256 hex>", "registryBlob": "ghcr.io/lax-archive/lax-captures@sha256:<digest>" },
      "challenge": "import Lax42.Colorings\nimport Lax261.Myconcept\n\ntheorem Cert.Lax261Proofs.Q.{u} ..."
    }

- **No `edges` list.** The draft defines it as the proofs list in proof
  order with `Cert.` prefixed (`spec_v2_draft.md`, "The certificate
  block"); that is a rule, not data (estimated 99 KB over the corpus if
  stored). The invariant the plan's stage-3 test wants ("`certificate`
  edges and generated Challenge theorems are the same list",
  `axiomfree-plan.md:259-261`) is better enforced by the **publisher
  regenerating `Challenge.lean` from the record's telescopes, level
  parameters, ids, and imports, and requiring byte equality with
  `certificate.challenge`**. The generator is deterministic and emits
  only names escaped from `Lean.Name` (`axiomfree-plan.md:144-146`), so
  this is a credential-free check in the trusted job that binds the
  shown artifact to the stored data — a stronger property than a stored
  list that is itself derived.
- **`challenge` verbatim, in the record.** It is the reader-facing
  statement of what was certified; 1–2.5% of bytes; the website shows it
  without a fetch; and after step 1 it is far from the largest field.
  Bound it in the parser like `sourceText` (4 MiB) — the estimate says
  34 KB is the realistic maximum for 170 edges with 260 hypotheses.
- `bundle` is the digest reference of the five generated files, a further
  layer of the record's OCI manifest as the draft assumes (so a record's
  capture, paper, web bundle, references, and certificate bundle share
  one manifest and one lifetime).
- A record with no proofs: `certificate: { judge, kernels: [], challenge: "" }`
  or the key absent — pick one and have the parser hold to it; the draft's
  "edges: [] and none of the other keys" becomes "absent" once `edges` is
  gone.
- The "second attestation" the draft leaves open (more kernels later):
  with the Challenge regenerable and the bundle addressed by digest, a
  later attestation is `kernels` growing on a revalidate; the file need
  not become a list.

### 4.3 Size effect (modelled on today's corpus, measured inputs)

| | today | spec-2 shape |
|---|---|---|
| corpus | 13.4 MB | ~5.9 MB (−56%; +0.15 MB certificate included) |
| largest record (lax-253009) | 1,387 KB | ~590 KB |
| proof-heavy small record (lax-503819) | 698 KB | ~150 KB |
| median content-bearing record | 65 KB | ~48 KB |
| parse of the corpus (node) | 145 ms / 24 MB heap | ~65 ms / ~11 MB (reasoned, proportional) |

The remaining file is 30% `sourceText`, 12% parsed annotations, 4%
signatures, 2.5% certificate: content, all of it read by the website.

### 4.4 Fold into stage 3/5 now versus later

**Now (stages 3 and 5 of `axiomfree-plan.md`, spec-2 records only):**

- `contracts.ts` `BuildOutputPayload` gains a spec-2 variant without
  `capture.files`, without `conclusion`/`assumptions`, with `certificate`;
  `artifact-schema.ts` parses by `spec` as it already does for statements
  and proofs (`:295-302`); `emit.ts` emits by spec.
- `captures/seal.ts` seals the `references` layer (concept sources +
  `.ilean`) beside the capture; `capture-store.ts` pushes it as a fourth
  layer; the publisher records its digest.
- Certify writes `certificate`; the publisher regenerates the Challenge
  and compares.
- `materialize.ts` and `prooftree.ts` verify spec-2 captures by tar digest
  plus the tar's own listing (spec-1 captures keep `capture.files`).
- lax-website: the `references` layer download for spec-2 records
  (`references.ts` gains a branch; the ustar reconstruction stays for
  spec-1 until the port finishes); the loader adaptation below.

**Later (after the spec-1 → spec-2 port, when the old reader is dropped):**

- delete the spec-1 branches: `capture.files` parsing, the
  `conclusion`/`assumptions` consistency check, `references.ts:98-146`
  (ustar offsets and headers), the `rendererOutput` `value.manifest ??
  inputs?.manifest` fallback (`database.ts:141-146`, `website.ts:1226-1231`);
- the index/page split (3b) only if a consumer appears;
- unify the two copies of `rendererOutput` (lax-website `database.ts:138`
  and lax `website.ts:1223`) — they are already drifting (one validates
  `paper`, the other does not).

### 4.5 The transition: reading both shapes side by side

Key the website loader on the record's content spec, which is
`inputs.manifest.specVersion` (`spec_v2_draft.md`, "Archive Database":
"implied by its environment"; the publisher already holds the string to
the row, `artifact-schema.ts:295-297`). In `lax-website/src/database.ts`
`rendererOutput` (`:138-155`) and its copy in `src/cli/website.ts:1223`:

- spec 1: pass through as today (`capture.files` present, `conclusion`
  and `assumptions` stored);
- spec 2: derive `conclusion` and `assumptions` from `telescope` into the
  same in-memory `BuildOutput`; set `capture.files = undefined` and carry
  `capture.references`; attach `certificate` as a new optional field of
  `BuildOutput` (`types.ts:166-179`).

`SiteModel`, `computeNetwork`, and every page then run unchanged on the
adapted model; the only other spec-aware code is `references.ts` (which
layer to fetch and how to verify) and the two new page elements of stage
5 (telescope on proof cards, the certified mark with the collapsed
Challenge). `lax prooftree`'s `loadArchive` (`prooftree.ts:397-437`)
needs the same two-branch adaptation, since it mixes records of both
specs in one archive map. The `hashFiles` cache keys in
`deploy-pages.yml` keep working because the file name does not change.

## Appendix: method

Measured figures come from Python over `~/.lax/lax-database/lax-*/build-output.json`:
per-path byte totals are `len(json.dumps(value))` of each JSON path
(minified; the file sizes quoted in 1.1 are on-disk bytes with
indentation); duplication was tested as substring containment of each
annotation field in its concept's `sourceText`; derivability of
`concepts[].path` by string equality with the id-derived path; the
Challenge estimate as `import <module>` per distinct statement module
plus one `theorem Cert.<proof> (h₀ : A₀) … : C := sorry` line per proof
with the record's own assumption lists. Parse time and heap are from one
`node -e` run that reads and `JSON.parse`s all 104 files. Reader and
writer citations are from `grep -rn` over `src/` of both repositories at
the commits named at the top, verified by reading the cited lines.
