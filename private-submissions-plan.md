# Private submissions — plan

Status: designed 2026-09-14 (Jan and an agent session). Version 2 of the
same day: the first draft was stress-tested by four independent reviews —
security red team, codebase fit, GitHub platform facts, author and
reviewer usability plus a devil's advocate — and this text folds their
findings in. The section "What the reviews changed" at the end records
what moved and why, and the alternatives the plan chose against. Nothing
is implemented. The platform facts marked *verify* are assumptions until
the stage-0 spike confirms them; each has a named fallback.

## The problem

Conference peer review needs a draft that only its reviewers can read.
Every surface of the archive is public by construction: the database
repository, the source it points at, the captures on ghcr, the Actions
logs and artifacts of the control plane, and the website. A formalization
under review therefore has no home in the archive today, and an author
who wants reviewers to see it ships a zip.

What a reviewer needs is the submission's website pages — concept cards,
statements with their proven and unproven marks, the proof list, the paper
with its marked passages — behind a passcode, produced by the archive's
own validation so the verdict carries the archive's trust and not the
author's word. What the author needs is to get there without granting the
archive access to a private repository, without the archive running a
server, and from a plain folder if that is where the work lives.

## Decisions

The one-way doors. Everything else follows from them and can be revised.

1. **A second instance, not a second backend.** Private validation runs
   the unchanged pipeline (`src/submission-validation/`, the same
   publisher, the same page-builder) as a second *deployment* of the code
   in the open repository. All logic stays in `lax-archive/lax`. The
   constants module already parameterizes control, database, website,
   captures and site URL by environment variable, and `scripts/rehearsal/`
   already stands up a whole instance that way. The private instance is
   that shape made permanent.
2. **Execution in one closed repository, because GitHub's privacy unit
   is the repository.** Logs, artifacts, caches and step summaries
   inherit the repository's visibility, and every one of them carries
   plaintext during a validation. The closed repository
   (`lax-archive/lax-review`) holds a short workflow that checks out `lax`
   at a pinned commit, the protected environments with the keys, and
   nothing else. Validating inside the open repository would mean muting
   every transcript, encrypting every artifact and suppressing every
   annotation — deny-by-enumeration, the defect class
   `history/audit-20260903.md` names — with the decryption key in a job
   that executes submission code, which trust rule 1 forbids.
3. **Lax never reads the author's repository.** No GitHub App on author
   repositories. Transport is a tar the CLI packs from any folder,
   encrypted to a lax review public key, deposited where a lax job fetches
   it anonymously. Git and plain folders are the same case.
4. **The public control repository is the only author-facing input.**
   Commands are sealed comments on public issues in `lax-archive/lax`.
   Authors never see, join or touch the closed repository, so there is no
   collaborator management and nothing one author can read of another's.
5. **Results and pages come from one static, public, encrypted place.**
   The private instance publishes each review's encrypted bundle, its
   encrypted report and a small outcome file to a public repository that
   is itself a GitHub Pages site on its own origin, `review.laxarchive.org`.
   The CLI polls that outcome file; the reviewer opens that URL. No
   result is ever posted back to the public issue, so the private instance
   needs no token for `lax-archive/lax` at all, and the CLI needs no reply
   key. The author chooses the URL token and the passcode locally, once
   per record, and sends them inside the sealed command; links survive
   resubmits.
6. **Confidentiality of content, not anonymity of authorship.** Source,
   pages, report and passcode are never public in the clear. The
   *existence* of a review is public: the author's GitHub account opened
   an issue with a review marker and posted sealed comments on it at
   visible times, and the outcome file appears at a visible time. Hidden
   HTML markers are indexed by GitHub issue search, so anyone can list
   every review issue and its opener with one query. The plan does not
   promise double-blind and says so to authors; the mitigation it offers
   is a throwaway account, and the submission id never appears in public
   until promotion, so the pages do not lead to the issue.
7. **Same id space, same schemas, no visibility field.** A review record
   uses the id `lax init` generated locally and the public record shapes
   with one documented extension (`sealedSource`). It lives in the review
   database or, after promotion, in the public one, and no record anywhere
   says which. The public archive, its database, its website build and its
   schema learn nothing about review records.
8. **Promotion is the ordinary public submit.** An accepted paper goes
   public by pushing the plaintext source to a public repository and
   running `lax submit` with the same id. The first public submit already
   checks the id is unused and binds a fresh issue; the review record then
   expires. For a plain-folder author that is a real sequence of steps
   (below) and the plan documents it rather than waving at it.
9. **The reviewer surface is the existing site, encrypted at rest.** The
   review pages are rendered by the private instance with the page-builder
   `lax serve` uses, encrypted under the passcode, and served as static
   files with a client-side decrypting loader and a service worker. GitHub
   Pages cannot be private below Enterprise Cloud, and the archive runs no
   server.
10. **Review records may require public records; nothing may require a
    review record.** Resolution runs against the public snapshot as today.
    A review record's source is ciphertext, so no lakefile can pin it, and
    the rule needs no enforcement code. It also means the validate job
    never needs the private package: public dependency captures come from
    the public package, anonymously, as today.

## The path

```
author machine       lax-archive/lax (public)     lax-archive/lax-review (closed)             lax-review-pages (public, its own Pages site)
──────────────       ────────────────────────     ───────────────────────────────             ────────────────────────────────────────────
lax review submit ─▶ issue + sealed comment ─▶ route ─▶ dispatch ─▶ fetch ─▶ unseal ─▶ validate ─▶ publish ─▶ push data files ─▶ deploy ─▶ review.laxarchive.org/<token>/
        │                                                                                                             ▲
        └──────────────────────────── polls <token>/outcome.json ─────────────────────────────────────────────────────┘
```

1. **CLI.** `lax review submit [folder]` runs the local build unless
   `-f`, packs the folder into a deterministic tar, encrypts it under a
   fresh content key, uploads the ciphertext to a secret gist in the
   author's account, and posts a sealed command on the folder's review
   issue (created on first use). The command names the gist commit, the
   plaintext digest, the content key, and the record's token and
   passcode, which the CLI generated on first use and keeps in
   `~/.lax/review/<id>.json` and in the folder's gitignored
   `.lax-review.json`.
2. **Public route job.** Checks the envelope as `precheck` and `route`
   already do — a human commenter, the review marker, byte limits — then
   applies the abuse caps (below) from public data and dispatches to the
   closed repository, carrying only the issue number and comment id.
3. **Fetch job (closed repository, credential-free, executes
   nothing).** Re-reads the issue and comment through the API as data
   (trust rule 2), checks that the commenter is the issue's opener or a
   co-owner the opener named (below), fetches the gist commit with the
   existing hardened fetcher, checks the ciphertext against the digest in
   the plaintext envelope, and uploads the ciphertext as an artifact.
4. **Unseal job (closed repository, holds the review private key,
   executes nothing, parses nothing hostile).** Opens the sealed command,
   checks its bindings against the issue and commenter it was re-read
   from, unwraps the content key, streams the ciphertext artifact through
   AES-GCM to a plaintext tar, checks the plaintext digest, and uploads
   the tar as an artifact. It never untars.
5. **Validate job (closed repository, no permissions at all).** Extracts
   the tar with the hardened extractor the capture materializer already
   has — rejects `..`, absolute paths, links, devices and duplicates, and
   enforces the file and byte caps during extraction — into the job
   directory where a checkout would be, and runs the unchanged pipeline
   through the existing on-disk seam. Cache restore only, never save.
6. **Publish job (closed repository, protected environment).** Repeats
   the credential-free preflight, writes the review database, pushes the
   capture to the private package, renders the review pages, encrypts
   them under the passcode, writes the encrypted report and the outcome
   file, pushes the data files to the pages repository, and is done.
   A failure reporter job does the same with only the report and outcome
   when validation fails, so the author hears at minute 30, not 45.
7. **Pages deploy (in `lax-review-pages`).** Copies data files per token
   under a size budget, lays the loader files it takes from a pinned
   `lax-website` revision beside them, and deploys. It copies nothing
   that could execute from the publisher's push.
8. **Reviewer.** Opens `https://review.laxarchive.org/<token>/`, enters
   the passcode, reads the submission's pages as they would look on the
   public site, with links to the public records it cites resolving to
   `laxarchive.org`.

## Components

### The review issue and its comments

A review issue is an ordinary issue in `lax-archive/lax` whose body is
the single hidden marker `<!-- lax-review -->` and no id. The CLI creates
it on the folder's first `lax review submit` and records its number in
`.lax-review.json` beside the folder and in `~/.lax/review/<id>.json`.
Precheck admits the marker beside the submission marker; ordinary issues
stay filtered at zero runners. The route job branches on the marker
before it loads any public record, since none exists.

Every command on a review issue is one sealed comment:

```
/lax review <keyId>.<sealed:base64url>
```

The sealed payload is the JSON the public protocol would have carried,
encrypted to the lax review public key, with **associated data** that
binds it to where it is posted: the issue number, the commenter's numeric
GitHub id, the key id and the action verb. The unseal job re-derives the
associated data from the comment it re-read through the API and refuses
any box that does not match, so a sealed command copied to another issue
or posted by another account is refused before its contents are looked
at. Replay on the same issue by the same account is idempotent: same
digest, same record.

Verbs, all sealed: `submit`, `delete` (record, blobs and pages),
`owners` (a list of numeric GitHub ids the opener trusts to drive this
record; only the issue opener's `owners` commands count), `extend`
(retention, no validation run), `reseal` (a new passcode, re-encrypting
the stored render, no validation run). Authorization is derived from the
public issue thread alone: the opener, plus whoever the opener's most
recent `owners` command names. The fetch job checks the opener rule from
plaintext comment metadata; the unseal job decrypts the opener's `owners`
command to learn co-owners, then the incoming command. Nothing in the
closed repository consults a database to authorize.

No result, progress or failure is ever posted to the issue. The CLI
follows the public route and dispatch jobs as it follows any run today,
then polls the outcome file at the review origin. `--resume` re-derives
the issue from the folder's `.lax-review.json` or `~/.lax` and the token
from the same place; the issue thread remains the audit log of commands.

### Cryptography

All `node:crypto`, no dependency:

- **Sealed commands**: X25519 ephemeral agreement with the lax review
  public key, HKDF-SHA256 to a 256-bit key, AES-256-GCM with the
  associated data above. The public key and its id ship in the CLI; a
  rotation is a CLI release, and both keys stay valid for a grace period.
- **Content key**: a random 256-bit AES-GCM key per upload, carried
  inside the sealed command and stored in the review record wrapped to
  the current review key, so `admin revalidate` and key rotation can
  reopen the archived ciphertext. The tar is encrypted in 1 MiB chunks
  with the chunk index as associated data, so the unseal job streams and
  a truncated or reordered upload fails closed.
- **Token and passcode**: generated by the CLI on the record's first
  submit. The token is 128 random bits, base32, the record's stable URL.
  The passcode is six words from a 7 776-word list, 77 bits, never
  author-chosen, because the encrypted bundle is a public file. Key
  derivation is scrypt with `N=2^15, r=8, p=1` and a 16-byte salt — about
  32 MiB and under a second on a laptop, a few seconds on a phone — then
  AES-256-GCM over the tar of the rendered pages.
- **Review private key**: an X25519 key in a protected environment of
  the closed repository, held only by the unseal job.

### The tar

A new deterministic ustar writer in the CLI (`src/shared/review-pack.ts`):
sorted entries, zero mtimes, fixed ownership, a per-file sha256 manifest.
The existing `sealCapture` runs GNU tar inside the container and cannot
serve the author's machine; its file-inventory rules (`inventoryFiles`,
to be exported) are applied before packing: no symlinks, no non-regular
files, a review-specific cap well under the public 2 GiB, chosen in
stage 0 from real submissions. The CLI's packer is the format authority;
the unseal job recomputes the digest over the bytes it decrypts. Contents
are the folder minus `.lake/`, `build-output.json`, `paper.pdf`,
`paper-web.tar` and `.lax-review.json`.

The static gate gains one warning for review runs: author names from the
manifest found in Lean comments, `.tex` sources or `.bib` files, since
`anonymous: true` hides the manifest's names and nothing else.

### The gist

The CLI creates a secret gist with `POST /gists` (`public: false`) with
the ciphertext as base64url in files of a size stage 0 fixes (10 MiB is
the target; the API documents no upload cap), and records the gist's git
commit from the response. Secret gists are unlisted but fetchable by URL
and are git repositories; an unadvertised commit fetches anonymously by
SHA (*verify* for a secret gist; confirmed for a public one). The fetch
job validates the URL with a gist-specific check that admits only
`https://gist.github.com/<hex>` and reuses `checkoutRemoteCommit`; the
global `validateRepositoryUrl`, which lakefiles also pass through, is
untouched, so no lakefile can ever require a gist. The CLI App gains the
user permission `Gists: write` and nothing else; existing logins must
re-authorize once. The CLI deletes the gist when the outcome arrives; the
unseal job has archived the ciphertext in the private package by then.
Git push to gists with App user tokens is reported broken and is not
used.

Fallbacks if stage 0 refutes the gist path: chunked comments (48 KB of
base64 each; viable for source-only submissions, not for figures) or a
transient fork and pull request against a public inbox repository (needs
repository administration on the author's account, so it is second).

### The dispatch and the abuse caps

A new job in `submission.yml`, `dispatch-review`, gated on the review
marker, in a new protected environment `lax-review-dispatch`, mints a
token for a **Review Dispatcher** App installed only on
`lax-archive/lax-review` with `Contents: write` and sends a
`repository_dispatch` carrying the issue number and comment id. Payloads
are capped at 64 KB and comments are not, which is one more reason the
closed repository re-reads the comment itself. The App has no
`Workflows` permission and the closed repository protects its default
branch, so the dispatcher key can start runs and nothing else.

Before dispatching, the job enforces caps from public data alone: the
commenter's account age, the number of review commands from this account
in the last day, a global daily budget, and the `bytes` the envelope
declares against the review cap. A repository variable `LAX_REVIEW_OFF`
is the kill switch. Jan sets an Actions spending limit on the
organization before stage 6. Throwaway accounts still cost runs; the
budget bounds the bill, not the nuisance.

### The closed repository

`lax-archive/lax-review`, private, one workflow (`review.yml`, `on:
repository_dispatch`), two environments, no source of its own:

| job | environment | secrets | permissions | executes submission code |
| --- | --- | --- | --- | --- |
| `fetch` | none | none | none | no |
| `unseal` | `lax-review-unseal` | review private key | none | no |
| `validate` | none | none | none | yes |
| `publish-review`, `report-review-failure` | `lax-review-publish` | Review Publisher App keys | `packages: write` | no |
| `expire` (scheduled) | `lax-review-publish` | same | `packages: write` | no |

Every job checks out `lax-archive/lax` at a commit pinned in the workflow
file and builds it with `.github/actions/setup-lax`. Bumping the pin is a
commit to the closed repository's protected default branch, the branch
its environments deploy from; environment reviewers are Enterprise-only
on private repositories, so branch protection is the control. Every
pipeline-affecting release of `lax` owes this bump, or review verdicts
silently diverge from public ones — a standing chore, listed in TODO.

The Actions cache: `validate` restores the toolchain and warm-store
entry under the same key the public plane uses and never saves; a
scheduled trusted job in the closed repository provisions and saves it,
before any submission code has run in that job. Stage 0 *verifies*
whether a `repository_dispatch` run's token can write the cache at all;
if it can, `validate` runs with `permissions: {}` and the saver records a
manifest of hashes that `validate` checks after restore, so a poisoned
entry is refused rather than executed. Artifact retention is one day.

The private package `ghcr.io/lax-archive/lax-review-captures` holds
captures, papers, web bundles, rendered-page tars (for `reseal`) and the
archived ciphertext, digest-addressed through a new general blob method
in `capture-store.ts` beside the capture-specific `promote`. Only the
publish jobs read or write it, with their own `GITHUB_TOKEN` after the
package grants the closed repository access. `validate` never touches
it (decision 10).

### The Review Publisher Apps

Two registrations, so that no single key can both rewrite the review
database and place files on the review origin:

| App | installed on | permission | held by |
| --- | --- | --- | --- |
| Review Database Publisher | `lax-review-database` | `Contents: write` | `lax-review-publish` |
| Review Pages Publisher | `lax-review-pages` | `Contents: write` | `lax-review-publish` |

The pages publisher can push only data files the deploy will copy; the
loader never comes from its push (below). A leaked database key can
rewrite owner lists, which is why authorization never reads the database
(above) and why owner lists in the review database are informational.

### The review database

`lax-archive/lax-review-database`, private, the public three-file layout
per id. `record.json` carries no `source` triple; it carries

```json
"sealedSource": {
  "digest": "<sha256 of the plaintext tar>",
  "bytes": 1234567,
  "sealed": { "digest": "<sha256 of the ciphertext>", "registryBlob": "ghcr.io/lax-archive/lax-review-captures@sha256:…" },
  "contentKey": { "keyId": "2026-09", "wrapped": "<base64url>" }
}
```

`build-output.json` is the public shape; its `issue` block binds the
review issue exactly as a public record binds its issue, so
`record-gates.ts` and the publisher's issue checks apply unchanged. The
capture gains `sourceDigest` as an alternative to `sourceCommit` rather
than overloading a field whose parser demands 40 hex characters. States
are `draft` and `deleted`; `registered` does not exist for review
records and `lax register` refuses them. `archive-schema.ts` and
`artifact-schema.ts` get a review mode for these two divergences. The
website loader and `lax serve` never see this database.

### The validation seam

`ValidationRequest.source` becomes a union: the git triple as today, or
`{ kind: "directory", digest }`, meaning the caller has placed the tree
at the job's source directory and vouches for it by digest. `fetchSource`
has one call site, in `pipeline.ts`, and `ValidationOptions.local`
already injects an on-disk tree past the fetch for the host path; the
request-level kind lets `run.ts` do the same. Consumers of
`source.commit` that need a sibling for the digest: the paper's
`SOURCE_DATE_EPOCH` (today read from git; for a directory source it is
the tar's fixed epoch), the capture's `sourceCommit` (above), the capture
tag and the promote checks in `capture-store.ts`, and the source-triple
comparisons in `submit-publisher.ts`. The static gate, resolution,
provisioning, the container phases and the paper do not change.

### Rendering, subtree, and encryption

The publish job loads a pinned public database snapshot plus the review
record and calls `generateSite` exactly as `loadWebsiteSubmissions` does
for a local folder, with a new renderer option `review: true` that omits
the comments and citation scripts and their CSP origins, so no script on
a review page ever posts its URL anywhere. From the output it keeps
`<id>/` — the submission, concept, proof and paper pages, the paper's
`.pb` blocks — plus the content-hashed fonts the reflow page emits at the
site root, and discards every page that would name the record.

The site's links are relative (`../assets/…`, `../lax-N/…`, `../fonts/…`),
so under `review.laxarchive.org/<token>/<id>/` they point inside the
token's scope. The service worker maps them: `<scope>/assets/*` and
`<scope>/fonts/*` are fetched from `laxarchive.org` and answered
same-origin; `<scope>/lax-N/*` for any id other than the review's own
redirects to `https://laxarchive.org/lax-N/*`. This mapping is
load-bearing code with a test per link class.

The kept subtree is tarred, encrypted under the passcode, and written as
`<token>/bundle-<digest>.enc`; `<token>/report.enc` is the validation
report encrypted under the same passcode; `<token>/outcome.json` is the
only plaintext: outcome, the bundle's file name, the run id, timestamps,
expiry. The plaintext rendered tar is stored in the private package so
`reseal` re-encrypts without re-rendering. The loader fetches
`outcome.json` and the bundle with `cache: "no-store"`, so a stable token
survives CDN caches.

### The review origin

`lax-archive/lax-review-pages`, public, is both the holding place and a
GitHub Pages site at `review.laxarchive.org`. A separate origin, because
the public site renders author content and one origin would let any
script on `laxarchive.org` read an unlocked review in the same profile;
Pages cannot send the headers that would otherwise isolate them. The
site's 1 GB cap is then the review service's own budget.

Its deploy workflow, on every push and hourly: check out a pinned
`lax-website` revision for the loader files, copy each token's
`bundle-*.enc`, `report.enc` and `outcome.json` and nothing else, lay
`index.html`, `loader.js` and `sw.js` beside them, enforce a per-bundle
cap and a total budget (oldest expiring first when over), and deploy.
Nothing the publisher pushed is served as HTML or script.

### The loader

`index.html` (with `noindex` and `referrer: no-referrer`) asks for the
passcode, derives the key in a Web Worker, decrypts and untars the bundle
in memory, registers `sw.js` scoped to `<token>/`, and navigates to the
submission page. The worker answers in-scope fetches from the decrypted
files with the right content type and the site's own CSP attached to
every synthesized document, and applies the mapping above for assets,
fonts and public records. The key lives in the worker for the tab
session; a reload asks again. Browsers without service workers, and
Safari private mode, get the decrypted PDF as a download and a note that
the concept and proof pages need a regular browser. The plan accepts that
this fallback loses the reviewer surface.

### The CLI

- `lax review submit [folder]`: everything above, then follows the
  public run and polls the outcome file, prints the URL and passcode,
  and renders the decrypted report's findings with the same renderer
  `lax build` uses. `--resume` reattaches from the folder or `~/.lax`.
  `-f` skips the local build. The command says, before it does anything,
  that a private validation takes up to 45 minutes and that the URL and
  passcode stay the same across resubmits.
- `lax review status [folder]`: URL, passcode, expiry, and whether the
  record is current with the folder.
- `lax review owners`, `extend`, `reseal`, `delete`.
- Local state: `.lax-review.json` in the folder (gitignored by the
  scaffold's generated-files list) and `~/.lax/review/<id>.json`, each
  holding the issue number, token and passcode. Losing both loses the
  URL; `lax review reseal` after a fresh `submit` from the owning account
  re-establishes everything, since token and passcode are the CLI's to
  choose.

**Promotion for a plain-folder author**, spelled out in
`assets/instructions.md`: create a public repository, `git init`, commit,
push, `lax submit` (which binds the public issue and asks for the binding
to be committed), commit, push, `lax submit` again. Six steps. `lax
submit` on a folder with a review record says so and continues; the
review record lives on until it expires, and promotion before expiry is
harmless. A reviewer who learns the id from the pages could `lax submit`
junk under it first; the remedy is `admin delete` of the squatter's
record.

### Retention and expiry

Review records, blobs and pages expire 180 days after the last submit
or `extend`. The scheduled `expire` job removes the record, its blobs and
its token directory. `lax review submit` on an expired record starts over
with the same id, token and passcode.

### Admin

`/lax admin review list`, `delete <token|issue>`, `extend`, driven by the
same maintainer driver as today's admin verbs, and the `LAX_REVIEW_OFF`
kill switch. A takedown maps token → record → issue → opener through the
review database, which only maintainers can read.

## Trust analysis

Trust rule 1 is intact: `fetch` and `validate` hold nothing; `unseal`
holds the review key and touches only ciphertext and a JSON envelope;
the publish jobs hold App keys and execute nothing; the dispatch job's
key can only start review runs. Trust rule 2 is repeated where plaintext
first exists: the closed repository re-reads the issue and comment
through the API, authorizes by numeric id from the thread, and binds the
sealed box to that thread before decrypting it. Trust rule 4 holds: the
CLI holds the author's user token and a public key.

What the design deliberately accepts:

- **Lax reads the author's source.** That is the service. The keys that
  can read it are one X25519 key in one environment; a compromise
  exposes every submission sealed under that key id, so rotation is a
  yearly routine with re-wrapping of stored content keys, not an
  emergency.
- **Ciphertext is public** in a gist and on the review origin; size and
  timing leak.
- **Existence and timing are public**, and the join between the issue
  opener and the outcome file's timestamp is exact at the archive's
  volume. Authors who need to hide that use a throwaway account, and the
  instructions say so.
- **The passcode is brute-forceable offline** at one scrypt evaluation
  per guess; 77 bits is out of reach.
- **One review origin, many tokens.** A hostile review page cannot read
  another token's unlocked pages unless the reviewer has both open in one
  profile and the hostile page can script the other's document; the
  worker answers only in-scope document navigations and attaches the site
  CSP, which is the most a static host can do. Per-token isolation is not
  available without a server.
- **Runs cost money and any account can start one**, bounded by the caps
  and the spending limit.
- **A review record cannot be cited or depended on**, and `registered`
  does not exist for it; endorsements live on the public side after
  promotion.

## Cost

Rates and limits from GitHub's documentation on 2026-09-14; stage 5
measures the real per-run number.

| item | figure |
| --- | --- |
| GitHub Team plan, required (below) | $4 per seat per month |
| validate job, longest observed | about 30 min |
| fetch, unseal, publish, render | about 10 to 15 min |
| standard private Linux runner, 2-core, 8 GB, 14 GB disk | $0.006 per min |
| larger Linux runner, 4-core, 16 GB, 150 GB disk | $0.012 per min |
| per submission, larger runner | about $0.55 |
| per submission, standard runner, if it fits | about $0.27, from 2 000 or 3 000 included minutes |
| artifact storage past the plan quota | $0.25 per GB-month; retention is one day |
| Actions cache | 10 GB per repository, free |

**The Team plan is required**, not a cost option: environments,
environment secrets and deployment-branch restrictions in a private
repository, and larger runners, are all unavailable on the Free plan.
Larger runners never draw on included minutes. Public runners are 4-core,
16 GB; the standard private runner is 2-core, 8 GB, and the pipeline
runs two Lean workers under a 16 GiB container cap (`history/oom.md`).
Stage 0 measures whether a real submission validates on the standard
runner with the compile budget lowered to one worker; if not, the larger
runner is the answer and the free allowance is irrelevant.

## Stages

Each stage lands with its tests and is independently useful; nothing
before stage 5 touches production.

0. **Spike** (`spike/review/`, throwaway; `REPORT.md` holds verdicts).
   *Verify*: `POST /gists` with a `Gists: write` user token and the
   per-file size it accepts; anonymous `git fetch --depth 1` of an
   unadvertised commit of a *secret* gist; `repository_dispatch` into a
   private repository with the dispatcher token; whether a
   `repository_dispatch` run can write the Actions cache; whether the
   standard private runner validates a real submission; a loader and
   service worker prototype on Chrome, Firefox and Safari serving a real
   `lax serve` render with the link mapping; the Pages site on the review
   origin with its deploy. Also decide the review tar cap from real
   submissions.
1. **Cryptography and the tar** (`src/shared/sealed.ts`,
   `src/shared/review-pack.ts`): sealed boxes with associated data,
   chunked content encryption, passcode derivation, the ustar writer,
   `inventoryFiles` exported. Fixed test vectors; a round trip through a
   real folder fixture; a cross-check that the CLI's tar and the unseal
   job's digest agree.
2. **The seam and the record shapes**: the `directory` source kind in
   `contracts.ts` and `pipeline.ts` with the epoch, capture and publisher
   siblings named above; `sealedSource` and `sourceDigest` in the two
   schema modules; the gist-only URL check; the general blob method in
   `capture-store.ts`; the hardened extractor reused for the tar. The
   fake-runner suite gains a directory-source case; the host e2e proves
   the same report for a git source and its directory copy.
3. **The workflows and the CLI**: `dispatch-review` and the caps in
   `submission.yml` and `control-plane.ts`; `review.yml` and its handlers
   in `src/workflows/review.ts` (fetch, unseal, publish-review,
   report-review-failure, expire); the CLI verbs and local state; the
   `patch-workflow.mjs` and `workflow-definition.test.ts` assertions made
   mode-aware. `fake-github.ts` grows gists and `repository_dispatch`;
   the e2e drives the CLI through a sealed submit and reads the outcome
   from a fake review origin.
4. **The website**: the `review` renderer option, the subtree extraction
   with root fonts, the loader, worker and service worker in
   `lax-website/assets/site/review/`, the review origin's deploy
   workflow. Tests: a fixture bundle decrypts and every page serves
   through the worker under the site CSP; every link class maps; the
   deploy copies only data files and enforces the budget. Prerequisite:
   the `anonymous`/`unlisted` website work TODO.md already owes.
5. **Rehearsal** (`scripts/rehearsal/` gains a review variant with
   scratch repositories for the closed repository, the review database
   and the review origin): a real sealed submit end to end, the passcode
   round trip, a failure at minute 30, `owners`, `reseal`, `delete`,
   expiry, the caps. Measures cost per run. The standing rule for
   Actions-side changes applies with extra weight.
6. **Production and docs**: Team plan; the closed repository, the
   review database, the package with its access grant, the review pages
   repository and its Pages site with DNS; three App registrations; the
   environments; the review key pair; the spending limit and kill
   switch; README, `assets/instructions.md` ("Private review", with the
   promotion steps and the anonymity statement), spec-notes, TODO; the
   first real review of a flagship draft, recorded in `history/`.

## Open questions for Jan

1. The Team plan is a precondition. Yes?
2. Retention 180 days from the last submit or `extend`?
3. Insist on `anonymous: true` in the manifest for review submits unless
   `--named` is passed?
4. Scope: build the whole thing, or first ship the cheaper `lax export`
   (below) and let demand decide whether archive-attested review is
   needed before acceptance?

## What the reviews changed

Four independent reviews of the first draft, 2026-09-14. Taken:

- **The reply key, `rekey` and the App bot id are gone** (usability). The
  CLI chooses token and passcode once per record and sends them in the
  sealed command; results are a public outcome file on the review origin
  and an encrypted report beside it; no result is posted to the issue,
  so no App needs `Issues: write` on `lax`. Links survive resubmits.
- **Sealed commands are bound to their issue and commenter** (security,
  critical): associated data plus the opener rule, checked before
  decryption; the first draft let a copied box create a record under the
  copier's ownership and then read the victim's draft through `rekey`.
- **Fetch split from unseal** (security): the key-holding job no longer
  runs git against an author-chosen remote or untars author bytes;
  extraction moved into the credential-free validate job with the
  hardened extractor, enforcing caps during extraction.
- **Content key archived** (security): the first draft could not
  revalidate or rotate; the key is now stored wrapped in the record.
- **Two publisher Apps and a copy-only deploy** (security): the first
  draft's single App could replace the loader served on the archive's
  domain.
- **Own origin for reviews** (security): same-origin scripting between
  a hostile page and an unlocked review; Pages cannot isolate by
  headers.
- **Caps in the public dispatch job, a kill switch, a spending limit,
  a bundle budget** (security): cost denial and the 1 GB Pages cap.
- **Team plan, current rates, 8 GB, cache writability, dispatch payload
  size, indexed hidden markers, no git push to gists** (platform).
- **No deterministic tar exists for the CLI; links are relative;
  `comments.js` posts the page URL off-origin; `sourceCommit` rejects a
  digest; `commitTimestamp` reads git; the rehearsal patcher asserts
  exact counts** (codebase) — each now a named piece of stages 1 to 4.
- **Failure reported at minute 30, `owners`, `extend`, `reseal`, a
  stated 45-minute expectation, honest promotion steps, admin verbs, the
  pin-bump chore, the anonymity statement, the name-leak gate warning**
  (usability).

Rejected or deferred, with the reason:

- **Per-publish tokens** (security, low) against **stable links**
  (usability, top finding): stable wins; the bundle file is
  content-addressed and fetched with `no-store`.
- **Per-token isolation on the review origin**: impossible on a static
  host; documented as residual.
- **Serving the review id under a neutral name**: package names carry
  the id in every Lean file; accepted with `admin delete` as the remedy
  for squatting.

Alternatives considered and not chosen, recorded for the scope question:

- **`lax export`**: `lax serve`'s render of the folder written as a
  self-contained static site the author uploads as supplementary
  material, labelled "author-built, archive validation on acceptance".
  About a week, no crypto, no repositories, no Apps, and it uses the
  channel every conference already has. It does not carry the archive's
  verdict, which is the reason this plan exists; it is also the cheapest
  first step if that verdict turns out not to be what venues ask for.
- **An unlisted, anonymous public submission from a throwaway
  account**: archive-attested, zero new code once the website flags
  land; but the source, captures and pages are public in the clear, which
  is exactly what an unpublished paper cannot have.
- **Waiting until acceptance**: the honest baseline the instructions
  should state either way.
