# Lax

This repository is the issue-driven control plane and npm CLI for the Lax
archive. GitHub issues allocate submission ids, `/lax` issue comments request
state changes, and trusted GitHub Actions jobs publish those changes to the
public [`lax-archive/lax-database`](https://github.com/lax-archive/lax-database)
repository. Every successful database commit dispatches a complete rebuild to
`lax-archive/lax-website`.

The repository no longer contains an archive server, generated Website pages,
Website source, deployment units, or database records.

## Control plane

The following actions are implemented by `.github/workflows/submission.yml`:

| Event or command | Result |
| --- | --- |
| New ordinary issue | Allocates `lax-<issue number>` and creates `record.json`, `build-output.json`, and `owner-list.json` stubs. |
| `/lax owners <JSON>` | Replaces the complete owner list after numeric-id authorization and GitHub identity resolution. |
| `/lax delete` | Replaces an init/draft record with a permanent three-file tombstone. |
| `/lax register` | Makes an init/draft record immutable. |
| `/lax submit <JSON>` | Validates the immutable source, promotes its exact capture to digest-addressed ghcr storage, and replaces only `record.json` and `build-output.json`. |

**Versioning.** A new version of a registered submission is an ordinary new
submission whose `manifest.yaml` carries the optional `supersedes: lax-N`
key. The claim binds when the new submission registers: the target must be
registered, the authenticated user submitting or registering the successor
must be one of the target's frozen owners, and each submission has at most one
successor (first to register wins; competing drafts merely race). The superseded
record itself is never modified — the
website derives the version chain from the successors' build outputs and
nudges readers to the latest version. Fresh ids keep both versions usable in
one dependency graph and keep old citations meaningful. Details and accepted
limitations: spec-notes.md, "Versioning: `supersedes` successor chains".

The Lean validation job has no App key, installation token, or Archive write
credential. Artifacts are its only egress: `validation-report.json` alone,
which the author's CLI downloads to print the findings, and beside it the
publication artifact with `validation-report.json`,
`generated-build-output.json`, and `capture.tar`. Inside the submission-scoped
publication job, a credential-free preflight parses the exact schemas, verifies
the capture digest, and re-reads authorization, lifecycle state, issue
binding, stale-write inputs, and dependency captures. Only then may the
trusted job mint the database and Website tokens, push the digest-addressed
capture to `ghcr.io/<owner>/lax-captures`, construct the
authoritative files, and commit exactly `record.json` and `build-output.json`.
It preserves `owner-list.json`, synchronizes the issue title after the commit,
and dispatches the Website rebuild itself — the job that owns the commit is
the job that requests the rebuild. Publishers for different submissions
may run concurrently. Each advances the shared database branch without force
and, on a concurrent advance, re-reads and revalidates the latest head before
retrying.

## Trust model

The router runs with the repository-scoped `GITHUB_TOKEN`, reads a pinned
public database snapshot, and never receives Archive credentials. Only the
protected `lax-database-publish` jobs can mint short-lived Database Publisher
installation tokens restricted to `lax-database`. They re-read the latest
database head, repeat issue binding, numeric owner, state, schema, and
stale-write checks, then advance the default branch without force. The same
jobs mint the Website Dispatcher token, restricted to `lax-website`, after the
commit they own: both publisher keys live in `lax-database-publish`, and the
invariant that governs them is that no job holding an App key ever checks out
or executes submission code.

Configure the workflow with:

- repository variable `LAX_REPOSITORY_ID`: the immutable numeric id of
  `lax-archive/lax` (`1320232165`);
- `lax-database-publish` environment variable `LAX_DATABASE_APP_ID` and secret
  `LAX_DATABASE_APP_PRIVATE_KEY` for the Database Publisher App;
- Database Publisher installation access only to `lax-database`, with
  repository `Contents: write`;
- `lax-database-publish` environment variable `LAX_WEBSITE_APP_ID` and secret
  `LAX_WEBSITE_APP_PRIVATE_KEY` for the Website Dispatcher App;
- Website Dispatcher installation access only to `lax-website`, with
  repository `Contents: write`;
- the repository Actions policy **Require actions to be pinned to a full-length
  commit SHA** enabled.

Dependency captures are OCI artifacts on ghcr. Their tags are mutable and
only aid discoverability; integrity comes from consumers fetching each blob
by the sha256 digest recorded in the dependency's `build-output.json` and
verifying the bytes, so no repository setting is load-bearing for them.

### Validation infrastructure

Issue creation and `/lax` issue comments start `submission.yml`; it is the only
issue-event entry point. Validation runs on the standard `ubuntu-latest`
GitHub-hosted runner. The sandbox is a *stock* image pinned by digest in
`src/submission-validation/pins.ts` — no custom image, no registry login; the
runner installs the pinned elan/toolchain and warm mathlib workspace on the VM
(`host/setup.ts`, the same code local `lax build` uses) and every container
gets them bind-mounted read-only. A declared paper compiles in a second
digest-pinned image — a full TeX Live, `PAPER_IMAGE` in the same pins module,
pulled on demand only for paper-bearing submissions, with none of the Lean
mounts — and the paper's derived web view is produced by the ReflowTeX fork
pinned there too (`REFLOWTEX_URL`/`REFLOWTEX_REV`; `npm run reflowtex:fetch`
obtains it, applies the patches in `reflowtex/patches/`, and installs the
hash-pinned encode environment). The success path is three jobs — `route`,
`Validate`, `publish-submit` — with `report-validation-failure` and
`report-workflow-failure` covering the failure cases; publication is gated on
the validate job's own result, since it exits non-zero unless the report is
ok. Validation is one read-only `Validate` job: source fetching, static
validation, and dependency resolution run first as a gate, so a manifest typo
fails in seconds instead of after a multi-GB cache restore, and Compile,
Replay, and Inspect then run sequentially through one container runner, each
phase in a fresh credential-free container. The toolchain cache is saved
*before* any untrusted code runs so a hostile submission can never poison it;
the gate only fetches and parses submission bytes, into the job directory,
and execution begins only in the containers after the save. No disk reclaim
runs before the toolchain and
warm-store installation: a hosted runner reports ~88 GB free, which is ample.
Kernel replay and inspection use two Lean workers inside their 16 GiB
container limit so large module sets cannot exhaust the hosted runner while
the surrounding workflow remains responsive.

`release.yml` is restricted to version tags, while CI runs for pushes.

`lax-database` must also have an initial commit and a real default branch before
the control plane can pin a snapshot. An empty newly created repository has no
branch ref for the Git Data API to read; seed it once, then apply the default
branch protection before accepting submissions.

Use three GitHub App registrations: the CLI App for user-authorized issue
operations, the Database Publisher, and the Website Dispatcher. Protect the
`lax-database-publish` environment so only reviewed workflow code can access
the two publisher private keys it holds, and protect the database default
branch against force updates.

The CLI bundles only the public client ID for the CLI App's user-authorization
flow and narrows device authorization to `lax`. Users can run `lax login`
without configuration. A user access token is distinct from the App
installation tokens and never receives the private key or the installation's
independent authority. App private keys and installation tokens must never be
distributed with the CLI.

### Empirical notes on the pinned toolchain

Two behaviors of the pinned toolchain (v4.30.0), discovered while
implementing the inspector and worth knowing when reading the spec:

- Lean strips a leading line of dashes from *persisted* docstrings, so the
  authored opening `---` fence of an annotation never reaches the olean. The
  inspector therefore recognizes frontmatter as grammar lines followed by a
  closing `---` line. Consequence: a docstring like `note: text\n---\nmore`
  is indistinguishable from frontmatter and will be parsed as such (loudly —
  unknown keys are build errors, never guesses).
- Statement signatures are pretty-printed with core notation only, and since
  notation unexpanders are imported code (which the inspector never runs),
  they render in application form (`Eq 0 0`, not `0 = 0`). The spec records
  the upgrade path (an explicitly untrusted display pass).

## CLI

Install the released CLI from npm, or run it from source:

```sh
npm install -g lax-archive   # released CLI: `lax --help`

npm install                  # from source:
npm run build
npm test
npm run lax -- --help
```

The CLI creates issues and posts exact command comments; it never writes the
database directly:

```sh
lax init submission
lax build submission
lax serve submission
git commit && git push
lax submit submission
lax owners submission --new-list alice bob
lax register submission
lax delete submission
lax sync
```

Everything a command prints is one report, not a log. A slow command opens with
a title, spins a declared step row per stage, and closes with a bold one-line
verdict; a fast one prints only the verdict. Notes come last, in one block, each
with its fix on the line under it. Run ids, comment URLs, archive commits,
dispatch outcomes, `build-output.json`, the words *lax-database* and *control
plane* — none of it reaches the happy path, and all of it is one `-v` /
`--verbose` away, because that is exactly what a bug report needs. Colour is one
accent and one dim (`✓` green, `!` yellow, `✗` red), suppressed by `NO_COLOR`,
`--no-color`, or a pipe. Without a TTY the spinner is gone and each settled row
prints once — same words, still complete, which is what agents driving the CLI
read. Elapsed time appears on anything over three seconds, so four silent
minutes read as work rather than as a hang.

`lax submit <issue|folder> --repository ... --commit ... --folder ...` is the
explicit source-triple form of `lax submit [folder]`. Every issue-protocol verb
is the CLI verb that posts it — `submit`, `owners`, `delete`, `register` — and
each meaning has exactly one word, so `lax update` is once again only the CLI
self-upgrade (`lax upgrade` remains as an alias) and the database refresh is
`lax sync` — the last command named after the machinery rather than after the
thing. Submit derives the issue from `manifest.yaml`, derives the source triple from
Git, rejects dirty work unless `--allow-dirty` is passed, and requires HEAD to
be present on `origin`. Source repositories must be anonymously fetchable over
HTTPS from GitHub, GitLab.com, Codeberg, or Bitbucket Cloud. The CLI normalizes
the providers' standard SSH clone URLs, strips a trailing `.git`, and supports
nested GitLab groups; the Lax account and issue workflow remain on GitHub
regardless of where the source is hosted. Registration stays a separate `lax
register` command;
multi-folder submission is intentionally not supported yet. Before posting the
issue command, submit reuses a full local build only when it matches the clean
Git commit, folder, and current local Archive snapshot. Otherwise it runs
`lax build`. With `--allow-dirty`, the CLI validates committed `HEAD` in an
isolated worktree, so uncommitted files are never mistaken for the submitted
source. `lax submit -f` / `--force` skips all of it — the dirty check, the
pushed-`HEAD` check, and the validation build — and posts the issue command
straight away; the trusted workflow is then the only thing that validates the
submission, so an unpushed commit fails there instead of here.

`lax init --offline` sets a folder up without reserving anything: it signs in
to nothing, opens no issue, and scaffolds under the placeholder id `lax-0`
(packages `Lax0` and `Lax0Proofs`). GitHub numbers issues from 1, so no record
can ever carry that id. `lax build`, `lax serve` and `lax doctor` work with it
unchanged; `lax submit`, `lax register`, `lax owners` and `lax delete` refuse
it, because there is no issue to post to. Moving such a folder to the archive
means `lax init` in a fresh one and carrying the sources across — the id is
part of every package name, import and namespace.

`lax submit --resume` reattaches to an interrupted submit. The durable job
record is the Actions run, correlated to the originating `/lax submit` comment
by hidden markers, so resume re-derives both from the issue's own comments —
nothing is stored locally, which is what makes it work even when the CLI died
before it learned whether its comment had posted. Any transport failure during
submit prints that exact recovery command.

Commands that create an issue or post a `/lax` comment wait for the correlated
workflow result. Once the workflow publishes its correlated run link, the CLI
polls GitHub and shows the run's current stage as the detail on its own step
row (the run id and its URL are `--verbose` internals). For
submits, it downloads that run's `validation-report.json` artifact as soon as
the Validate job concludes and prints the findings with the same renderer
`lax build` uses locally — a failed validation therefore ends the command in
the terminal, with transcripts, before the workflow's record comment lands.
Reading the artifact needs the `Actions: read` user-token permission; without
it the CLI stops and asks for `lax login` rather than falling back to comment
text. The issue comment on a failed validation is a short record: the outcome,
the first finding's line, and the run link.
The parsed source preview and workflow run are appended to the
originating command comment instead of creating a separate preview comment. A
🚀 reaction marks validation and publication in progress; it becomes 👍 after
full success, while the final workflow result comment remains in place.
Owner-list changes create no result comment: the workflow reacts with 🚀 while
the command is running, then replaces it with 👍 after full success. The CLI
treats the bot-authored 👍 as the correlated successful result.
Set `LAX_POLL_INTERVAL_MS` or
`LAX_WORKFLOW_TIMEOUT_MS` to override the 3-second poll interval or 6-hour
timeout.

`lax serve [folder]` uses the current `lax-website` page-builder downloaded by
`lax update`. If none has been downloaded yet, the first preview downloads it;
if that fails, the revision bundled in the CLI remains the safe fallback. The
preview starts at `http://localhost:8123/` immediately with a loading page, then
renders the local
`~/.lax/lax-database` checkout plus the folder's `build-output.json` and
rebuilds when either changes. The CLI and every generated page show a warning
when the database is missing, stale, invalid, or cannot be checked. Pass
`--database-only` to omit the local folder or `--port` to choose another port.
Paper surfaces ride along: the local folder's own `paper.pdf` and
`paper-web.tar` are handed to the renderer directly, and a database record's
recorded blobs resolve through `~/.lax/papers/<digest>.pdf` and
`~/.lax/bundles/<digest>.tar` — filled on demand by the same anonymous,
digest-verified ghcr download the capture consumers use, degrading offline to
the page without that surface rather than blocking the preview.

`lax build [folder]` runs the shared submission-validation phases against the
working tree and local database clone, then writes `build-output.json`. It
needs `git` plus the host Lean toolchain — elan under `~/.elan` and the pinned
toolchain's `lake` under it, either on PATH or wherever `lax doctor` installed
them — no docker; containers are a CI-only concern.
`lake build` runs **in place** in the submission's own `concepts/`
and `proofs/` directories, so `.lake` persists between runs and rebuilds are
incremental, and its transcript streams live to the terminal. On first use the
CLI builds the shared warm mathlib workspace under `~/.lax/warm` (downloads
gigabytes, once per machine and pin; `--build-from-source` compiles mathlib
locally when its prebuilt artifact cache cannot be fetched). Server-only
source fetching and artifact publication are omitted locally; kernel replay
(the host toolchain's `leanchecker`) is opt-in with `--replay`. `--only
concepts` and `--only proofs` provide partial iteration builds without
replacing `build-output.json`, and `--profile` prints the nested span tree of
every phase. The trusted workflow collects the same tree without being asked:
each validation job writes its spans to `validation-profile.json` beside the
validation report, uploads it with the run's artifacts, and echoes it into the
job's step summary. The profile is diagnostics only; nothing that
authenticates a publication reads it. Independent local findings are reported
once in a phase-grouped summary instead of as separate errors.

A submission may declare a paper (`paper:` in `manifest.yaml` — folder,
entry file, engine) whose `.tex` files mark passages with `% lax begin <id>`
/ `% lax end` comments naming a concept, a proof, or a submission. `lax
build` copies the folder into the job directory, rewrites the markers into
`\laxmark` calls, compiles with the host `latexmk` and the shipped
`assets/tex/laxmark.sty` (injected through `-usepretex`, never touching the
author's files), reads the resulting PDF named destinations back with
pdf.js, checks that every marker left exactly one begin and one end,
resolves the ids against the inspected concepts and proofs and the directly
required packages' records, and records the result under `paper` in
`build-output.json` — the PDF's digest, size, and page count, the page
sizes, and every mark's begin and end point (page, PDF coordinates, TeX
mode). The PDF itself is written to `paper.pdf` beside `build-output.json`,
bound by the digest. The paper compiles beside the Lean chain and closes
its own row; with no `latexmk` (4.77 or later) on the machine the row is a
note and `paper` is omitted. The archive runs the same phases in its pinned
TeX Live image, stores the PDF as a second layer of the submission's
capture manifest on ghcr, and additionally derives a reflowable web view of
the same sources (ReflowTeX, injected via `assets/tex/laxreflow.sty` under
lualatex, cross-checked against the PDF's text) as a third layer — never
blocking: a derivation failure is a warning with the reason in the submit
report, and `paper.web: false` in the manifest opts out. The website's
paper page shows both surfaces — the reflow rendering at the reader's
width, and the as-printed PDF behind a toggle — with a card for every
marked passage. The author-facing contract is in `instructions.md`, the
proposed spec amendment in spec-notes.md (2026-09-02); the design records
are `paper-plan.md` and `paper-web-plan.md` (all code stages are
implemented; the rehearsal, renderer release, and production round trips
are pending — see TODO.md).

`lax delete` accepts an issue reference or local submission folder, refreshes
the local database to detect immutable/deleted records and stranded
dependents, and asks for a typed confirmation; scripts must pass `--yes`.
`lax sync` migrates older `~/.lax/db` or `~/.lax/database` checkouts to
`~/.lax/lax-database`. `lax register` likewise requires typed confirmation
unless `--yes` is passed. `lax doctor` checks the tailored issue-workflow
toolchain, running every check concurrently and spinning on a line per check
until it answers; it also provisions what it can, installing elan and
the pinned Lean toolchain when they are missing and bringing the local
`lax-database` checkout up to date rather than only reporting that they are
stale. On a bare machine `npm i -g lax-archive && lax doctor` is therefore the
whole setup: elan (the pinned bootstrap installer, into `~/.elan`, without
touching your shell profile), the pinned toolchain under it, the warm mathlib
workspace under `~/.lax/warm`, and the database clone. The store is the one
check that can run for tens of minutes and download gigabytes, so it comes
last, behind the toolchain that builds it, and says on its own line whether it
is building or sealing. A `LaTeX` row reports `latexmk` and the TeX
engines, as a fact when absent — only a submission with a paper needs them,
and the archive compiles papers itself — and as a note with the install
hint once a registered submission on the machine declares a paper; doctor
never installs TeX. `lax doctor --dry` is the
same report with none of that: it installs nothing, refreshes neither the
database clone nor the login, writes nothing at all, and names each gap it
declined to close. It still exits 1 on a ✗, so it works as a check in a script. `lax print spec`
prints the bundled specification and `lax print instructions` the guide an
author hands to a coding agent — both verbatim, because their reader is an agent
rather than a terminal. `lax update` upgrades the npm CLI before refreshing
the database and Website renderer. A
best-effort background check reports newer CLI releases without delaying
commands.

`lax login` uses the GitHub App device flow and accepts only the resulting
`ghu_` GitHub App user access token. Expiring tokens are refreshed with the
rotating `ghr_` refresh token stored in `~/.lax/credentials.json`. Generic
OAuth tokens and personal access tokens are rejected. For non-interactive use,
`LAX_GITHUB_APP_USER_TOKEN` may provide an existing `ghu_` token; the generic
`LAX_GITHUB_TOKEN` override is intentionally unsupported. Device authorization
is requested for the numeric `lax-archive/lax` repository id. `lax logout`
submits both stored tokens to GitHub's credential-revocation endpoint and only
removes the local credentials after GitHub accepts the revocation.

## CLI release

`release.yml` tests the package, fetches the Website revision pinned in
`src/cli/deployment/website-source.lock.json`, builds and bundles its
page-builder, verifies the revision and bundle digest, and publishes through
npm trusted publishing. No Website source is maintained here. The packaging
step writes a deterministic `THIRD-PARTY-NOTICES.txt` into the vendored tree
and refuses to package vendored code whose license text is missing;
verification re-derives and re-checks it — the vendored pdf.js and the AGPL
ReflowTeX viewer ride the Apache-labelled npm tarball as aggregation with
notices, and the viewer's source is served unminified by the site itself.
