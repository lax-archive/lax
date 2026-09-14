# Private submissions — plan

Status: designed 2026-09-14 (Jan and an agent session, this document is
the record). Nothing is implemented. The platform facts marked *verify*
in "Stage 0" are assumptions until the spike confirms them; the design
below is arranged so that each of them, if false, has a named fallback.

## The problem

Conference peer review needs a draft that only its reviewers can read.
Every surface of the archive is public by construction: the database
repository, the source it points at, the captures on ghcr, the Actions
logs and artifacts of the control plane, and the website. A formalization
under review therefore has no home in the archive today, and an author
who wants reviewers to see it has to ship a screenshot or a zip.

What a reviewer needs is the submission's website pages — the concept
cards, the statements and their proven/unproven marks, the proof list,
the paper with its marked passages — behind a passcode, produced by the
archive's own validation so the verdict carries the archive's trust and
not the author's word. What the author needs is to get there without
granting the archive access to a private repository, without running a
server, and from a plain folder if that is where the work lives.

## Decisions

These are the one-way doors. Everything else in this document follows
from them and can be revised.

1. **A second instance, not a second backend.** Review validation runs
   the unchanged pipeline (`src/submission-validation/`, the same
   publisher and page-builder) as a second *deployment* of the code in
   the open repository. All logic stays in `lax-archive/lax`. The
   constants module already parameterizes control, database, website,
   captures and site URL by environment variable, and
   `scripts/rehearsal/` already stands up a complete instance that way.
   The review instance is that shape made permanent.
2. **Execution in one closed repository, because GitHub's privacy unit
   is the repository.** Logs, artifacts, caches and step summaries
   inherit the repository's visibility, and any one of them carries
   plaintext during a validation. The closed repository
   (`lax-archive/lax-review`) contains a fifty-line workflow that checks
   out `lax` at a pinned commit, the protected environments holding the
   review keys, and nothing else. Validating inside the open repository
   would mean muting every transcript, encrypting every artifact and
   suppressing every annotation — deny-by-enumeration, the defect class
   `history/audit-20260903.md` names — with the decryption key sitting in
   a job that executes submission code, which trust rule 1 forbids.
3. **Lax never reads the author's repository.** No GitHub App is
   installed on author repositories. Transport is a tar the CLI packs from
   any folder, encrypted to a lax review public key, deposited where a
   lax job can fetch it anonymously. Git and plain folders are the same
   case.
4. **The public control repository stays the only author-facing
   surface, in and out.** Commands are comments on public issues in
   `lax-archive/lax`; results are comments on the same issues. Authors
   never see, join or touch the closed repository, so there is no
   collaborator management and nothing one author can read of another's.
5. **Everything an author or reviewer would recognise is ciphertext in
   public.** The command comment, the result comment, the deposited
   source and the published pages are all encrypted. The public trace of
   a review is: a GitHub account opened an issue carrying a review marker
   and posted sealed comments on it at some dates. In particular the
   submission id never appears in public until promotion, so a reviewer
   who reads the id off the pages cannot find the author through it.
6. **Same id space, same schemas, no visibility field.** A review record
   uses the id `lax init` generated locally and the public record shapes
   with one documented extension (`sealedSource`, below). It lives in the
   review database or, after promotion, in the public one — never in both,
   and no record anywhere says which. The public archive, its database,
   its website build and its schema learn nothing about review records.
7. **Promotion is the ordinary public submit.** An accepted paper's
   formalization goes public by making the plaintext source public and
   running `lax submit` with the same id. The first public submit already
   checks that the id is unused and binds a fresh issue; the review record
   is then deleted by retention. No promotion code, no copying between
   databases.
8. **The reviewer surface is the existing site, encrypted at rest.**
   The review pages are rendered by the private instance with the
   page-builder `lax serve` uses, encrypted under a generated passcode,
   and served from the existing GitHub Pages tree under a review path.
   GitHub Pages cannot be private and the archive runs no server; a
   client-side decrypting loader closes the gap with a static file.
9. **Review records may require public records; nothing may require a
   review record.** Dependency resolution runs against the public
   snapshot as today. A review record's source is ciphertext, so no
   lakefile can pin it, and the rule needs no enforcement code.

## The path

```
author machine        lax-archive/lax (public)        lax-archive/lax-review (closed)        lax-website (public)
─────────────         ────────────────────────        ───────────────────────────────        ───────────────────
lax review submit ──▶ issue + sealed comment ──▶ route (envelope only) ──▶ dispatch ──▶ unseal ──▶ validate ──▶ publish ──▶ pages holding place ──▶ deploy copies ──▶ /review/<token>/
                  ◀── sealed result comment ◀────────────────────────────────────────────────────┘
```

1. **CLI.** `lax review submit [folder]` runs the local build unless
   `-f`, packs the folder into a deterministic tar, encrypts it to the
   lax review public key, uploads the ciphertext to a secret gist owned
   by the author, and posts a sealed command to the review issue (created
   on first use). The command names the gist commit, the plaintext digest,
   the wrapped content key, and the CLI's own ephemeral public key for the
   reply.
2. **Public route job.** Checks the envelope the way `precheck` and
   `route` already do — a human commenter, the review marker in the issue
   body, byte limits — and forwards the sealed comment to the closed
   repository by `repository_dispatch`. It cannot read the command and
   does not try to; authorization happens where the plaintext is.
3. **Unseal job (closed repository, holds the review private key,
   executes nothing).** Decrypts the command, re-reads the public issue
   and comment through the API as data (trust rule 2: the dispatch
   payload is untrusted), authorizes the commenter's numeric id against
   the review record's owner, fetches the gist commit with the existing
   hardened fetcher, decrypts the tar, verifies the plaintext digest,
   applies the fetcher's symlink and size inspection, archives the
   ciphertext as a digest-addressed blob in the private captures package,
   and uploads the plaintext tree as an artifact of this run.
4. **Validate job (closed repository, credential-free).** Downloads the
   artifact into the job directory and runs the unchanged pipeline with
   the one new seam: a source that is already on disk instead of a git
   triple. Everything from the static gate through Compile, Replay,
   Inspect, the paper and the capture is the same code and the same
   containers.
5. **Publish job (closed repository, protected environment).** Repeats
   the credential-free preflight, writes the review database, pushes the
   capture to the private captures package, renders the review pages,
   encrypts them under a generated passcode, pushes the encrypted bundle
   to the public holding place, dispatches the website rebuild, and posts
   the result — URL, passcode, summary — sealed to the CLI's ephemeral key
   as a comment on the public issue. The full validation report is sealed
   to the same key and published beside the bundle, since a comment cannot
   hold it.
6. **Website deploy.** Checks out the holding place as it checks out the
   database, and copies it verbatim under `review/`. It parses nothing.
7. **Reviewer.** Opens `https://laxarchive.org/review/<token>/`, enters
   the passcode, and reads the submission's pages exactly as they would
   look on the public site, with links to the public records it cites
   resolving to the live site.

## Components

### The review issue and its comments

A review issue is an ordinary issue in `lax-archive/lax` whose body is a
single hidden marker, `<!-- lax-review -->`, with no id. The CLI creates
it on the first `lax review submit` of a folder and records the issue
number in `~/.lax/review/<id>.json` beside the ephemeral key; it is the
handle for `--resume` and for every later command on the same record.
Precheck admits the marker beside the submission marker; ordinary issues
stay filtered at zero runners.

Every command and every result on a review issue is one sealed comment:

```
/lax review <sealed:base64url>
```

The sealed payload is the JSON the public protocol would have carried —
`{ action: "submit", id, gist: { repository, commit }, digest, bytes,
contentKey, replyKey }`, or `{ action: "delete", id }` — encrypted to the
review public key. The route job forwards it; only the unseal job reads
it. Results are `{ action, outcome, url, passcode, summary, runUrl }`
sealed to `replyKey`, posted by a bot the CLI recognises (below), with the
same hidden correlation markers the public protocol uses so `lax review
submit --resume` re-derives the run from the issue as `lax submit
--resume` does today.

Verbs: `submit`, `delete` (removes the record, its blobs and its pages;
retention does the same automatically), `rekey` (registers a new reply
key after a lost `~/.lax`). `owners` is deliberately absent — a review
record has exactly one owner, the account that opened its issue; a
co-author who needs to drive it opens their own. Promotion is `lax
submit`, not a review verb.

### Cryptography

All of it is `node:crypto`, no dependency:

- **Sealed boxes** (command, result, report): X25519 ephemeral key
  agreement with the recipient's public key, HKDF-SHA256 to a 256-bit
  key, AES-256-GCM. The lax review public key ships in the CLI with a key
  id; the result carries the key id it was sealed under, so a rotation is
  a CLI release and both keys stay valid for a grace period.
- **Content key**: a random 256-bit AES-GCM key per upload, wrapped in
  the sealed command. The tar is encrypted in 1 MiB chunks so the unseal
  job can stream and so a chunk boundary is the unit of the gist's file
  size limit.
- **Passcode**: generated by the publish job, six words from a fixed list
  (about 77 bits), never author-chosen, because the encrypted bundle is a
  public file and an offline guess costs the attacker nothing but time.
  Key derivation is scrypt with parameters that cost a browser about one
  second (`N=2^17, r=8, p=1`), a random 16-byte salt, then AES-256-GCM
  over the tar of the rendered pages.
- **Review private key**: an X25519 key in a protected environment of
  the closed repository, like the App keys. It decrypts every review
  submission ever sent under its key id, so it sits only in the unseal
  job, which executes nothing.

### The tar

The plaintext is `capturePackage`'s format from
`src/submission-validation/captures/seal.ts`: a deterministic tar with
sorted entries, fixed mtimes and a manifest of per-file sha256, so the
digest the CLI puts in the command is what the unseal job recomputes.
Contents are the folder's committed-or-not files minus `.lake/`,
`build-output.json`, `paper.pdf` and `paper-web.tar`, with the fetcher's
rules applied before packing: no symlinks, no non-regular files, the
100 000-file and 2 GiB caps. The unseal job re-applies them on the
unpacked tree, as it must, since the CLI is untrusted.

### The gist

The CLI creates a secret gist (`POST /gists`, `public: false`) with the
ciphertext as base64url in files of at most 10 MiB each, and records the
gist's git commit from the response. A secret gist is unlisted but
anonymously fetchable by URL, and it is a git repository, so the unseal
job fetches it with `fetchGitCheckout` unchanged except that
`validateRepositoryUrl` admits `https://gist.github.com/<hex>` in review
mode only. The public comment names the gist commit; the URL reveals
ciphertext and the author's account, which the issue reveals anyway.

The author may delete the gist the moment the result arrives: the unseal
job has archived the ciphertext in the private captures package, and a
later `admin revalidate` reads it from there.

Fallbacks if stage 0 shows the gist path does not work: the CLI's
chunked-comment transport (about 48 KB of base64 per comment, viable for
source-only submissions and nothing with figures), or a transient fork
plus pull request against a public inbox repository (needs repository
administration on the author's account, which is why it is second).

### The dispatch

A new job in `submission.yml`, `dispatch-review`, gated on the review
marker, in a new protected environment `lax-review-dispatch`. It mints a
token for a new **Review Dispatcher** App installed only on
`lax-archive/lax-review` with `Contents: write` and sends a
`repository_dispatch` whose payload is the issue number, the comment id
and the sealed comment. It executes no submission code and reads no
plaintext. Trust rule 1 holds; the key it holds can start review runs
and nothing else.

### The closed repository

`lax-archive/lax-review`, private, one workflow (`review.yml`, `on:
repository_dispatch`), three environments, no source of its own:

| job | environment | secrets | executes submission code |
| --- | --- | --- | --- |
| `unseal` | `lax-review-unseal` | review private key | no |
| `validate` | none | none | yes |
| `publish-review` | `lax-review-publish` | Review Publisher App key | no |

Every job checks out `lax-archive/lax` at a commit pinned in the workflow
file and builds it with `.github/actions/setup-lax`, the same "a job that
holds a token runs only bytes it built itself" rule as today. Bumping the
pin is a reviewed commit to the closed repository's default branch, which
is the branch its environments deploy from.

The **Review Publisher** App is installed on `lax-archive/lax-review-database`
(`Contents: write`), on the holding place `lax-archive/lax-review-pages`
(`Contents: write`), on `lax-archive/lax` (`Issues: write`, to post the
sealed result) and on `lax-archive/lax-website` (`Contents: write`, to
dispatch the rebuild). Four installations under one key are more reach
than the public plane's one-App-one-repository doctrine allows; the
alternative is four registrations, and the choice is Jan's. What the
doctrine protects against — a leaked key writing the public database or
the public site — is not on this list: the review publisher can write
ciphertext to a public holding place, sealed comments to the public
issues, and the private review database. Its worst case is a forged
result comment, which the CLI decrypts to nonsense and rejects.

Because the result is posted by an App and not by `github-actions[bot]`,
the CLI's bot-identity check (`GITHUB_ACTIONS_BOT_ID`) gains the Review
Publisher's bot id for review issues only.

### The review database

`lax-archive/lax-review-database`, private, the public three-file layout
per id. `record.json` carries no `source` triple; it carries

```json
"sealedSource": {
  "digest": "<sha256 of the plaintext tar>",
  "bytes": 1234567,
  "sealed": { "digest": "<sha256 of the ciphertext>", "registryBlob": "ghcr.io/lax-archive/lax-review-captures@sha256:…", "keyId": "2026-09" }
}
```

and `build-output.json` is the public shape with `capture.sourceCommit`
replaced by the plaintext digest. `owner-list.json` holds the one owner.
States are `draft` and `deleted`; `registered` does not exist for review
records, and `lax register` refuses them. The parsers in
`src/shared/archive-schema.ts` get a review mode for the one divergent
block; the website loader and `lax serve` never see this database.

The private captures package `ghcr.io/lax-archive/lax-review-captures`
holds captures, papers, web bundles and the archived ciphertext, all
digest-addressed through `capture-store.ts` unchanged; the package's
visibility is private, and the only consumers are the closed
repository's own jobs, which pull with their `GITHUB_TOKEN`.

### The validation seam

`ValidationRequest.source` becomes a union: the git triple as today, or
`{ kind: "directory", digest }`, meaning the caller has placed the tree
at `<jobDir>/source` and vouches for it by digest. `fetchSource` has one
call site in the gate and one in the full run; both branch on the kind.
The report's `inputs` record the digest where they record the commit. The
static gate, dependency resolution, provisioning, the container phases,
the paper and the capture do not change. Local `lax build` keeps its own
host path; this seam is for the closed repository only, but it is a
natural home for a future "validate this directory" that `lax build
--trusted` might want.

### Rendering and encryption of the pages

The publish job loads the public database (a pinned snapshot, as the
route job pins one) plus the review record, calls the page-builder's
`generateSite` exactly as `src/cli/website.ts` does for a local folder,
and keeps only `<id>/` from the output — the submission, concept, proof
and paper pages and their per-submission assets. The landing page,
listings, `index.json`, `environments.json` and every other page that
would name the record are discarded. Links from the kept pages to public
records are the ordinary root-relative `/lax-N/` addresses and resolve on
the live site; links to shared assets (`/assets/site/…`, fonts, the
pdf.js and ReflowTeX viewers) likewise. Nothing else on the site links
back, which is what unlisted means here.

The kept subtree is tarred, encrypted under the passcode, and written
to the holding place as `review/<token>/bundle.enc` beside an
unencrypted `index.html`, `loader.js` and `sw.js`, all three identical
for every review and shipped from the page-builder bundle so the closed
repository never authors HTML. `<token>` is 128 random bits, base32. The
sealed report is `report.enc` beside them. Expiry is deleting the folder.

### The loader

`index.html` asks for the passcode, derives the key with scrypt in a
Web Worker, decrypts and untars the bundle in memory, registers `sw.js`
scoped to `review/<token>/`, and navigates to the submission page. The
service worker answers every fetch under its scope from the decrypted
files with the right content type, so the rendered pages, their scripts,
the graph inspectors, the manuscript cards and the reflow viewer load as
if they were static files on the site. The key stays in the worker for
the tab session; a reload asks again.

The site's Content Security Policy is `script-src 'self'` (plus
`worker-src 'self'` on paper pages). Every script here is a same-origin
file, so the policy does not change. Browsers without service workers
get a message and the PDF as a plain download, which the loader can
decrypt on its own. This is the only genuinely new website code: three
files, a few hundred lines, with the same "deterministic output, strict
CSP" rules as the rest of the site.

### The holding place and the deploy

`lax-archive/lax-review-pages`, public, one directory per token. The
deploy workflow checks it out beside the database and copies it to
`_pages/review/` in both production and preview modes; a token's
directory is removed when the closed repository deletes it, and the
next deploy drops the pages. The hourly fallback deploy already exists,
so a missed dispatch heals itself.

A public repository is the right holding place precisely because its
contents are ciphertext: nothing to protect, nothing to configure,
and `git log` is the audit trail of every publication and expiry.

### The CLI

- `lax review submit [folder]`: everything above, then follows the run
  like `lax submit` — the public issue's sealed result is the correlated
  outcome — and prints the URL and passcode, then the findings rendered
  from the decrypted report with the same renderer `lax build` uses.
  `--resume` reattaches from the issue. `-f` skips the local build.
- `lax review status [folder]`: URL, expiry, and whether the record is
  current with the folder.
- `lax review delete [folder]`, `lax review rekey [folder]`.
- The ephemeral key pair lives in `~/.lax/review/<id>.json` with the
  issue number; `lax review rekey` posts a fresh public key sealed to
  lax from the owning account, which is authorization enough.
- The CLI App gains one permission, `Gists: write`, so the CLI can
  create and delete gists in the author's own account. Nothing else.

`lax submit` of a folder that has a review record says so and continues
— promotion needs no ceremony, and the review record expires on its own.

### Retention

Review records, blobs and pages expire 180 days after their last
submit. A scheduled job in the closed repository deletes expired
records from the review database, their blobs from the package, and
their directories from the holding place, and posts a sealed notice on
the issue. `lax review submit` on an expired record starts over with the
same id. Authors extend by resubmitting.

## Trust analysis

Trust rule 1 is intact: the validate job holds nothing; the unseal job
holds the review key and executes nothing; the publish job holds App
keys and executes nothing; the dispatch job holds a key that can only
start review runs. Trust rule 2 is repeated where plaintext first
exists: the unseal job re-reads the issue and comment through the API
and authorizes by numeric id before it decrypts anything. Trust rule 4
holds: the CLI holds the author's user token and a public key.

What the design deliberately accepts:

- **Lax reads the author's source.** That is the service. The keys that
  can read it are one X25519 key in one protected environment.
- **The ciphertext is public.** Size and timing leak; nothing else does.
  The content key is per upload; the review key's compromise exposes
  every submission sealed under that key id, which is why rotation is a
  release-level routine and not an emergency.
- **The passcode is the reviewer credential and it is brute-forceable
  offline** at one scrypt evaluation per guess. Six words from a
  2 048-word list is 66 bits; the plan says six words from a
  7 776-word list, 77 bits, which is out of reach. Authors will paste
  it into a conference system; that is the intended use.
- **The author's account is visible on the issue.** A determined
  reviewer who can guess which of the review issues belongs to the paper
  learns a handle, but the id, the title and the dates of the pages
  point nowhere public. `anonymous: true` in the manifest, which the
  renderer already honours, removes names from the pages themselves.
- **A forged `/lax review` comment** by a non-owner is refused in the
  unseal job and costs one dispatch and one short run.
- **Private-repository Actions minutes cost money** (below), and a
  hostile author can start runs. The public plane has the same exposure
  today, capped by GitHub's rate limits; the closed repository can
  additionally refuse more than N submits per owner per day in the
  unseal job before any heavy work.

## Cost

Estimated from the observed timings and GitHub's published rates in
September 2026; stage 4 measures the real number.

| item | estimate |
| --- | --- |
| validate job, longest observed | about 30 min |
| unseal, publish, render | about 10 to 15 min |
| standard 2-core Linux runner | $0.008 per minute |
| 4-core larger runner | $0.016 per minute |
| per submission, 4-core | about $0.65 to $0.75 |
| included minutes on the org Free plan | 2 000 per month, standard runners only |

Public repositories get 4-core, 16 GB runners; private ones get 2-core,
7 GB on the standard tier. The pipeline runs two Lean workers under a
16 GiB container cap, and `history/oom.md` is the reason. Assume the
larger runner, which has no free allowance. Artifact storage on private
repositories is metered past the plan quota, so review artifacts keep a
retention of one day; the Actions cache (toolchain and warm mathlib,
several GB) is free to 10 GB per repository.

## Stages

Each stage lands with its tests and is independently useful; nothing
before stage 4 touches production.

0. **Spike** (`spike/review/`, throwaway, `REPORT.md` holds the
   verdicts). *Verify*: a GitHub App user token with `Gists: write` can
   create a secret gist through the API and the per-file size the API
   accepts; a secret gist's commit is fetchable anonymously by
   `git fetch --depth 1 origin <sha>` and, if not, by the deepening
   fallback; `repository_dispatch` into a private repository with a
   `Contents: write` App token; artifact retention can be set to one day
   on a private repository; the standard private runner cannot run a
   real validation and the larger runner can; the service-worker loader
   works on current Chrome, Firefox and Safari with the site's CSP.
1. **Cryptography and the tar** (`src/shared/sealed.ts`,
   `src/shared/review-pack.ts`): sealed boxes, chunked content
   encryption, passcode derivation, the deterministic tar over a folder
   with the fetcher's rules applied. Unit tests with fixed vectors; a
   round trip through a real folder fixture.
2. **The seam and the record shape**: the `directory` source kind in
   `contracts.ts` and `pipeline.ts`, the review mode of
   `archive-schema.ts`, `validateRepositoryUrl` admitting gists in review
   mode. The fake-runner suite gains a directory-source case; the host
   e2e proves the same report for a git source and its directory copy.
3. **The workflows**: `dispatch-review` in `submission.yml`;
   `review.yml` and its three handlers in `src/workflows/review.ts`
   (unseal, publish-review, report-review-failure); the CLI verbs; the
   Review Publisher bot id in the CLI's result matching.
   `workflow-definition.test.ts` covers the new jobs; `fake-github.ts`
   grows gists and `repository_dispatch`; the e2e drives the CLI through
   a sealed submit against it.
4. **The website**: the loader, worker and service worker in
   `lax-website/assets/site/review/`; the deploy's holding-place
   checkout and copy; the page-builder's subtree extraction. Tests: a
   fixture bundle decrypts and every page of it serves through the
   worker under the site CSP; the deploy copies and removes directories.
5. **Rehearsal** (`scripts/rehearsal/` grows a review variant: a fourth
   scratch repository standing in for `lax-review`, a fifth for the
   holding place): a real sealed submit through the scratch instance,
   the encrypted pages served, the passcode round trip, the delete, the
   expiry job. Measures the real cost per submission. The standing rule
   for Actions-side changes applies with extra weight — this is the
   first workflow the archive runs in a repository authors cannot see.
6. **Production and docs**: the closed repository, the review database,
   the package, two App registrations, the environments, the review key
   pair; README, `assets/instructions.md` ("Private review"),
   spec-notes (the review lifecycle beside the public one), TODO; the
   first real review of a flagship draft, recorded in `history/`.

## Risks and accepted trade-offs

- **The service worker is a hard dependency of the reviewer surface.**
  Without it, a decrypted multi-page site cannot be served from a static
  host without rewriting every link and inlining every asset. The
  fallback is the PDF alone. Corporate browsers that block service
  workers exist; the plan accepts them as the price of running no
  server.
- **Two more App registrations and a closed repository** are real
  operational surface for a two-maintainer project. They are the
  minimum that keeps every key out of every job that executes code and
  keeps authors out of the closed repository.
- **The review key is long-lived and decrypts history.** Rotation
  yearly with a grace period, and the archived ciphertext re-sealed to
  the new key by the rotation job, so an old key can be destroyed.
- **The larger runner is a cost decision made by memory, not by
  choice.** If stage 0 finds that the standard private runner validates
  a real submission within its 7 GB, the cost halves and the free
  allowance applies.
- **A review record cannot be cited or depended on,** and two review
  drafts cannot depend on each other. Co-submitted papers that build on
  each other put both in one submission for review, or make the base
  public first.
- **`registered` is absent for review records** by design; a review is
  a draft with a passcode. Endorsements and ORCID review live on the
  public side, after promotion.

## Open questions for Jan

1. One Review Publisher App with four installations, or four
   registrations under the one-App-one-repository doctrine?
2. Retention: 180 days from the last submit, extended by resubmitting?
3. The larger runner from the start, or run stage 0's memory
   experiment first and decide by the number?
4. Should `lax review submit` refuse a folder whose manifest lacks
   `anonymous: true` unless `--named` is passed, since the pages will
   carry the authors' names into a double-blind process otherwise?
