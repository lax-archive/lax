# Lax

This repository is the issue-driven control plane and npm CLI for the Lax
archive. GitHub issues allocate submission ids, `/lax` issue comments request
state changes, and trusted GitHub Actions jobs publish those changes to the
public [`lax-archive/lax-database`](https://github.com/lax-archive/lax-database)
repository. Every successful database commit dispatches a complete rebuild to
`lax-archive/lax-website`.

The repository no longer contains an archive server, generated Website pages,
Website source, deployment units, or database records.

## Current migration boundary

The following actions are implemented by `.github/workflows/submission.yml`:

| Event or command | Result |
| --- | --- |
| New ordinary issue | Allocates `lax-<issue number>` and creates `record.json`, `build-output.json`, and `owner-list.json` stubs. |
| `/lax owners <JSON>` | Replaces the complete owner list after numeric-id authorization and GitHub identity resolution. |
| `/lax delete` | Replaces an init/draft record with a permanent three-file tombstone. |
| `/lax register` | Makes an init/draft record immutable. |
| `/lax update <JSON>` | Validates the immutable source, promotes its exact capture to immutable storage, and replaces only `record.json` and `build-output.json`. |

The Lean validation job has no App key, installation token, or Archive write
credential. Its successful workflow artifact contains `validation-report.json`,
`generated-build-output.json`, and `capture.tar`. Inside the submission-scoped
publication job, a credential-free preflight parses the exact schemas, verifies
the USTAR inventory and every digest, and re-reads authorization, lifecycle
state, issue binding, stale-write inputs, and dependency captures. Only then
may the trusted job mint the database token, publish the content-addressed
capture as an immutable `lax-database` GitHub Release, construct the
authoritative files, and commit exactly `record.json` and `build-output.json`.
It preserves `owner-list.json`, synchronizes the issue title after the commit,
and then dispatches the Website rebuild. Publishers for different submissions
may run concurrently. Each advances the shared database branch without force
and, on a concurrent advance, re-reads and revalidates the latest head before
retrying.
[spec-notes.md](spec-notes.md) remains retained unchanged as a design input.

## Trust model

The router runs with the repository-scoped `GITHUB_TOKEN`, reads a pinned
public database snapshot, and never receives Archive credentials. Only the
protected `lax-database-publish` jobs can mint short-lived Database Publisher
installation tokens restricted to `lax-database`. They re-read the latest
database head, repeat issue binding, numeric owner, state, schema, and
stale-write checks, then advance the default branch without force. A separate
post-publication job in the `lax-website-dispatch` environment can mint only a
Website Dispatcher token restricted to `lax-website`.

Configure the workflow with:

- repository variable `LAX_REPOSITORY_ID`: the immutable numeric id of
  `lax-archive/lax` (`1320232165`);
- repository variable `LAX_VALIDATION_IMAGE`: the reviewed validation runtime
  pinned as `ghcr.io/...@sha256:<digest>`;
- `lax-database-publish` environment variable `LAX_DATABASE_APP_ID` and secret
  `LAX_DATABASE_APP_PRIVATE_KEY` for the Database Publisher App;
- Database Publisher installation access only to `lax-database`, with
  repository `Contents: write` and `Administration: read` so the trusted
  publisher can verify that immutable releases remain enabled;
- `lax-website-dispatch` environment variable `LAX_WEBSITE_APP_ID` and secret
  `LAX_WEBSITE_APP_PRIVATE_KEY` for the Website Dispatcher App;
- Website Dispatcher installation access only to `lax-website`, with
  repository `Contents: write`;
- the repository Actions policy **Require actions to be pinned to a full-length
  commit SHA** enabled; and
- immutable releases enabled for `lax-database`. Publication fails closed
  before any database commit if this repository setting is disabled.

### Validation infrastructure

Issue creation and `/lax` issue comments start `submission.yml`; it is the only
issue-event entry point. Validation runs on the standard `ubuntu-latest`
GitHub-hosted runner and pulls the reviewed runtime by the immutable digest in
`LAX_VALIDATION_IMAGE`. The workflow presents Compile, Replay, and Inspect as
three first-class jobs in the Actions DAG. Short-lived, credential-free
artifacts carry the validation workspace from Compile to Replay and from Replay
to Inspect; every job cleans its local copy unconditionally afterwards. Each
phase runs on a fresh hosted runner in a fresh credential-free container. The
workflow reclaims unused hosted-runner SDK space before pulling the large
runtime image. A lightweight Validation result job keeps success and failure
handling on one linear DAG path before publication. Kernel replay
and inspection use two Lean workers inside their 16 GiB container limit so
large module sets cannot exhaust the hosted runner while the surrounding
workflow remains responsive.

`validation-runtime.yml` is intentionally not issue-triggered: it builds
trusted infrastructure only when its reviewed runtime sources change on
`main`, or when a maintainer dispatches it manually. It builds and pushes the
runtime, smoke-tests the pushed digest, and uploads `validation-image.txt`.
Only promote that exact `ghcr.io/...@sha256:<digest>` value after review.
`release-cli.yml` is similarly restricted to version tags, while CI runs for
pushes.

`lax-database` must also have an initial commit and a real default branch before
the control plane can pin a snapshot. An empty newly created repository has no
branch ref for the Git Data API to read; seed it once, then apply the default
branch protection before accepting submissions.

Use three GitHub App registrations: the CLI App for user-authorized issue
operations, the Database Publisher, and the Website Dispatcher. Protect both
credential environments so only reviewed workflow code can access their one
App private key, and protect the database default branch against force
updates.

The CLI bundles only the public client ID for the CLI App's user-authorization
flow and narrows device authorization to `lax`. Users can run `lax login`
without configuration. A user access token is distinct from the App
installation tokens and never receives the private key or the installation's
independent authority. App private keys and installation tokens must never be
distributed with the CLI.

## CLI

```sh
npm install
npm run build
npm test
npm run lax -- --help
```

The CLI creates issues and posts exact command comments; it never writes the
database directly:

```sh
lax init submission --title "My formalization"
lax build submission
lax serve submission
git commit && git push
lax submit submission
lax set-owners submission --new-list alice bob
lax register submission
lax delete submission
lax update-db
```

`lax create <title>` remains available when only issue allocation is wanted.
`lax update <issue> --repository ... --commit ... --folder ...` remains the
explicit source-triple form of `lax submit [folder]`. Submit derives the issue
from `manifest.yaml`, derives the source triple from Git, rejects dirty work
unless `--allow-dirty` is passed, and requires HEAD to be present on `origin`.
Registration stays a separate `lax register` command; multi-folder submission
is intentionally not supported yet. Before posting the issue command, submit
reuses a full local build only when it matches the clean Git commit, folder,
and current local Archive snapshot. Otherwise it runs `lax build`. With
`--allow-dirty`, the CLI validates committed `HEAD` in an isolated worktree,
so uncommitted files are never mistaken for the submitted source.

Commands that create an issue or post a `/lax` comment wait for the correlated
workflow result. Once the workflow publishes its correlated run link, the CLI
polls GitHub and displays the current Actions job and step on one loading line.
For updates, the parsed source preview and workflow run are appended to the
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
`lax upgrade`, with the revision bundled in the CLI as its safe fallback. It
starts the preview at `http://localhost:8123/` immediately with a loading page,
then renders the local
`~/.lax/lax-database` checkout plus the folder's `build-output.json` and
rebuilds when either changes. The CLI and every generated page show a warning
when the database is missing, stale, invalid, or cannot be checked. Pass
`--database-only` to omit the local folder or `--port` to choose another port.

`lax build [folder]` runs the shared submission-validation phases against the
working tree and local database clone, then writes `build-output.json`.
Server-only source fetching and artifact publication are omitted locally;
kernel replay is opt-in with `--replay`. `--only concepts` and `--only proofs`
provide partial iteration builds without replacing `build-output.json`, and
`--profile` prints phase timings. Set `LAX_VALIDATION_IMAGE` to the published
immutable `@sha256` validation image, or use `--build-from-source` to build and
cache the pinned runtime locally. Independent local findings are reported once
in a phase-grouped summary instead of as separate errors.

`lax delete` accepts an issue reference or local submission folder, refreshes
the local database to detect immutable/deleted records and stranded
dependents, and asks for a typed confirmation; scripts must pass `--yes`.
`lax update-db` also accepts the `pull-db` and `update-database` aliases and
migrates older `~/.lax/db` or `~/.lax/database` checkouts to
`~/.lax/lax-database`. `lax register` likewise requires typed confirmation
unless `--yes` is passed. `lax doctor` checks the tailored issue-workflow
toolchain, `lax spec` prints the bundled specification, and `lax upgrade`
upgrades the npm CLI before refreshing the database and Website renderer. A
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

`release-cli.yml` tests the package, fetches the Website revision pinned in
`src/cli/deployment/website-source.lock.json`, builds and bundles its
page-builder, verifies the revision and package digest, and publishes through
npm trusted publishing. No Website source is maintained here.
