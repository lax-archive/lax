# Private submissions — plan

Status: designed 2026-09-14 (Jan and an agent session). Version 3 of the
same day, after two rounds of independent review — security red team,
codebase fit, GitHub platform facts, author and reviewer usability, then
a second security round and a coherence pass on version 2. "What the
reviews changed" at the end records what moved. Nothing is implemented.
Facts marked *verify* are assumptions until the stage-0 spike confirms
them; each has a named fallback.

**One decision precedes stage 0**: whether the archive may run one
stateless Worker. The plan below is the no-server design. "The Worker
alternative" near the end describes what changes if the answer is yes,
and recommends it.

## The problem

Conference peer review needs a draft that only its reviewers can read.
Every surface of the archive is public by construction: the database
repository, the source it points at, the captures on ghcr, the Actions
logs and artifacts of the control plane, and the website. A formalization
under review has no home in the archive today.

What a reviewer needs is the submission's website pages — concept cards,
statements with their proven and unproven marks, the proof list, the paper
with its marked passages — behind a passcode, produced by the archive's
own validation so the verdict carries the archive's trust and not the
author's word. What the author needs is to get there without granting the
archive access to a private repository, without the archive running a
server, and from a plain folder if that is where the work lives.

## Terms

| term | meaning |
| --- | --- |
| review record | a submission living in the review database, never in the public one |
| review instance | the deployment of the unchanged pipeline that validates review records |
| closed repository | `lax-archive/lax-review`, private, where the review instance runs |
| review database | `lax-archive/lax-review-database`, private |
| review package | `ghcr.io/lax-archive/lax-review-captures`, private |
| pages repository | `lax-archive/lax-review-pages`, public, a GitHub Pages site |
| review origin | `https://review.laxarchive.org`, served from the pages repository |
| review key pair | the X25519 key the CLI seals to and the unseal job opens with |
| command | one `/lax review …` comment on a review issue |
| envelope | the plaintext part of a command |
| box | the sealed part of a command |
| token | a record's stable URL segment on the review origin, public |
| passcode | the reviewer credential; the only secret a reviewer holds |

## Decisions

The one-way doors. Everything else follows from them and can be revised.

1. **A second instance, not a second backend.** Review validation runs
   the unchanged pipeline (`src/submission-validation/`, the same
   publisher, the same page-builder) as a second deployment of the code
   in the open repository. All logic stays in `lax-archive/lax`. The
   constants module already parameterizes control, database, website,
   captures and site URL by environment variable, and `scripts/rehearsal/`
   already stands up a whole instance that way.
2. **Execution in one closed repository, because GitHub's privacy unit
   is the repository.** Logs, artifacts, caches and step summaries
   inherit the repository's visibility, and every one of them carries
   plaintext during a validation. The closed repository holds a short
   workflow that checks out `lax` at a pinned commit, the protected
   environments with the keys, and nothing else. Validating inside the
   open repository would mean muting every transcript, encrypting every
   artifact and suppressing every annotation — deny-by-enumeration, the
   defect class `history/audit-20260903.md` names — with the decryption
   key in a job that executes submission code, which trust rule 1 forbids.
3. **Lax never reads the author's repository.** No GitHub App on author
   repositories. Transport is a tar the CLI packs from any folder,
   encrypted under a content key that is sealed to the review key pair,
   deposited where a lax job fetches it anonymously. Git and plain folders
   are the same case.
4. **The public control repository is the only author-facing input.**
   Commands are comments on public issues in `lax-archive/lax`, checked
   by the public route job from public data before any run starts, and
   written to by lax only in the two ways it writes today: the run link
   appended to the command comment, and a refusal comment when the route
   job declines. Authors never see, join or touch the closed repository.
5. **Results and pages come from the review origin, a static public
   site of encrypted files.** The review instance publishes each record's
   encrypted bundle and report, and a small plaintext outcome file per
   command. The CLI polls the outcome; the reviewer opens the token's URL.
   No result is ever posted to the issue, so the review instance holds no
   token for `lax-archive/lax`.
6. **Confidentiality of content, not anonymity of authorship.** Source,
   pages, report and passcode are never public in the clear. The
   existence and timing of a review are public: the author's account
   opened an issue with a review marker, hidden markers are indexed by
   issue search, and the pages repository's commit times join exactly to
   the public route run. The plan does not promise double-blind and tells
   authors so; a throwaway account is the mitigation. Tokens are
   enumerable from the pages repository and are not secrets; the
   passcode is.
7. **Same id space, same schemas, no visibility field.** A review record
   uses the id `lax init` generated locally and the public record shapes
   with one documented extension. It lives in the review database until
   promotion or expiry; the expire job removes review records whose id
   has appeared in the public database, so the two overlap for at most
   one expire cycle, and no record anywhere says which database it is in.
8. **Promotion is the ordinary public submit**, spelled out for a
   plain-folder author in the instructions (below).
9. **The reviewer surface is the existing site, encrypted at rest**,
   rendered by the review instance with the page-builder `lax serve`
   uses, encrypted under the passcode, decrypted in the browser and served
   by a service worker from a static host on its own origin. GitHub Pages
   cannot be private below Enterprise Cloud, and the archive runs no
   server.
10. **Review records may require public records; nothing may require a
    review record.** Resolution runs against the public snapshot; a
    review record's source is ciphertext, so no lakefile can pin it. The
    validate job therefore never needs the review package.

## The path

```
author           lax-archive/lax (public)        closed repository                              pages repository → review origin
──────           ────────────────────────        ─────────────────                              ───────────────────────────────
lax review ────▶ issue + command ───▶ route ───▶ dispatch ───▶ fetch ─▶ unseal ─▶ validate ─▶ publish ───▶ data branch ─▶ deploy ─▶ /<token>/
  submit                                                                                                                  ▲
    └───────────────────────────────── polls /o/<sha256(comment id)>.json ────────────────────────────────────────────────┘
```

| step | where | holds | executes submission code | does |
| --- | --- | --- | --- | --- |
| CLI | author machine | user token, review public key | — | local build unless `-f`; pack; encrypt; upload ciphertext to a secret gist; post the command |
| route | `lax`, public | `GITHUB_TOKEN` | no | envelope checks, opener/owner check from the thread, abuse caps, refusal comment or run link |
| dispatch-review | `lax`, environment `lax-review-dispatch` | Review Dispatcher key | no | `repository_dispatch` with issue and comment id |
| fetch | closed, no environment | nothing | no | re-read issue and comment as data; repeat the owner check; fetch the gist commit; check ciphertext digest and size; upload ciphertext artifact |
| unseal | closed, `lax-review-unseal` | review private key, session key | no | open the box; check associated data; stream-decrypt to a plaintext tar; check its digest; upload the tar; upload the session file (token, passcode) encrypted under the session key |
| validate | closed, no environment | nothing | **yes** | extract with the hardened extractor; the unchanged pipeline; restore cache, never save |
| publish-review | closed, `lax-review-publish` | database key, pages key, session key | no | preflight; token index; stale-write check; review database; review package; render; encrypt; push to the pages repository's data branch |
| report-review-failure | closed, `lax-review-publish` | same | no | on any failed job: the outcome file, plus the encrypted report when validation produced one |
| expire, cache-save | closed, scheduled | as needed | no | retention, promoted ids, history squash of the data branch; provision and save the toolchain cache before any submission code exists in that run |
| deploy | pages repository | Pages | no | copy data files under validated names; add the loader from a pinned `lax-website`; deploy |

## Components

### The review issue and its commands

A review issue is an ordinary issue in `lax-archive/lax` whose body is
the single hidden marker `<!-- lax-review -->` and no id. The CLI creates
it on the folder's first `lax review submit` and records the number in
the folder's `.lax-review.json` and in `~/.lax/review/<id>.json`.
Precheck admits the marker beside the submission marker; the route job
branches on it before it loads any public record, since none exists.

Commands:

```
/lax review submit  <envelope-json> <keyId>.<box>
/lax review reseal  <envelope-json> <keyId>.<box>
/lax review owners  <numeric ids, comma separated>
/lax review extend
/lax review delete
```

| field | where | submit | reseal |
| --- | --- | --- | --- |
| verb | envelope | ✓ | ✓ |
| gist id and commit | envelope | ✓ | |
| ciphertext digest, bytes | envelope | ✓ | |
| content key | box | ✓ | |
| plaintext digest | box | ✓ | |
| token | box | ✓ | ✓ |
| passcode | box | ✓ | ✓ |

The box is sealed to the review public key with **associated data** the
unseal job re-derives from the comment it re-read through the API: the
issue number, the commenter's numeric id, the key id and the verb. A box
copied to another issue or posted by another account fails to open.
Replay by the same account on the same issue is caught by the stale-write
rule: the review record stores the highest comment id it has processed,
and the publisher refuses any command with a lower or equal id — trust
rule 2's stale-write check on the review side. This also covers a
duplicate webhook delivery and a re-run of the route job.

**Authorization is derived from the public thread alone**, in plaintext,
so the route job can refuse before a run exists and the fetch job can
repeat it credential-free: the issue's opener, plus the numeric ids in
the opener's most recent `owners` comment, which must include the opener.
Accounts are resolved by numeric id, never by handle. No job consults a
database to authorize; the review database's `owner-list.json` is
informational.

The route job's refusals (not an owner, over a cap, kill switch) are the
short refusal comments it posts today. Its run link is appended to the
command comment as it is today. Those are the only two things lax ever
writes to a review issue; the thread is the audit log of commands.

### Cryptography

All `node:crypto`, no dependency.

| piece | construction |
| --- | --- |
| box | X25519 ephemeral agreement with the review public key, HKDF-SHA256, AES-256-GCM, associated data as above; key id in the comment |
| content key | random 256-bit AES-GCM key per upload; the tar encrypted in chunks with the chunk index as associated data, so truncation or reordering fails closed |
| token | 128 random bits, base32, chosen by the CLI on the record's first submit, fixed for the record's life |
| passcode | six words from a 7 776-word list (77 bits), generated by the CLI, never author-chosen |
| page key | scrypt over the passcode with a random salt; AES-256-GCM over the tar of rendered pages |
| session file | token and passcode from unseal to publish, AES-256-GCM under a session key held by both environments and by nothing else |
| review key pair | X25519, private half in `lax-review-unseal`; rotation is a CLI release with a grace period; nothing is archived under it, so an old key is simply retired |

The unseal job does parse attacker-authored bytes: anyone can seal a
valid box to the public key. The box is bounded by the comment size and
parsed by the same exact-shape parsers the public plane uses; that is the
whole exposure of the key-holding job.

### The tar

A deterministic ustar writer in the CLI (`src/shared/review-pack.ts`):
sorted entries, zero mtimes, fixed ownership, a per-file sha256 manifest.
The existing `sealCapture` runs GNU tar inside the container and cannot
serve the author's machine; its inventory rules (`inventoryFiles`, to be
exported) apply before packing: no symlinks, no non-regular files, the
review tar cap. Contents are the folder minus `.lake/`,
`build-output.json`, `paper.pdf`, `paper-web.tar` and `.lax-review.json`.
The CLI's packer is the format authority; the unseal job recomputes the
digest over the bytes it decrypts; the validate job extracts with the
capture materializer's extractor lifted to a host-callable module —
rejects `..`, absolute paths, links, devices and duplicates, enforces the
caps during extraction.

`.lax-review.json` joins `LAX_GENERATED_FILES.root`, so a tracked copy is
a static-gate violation on both the local and the trusted path, for
existing folders as well as new scaffolds. It holds the issue number and
token only; the passcode lives in `~/.lax/review/<id>.json`.

The static gate gains one warning for review runs: author names from the
manifest found in Lean comments, `.tex` or `.bib` files, since
`anonymous: true` hides the manifest's names and nothing else.

### The gist

The CLI creates a secret gist with `POST /gists` (`public: false`), the
ciphertext as base64url in files of the gist file size (a stage-0
constant; the API documents no upload cap), and records the gist's git
commit from the response. Secret gists are unlisted but fetchable by URL
and are git repositories; an unadvertised commit fetches anonymously by
SHA (*verify* for a secret gist; confirmed for a public one). Git push to
gists with App user tokens is reported broken and is not used.

The fetch job validates the URL with a gist-specific check admitting only
`https://gist.github.com/<hex>` and calls `checkoutRemoteCommit` with
`maxDepth = 1` (no deepening) in a size-limited workspace; the global
`validateRepositoryUrl`, which lakefiles also pass through, is untouched,
so no lakefile can ever require a gist. The CLI App gains the user
permission `Gists: write` and nothing else; existing logins re-authorize
once. The CLI deletes the gist when the outcome arrives. Nothing archives
the ciphertext: a review record is never revalidated — the author
resubmits, which is cheap and needs no stored key.

Fallbacks if stage 0 refutes the gist path: chunked comments (48 KB of
base64 each; source-only submissions) or a transient fork and pull
request against a public inbox repository (needs repository
administration on the author's account).

### Route, dispatch, and the abuse caps

The route job, on a review issue: envelope shape and size, the
opener/owner rule, then the caps — the commenter's account age, review
commands from this account in the last day, a global daily budget counted
only over commands that passed the owner rule, the envelope's `bytes`
against the review tar cap, and the `LAX_REVIEW_OFF` kill switch. Jan
sets an Actions spending limit on the organization before stage 6.

`dispatch-review`, in environment `lax-review-dispatch`, mints a token
for the **Review Dispatcher** App — installed only on the closed
repository, `Contents: write`, no `Workflows` permission, excluded from
the closed repository's branch-protection bypass list — and sends a
`repository_dispatch` carrying the issue number and comment id. The
payload cap is 64 KB and comments are not, which is one more reason the
closed repository re-reads the comment itself.

### The closed repository

One workflow, `review.yml`: `on: repository_dispatch` for commands and
`on: schedule` for the housekeeping jobs. Every job checks out
`lax-archive/lax` at a commit pinned in the workflow file and builds it
with `.github/actions/setup-lax`. The pin lives on a protected default
branch, the branch the environments deploy from; environment reviewers
are Enterprise-only on private repositories, so branch protection is the
control. Every pipeline-affecting release of `lax` owes a pin bump, or
review verdicts diverge from public ones — a standing chore in TODO.

Job routing by verb, from the fetch job's parsed envelope: `submit` runs
every job; `reseal` runs fetch (metadata only), unseal and publish;
`owners`, `extend` and `delete` run fetch and publish. `reseal` re-reads
the record's stored rendered tar from the review package and re-encrypts
it under the new passcode.

The Actions cache: `validate` restores the toolchain and warm-store entry
and never saves; the scheduled `cache-save` job provisions and saves it
in a run that executes no submission code. `permissions: {}` does not
govern cache writes — `actions/cache` uses the runtime token — so the real
invariant is the container's environment allowlist keeping that token
from submission code, as today, plus a hash manifest of the saved store
committed to the protected branch that `validate` checks after restore.
Stage 0 *verifies* whether a `repository_dispatch` run can write the
cache at all. Artifact retention is one day.

The review package holds captures, papers, web bundles and rendered-page
tars, digest-addressed through a new general blob method in
`capture-store.ts` beside the capture-specific `promote`. Only
`publish-review` reads or writes it, with the job's `GITHUB_TOKEN` after
the package grants the closed repository access.

### The publisher Apps

| App | installed on | permission | held by |
| --- | --- | --- | --- |
| Review Dispatcher | closed repository | `Contents: write` | `lax-review-dispatch` in `lax` |
| Review Database Publisher | review database | `Contents: write` | `lax-review-publish` |
| Review Pages Publisher | pages repository | `Contents: write` | `lax-review-publish` |

Two publisher registrations, though one job holds both, so that either
can be revoked or rotated alone and so that the pages key can never touch
the database. What actually protects the review origin is the deploy: it
serves nothing the publisher pushed as HTML or script (below).

### The review database

The public three-file layout per id. `record.json` carries no `source`
triple; it carries

```json
"sealedSource": { "digest": "<sha256 of the plaintext tar>", "bytes": 1234567 },
"review": { "token": "<base32>", "lastCommentId": 123456789, "expiresAt": "2027-03-13T00:00:00Z" }
```

`build-output.json` is the public shape; its `issue` block binds the
review issue as a public record binds its issue, so `record-gates.ts` and
the publisher's issue checks apply unchanged. The capture gains
`sourceDigest` as an alternative to `sourceCommit`, whose parser demands
40 hex characters. States are `draft` and `deleted`; `registered` does
not exist for review records and `lax register` refuses them. A
`tokens.json` at the database root indexes token → id; the publisher
refuses a `submit` whose token belongs to another id, and a `submit` for
an existing unexpired record whose token differs — first writer wins, and
a co-owner's fresh `~/.lax` inventing a second token is refused rather
than accepted. `archive-schema.ts` and `artifact-schema.ts` get a review
mode for these divergences. The website loader and `lax serve` never see
this database.

### The validation seam

`ValidationRequest.source` becomes a union: the git triple as today, or
`{ kind: "directory", digest }`, meaning the caller has placed the tree at
the job's source directory and vouches for it by digest. `fetchSource` has
one call site, in `pipeline.ts`, and `ValidationOptions.local` already
injects an on-disk tree past the fetch for the host path; the
request-level kind lets `run.ts` do the same. Siblings for the digest
where `source.commit` is read today: the paper's `SOURCE_DATE_EPOCH`
(from git today; the tar's fixed epoch for a directory source), the
capture's `sourceCommit`, the capture tag and promote checks in
`capture-store.ts`, and the source-triple comparisons in
`submit-publisher.ts`. Nothing else changes.

### Rendering and the bundle

The publish job loads a pinned public database snapshot plus the review
record and calls `generateSite` as `loadWebsiteSubmissions` does for a
local folder, with a renderer option `review: true` that (a) omits the
comments and citation scripts and their CSP origins, so no script on a
review page posts its URL anywhere, and (b) writes links to other records
as absolute `https://laxarchive.org/lax-N/…` URLs, so no relative link
leaves the bundle and no service-worker redirect is needed. From the
output it keeps `<id>/`, `assets/` and the content-hashed `fonts/` the
reflow page emits at the root — the bundle is self-contained and the
review origin never loads a script from the public site — and discards
every page that would name the record.

The subtree is tarred and encrypted under the page key. What the
publisher pushes to the pages repository's `data` branch, all under
`<token>/`: `bundle-<digest>.enc`, `report-<comment id>.enc` (the
validation report under the same key), and `current.json`, plus
`o/<sha256(comment id)>.json` at the root. Pushes are compare-and-swap
ref updates as in `archive.ts`; `current.json` is refused when its
comment id is not higher than the one already there, so an older run
cannot overwrite a newer one.

```json
o/<h>.json:       { "commentId", "verb", "outcome": "published|failed|refused", "reason"?, "bundle"?, "reportDigest"?, "at", "expiresAt"?, "pageBuilder" }
<token>/current.json: { "bundle", "commentId", "expiresAt", "pageBuilder" }
```

`outcome` and `reason` are plaintext and non-sensitive ("digest
mismatch", "not an owner", "validation failed"); the CLI takes the verdict
from the decrypted, GCM-authenticated report, never from the outcome
file. Failures before unseal have no passcode to encrypt with and carry
only the reason. The rendered-page tar is stored in the review package so
`reseal` re-encrypts without re-rendering.

### The pages repository and the review origin

A public repository serving `review.laxarchive.org` through GitHub
Pages. Its own origin, because the public site renders author content and
one origin would let a script there read an unlocked review in the same
profile; Pages cannot send the headers that would isolate them. The 1 GB
Pages cap is then the review service's own budget.

The `data` branch is the publisher's. The daily `expire` job squashes it
to a single orphan commit, and `delete` and `reseal` trigger the same
squash, so a removed or re-encrypted bundle leaves git history within a
day, not never. Its deploy workflow, on every push to `data` and hourly:
check out a pinned `lax-website` revision for the loader files; copy each
token directory whose name is exactly fixed-length base32 and whose files
match `bundle-<hex>.enc`, `report-<digits>.enc`, `current.json`, plus the
`o/` files, and nothing else; lay `index.html`, `loader.js` and `sw.js`
beside each; refuse a `pageBuilder` that does not match its own pin;
enforce the per-record byte budget, which the publisher already enforced,
and never evict another record; deploy.

### The loader

`index.html` (with `noindex` and `referrer: no-referrer`) asks for the
passcode, derives the page key in a Web Worker, decrypts and untars the
bundle in memory, registers `sw.js` scoped to `<token>/`, and navigates to
the submission page. The worker answers in-scope fetches from the
decrypted files with the right content type, `nosniff`, no-referrer and
the site's own CSP on every synthesized document; it fetches nothing
cross-origin. The key lives in the worker for the tab session; a reload
asks again. Browsers without service workers, and Safari private mode,
get the decrypted PDF as a download and a note that the concept and proof
pages need a regular browser. The plan accepts that this fallback loses
the reviewer surface.

### The CLI

- `lax review submit [folder]`: everything above; then follows the
  public run through the appended run link as any command does, polls
  `o/<h>.json` for its own comment id with a 90-minute timeout, prints
  the URL and passcode, and renders the decrypted report's findings with
  the renderer `lax build` uses. `--resume` reattaches from the folder or
  `~/.lax`. `-f` skips the local build. Before doing anything it says
  that a private validation takes up to 45 minutes and that the URL and
  passcode stay the same across resubmits.
- `lax review status`, `owners`, `extend`, `reseal`, `delete`, and
  `share`, which prints what a co-owner needs (issue, token, passcode).
- Local state: `.lax-review.json` in the folder (issue, token) and
  `~/.lax/review/<id>.json` (issue, token, passcode). Losing both loses
  the passcode; `reseal` from an owning account sets a new one.

**Promotion for a plain-folder author**, in `assets/instructions.md`:
create a public repository, `git init`, commit, push, `lax submit` (binds
the public issue and asks for the binding to be committed), commit, push,
`lax submit` again. `lax submit` on a folder with a review record says so
and continues. A reviewer who learns the id from the pages could `lax
submit` junk under it first; the remedy is `/lax admin owners` to the true
author and `reset-draft`, never `delete`, since a deleted id can never be
initialized again.

### Retention and admin

Records, blobs and pages expire 180 days after the last submit or
`extend`, with a hard ceiling of 365 days from first submit. The
scheduled `expire` job also removes review records whose id exists in the
public database. Admin verbs are plaintext `/lax admin review delete|
extend <issue>` from `ADMIN_GITHUB_IDS`, bypassing the owner rule in
route and fetch, and `list` in the maintainer driver over the review
database; `LAX_REVIEW_OFF` is the kill switch.

## Trust analysis

Trust rule 1 is intact: `fetch` and `validate` hold nothing; `unseal`
holds the review key and touches ciphertext and a bounded JSON envelope;
the publish jobs hold App keys and execute nothing; the dispatcher's key
can only start review runs. Trust rule 2 is repeated where plaintext
first exists — the closed repository re-reads the issue and comment
through the API, authorizes by numeric id from the thread, binds the box
to that thread, and applies a stale-write check by comment id before any
write. Trust rule 4 holds: the CLI holds the author's user token and a
public key.

What the design accepts:

- **Lax reads the author's source**; the key that can is one X25519 key
  in one environment, and nothing is stored under it.
- **Ciphertext, tokens, existence and timing are public.** Authors who
  need to hide the last two use a throwaway account, and the
  instructions say so.
- **The passcode is brute-forceable offline** at one scrypt evaluation
  per guess; 77 bits is out of reach.
- **One review origin, many tokens.** A hostile review page cannot read
  another token's unlocked pages unless the reviewer has both open in one
  profile and the hostile page scripts the other's document; the worker
  answers only in-scope requests with the site CSP attached, which is the
  most a static host can do.
- **Runs cost money and any account can post a comment**; the caps and
  the spending limit bound the bill, not the nuisance.
- **A review record cannot be cited, depended on, registered or
  revalidated.**

## Cost

Rates and limits from GitHub's documentation on 2026-09-14; stage 5
measures the real per-run number.

| item | figure |
| --- | --- |
| GitHub Team plan, required | $4 per seat per month; every organization member is a seat |
| three maintainer seats | $12 per month |
| validate job, longest observed | about 30 min |
| fetch, unseal, publish, render | about 10 to 15 min |
| standard private Linux runner, 2-core, 8 GB, 14 GB disk | $0.006 per min |
| larger Linux runner, 4-core, 16 GB, 150 GB disk | $0.012 per min |
| per submission, larger runner | about $0.55 |
| per submission, standard runner, if it fits | about $0.27, within 3 000 included minutes |
| artifact storage past the plan quota | $0.25 per GB-month; retention one day |
| Actions cache | 10 GB per repository, free |

The Team plan is a precondition: environments, environment secrets and
deployment-branch restrictions in a private repository, and larger
runners, are unavailable on Free. Larger runners never draw on included
minutes. The pipeline runs two Lean workers under a 16 GiB container cap
(`history/oom.md`); stage 0 measures whether a real submission validates
on the 8 GB standard runner with one worker.

## Constants stage 0 fixes

| constant | owner | note |
| --- | --- | --- |
| review tar cap | route, fetch, validate | from real submissions; well under the public 2 GiB |
| gist file size | CLI, fetch | API upload limit, measured |
| chunk size | CLI, unseal | 1 MiB unless measured otherwise |
| scrypt parameters | publish, loader | about one second on a laptop, a few on a phone |
| per-record byte budget, Pages total | publish, deploy | against the 1 GB cap |
| retention, ceiling | expire | 180 and 365 days |
| caps: account age, commands per day, daily budget | route | |
| polling timeout | CLI | 90 minutes |

## Stages

Each stage lands with its tests and is independently useful; nothing
before stage 5 touches production, except the CLI App's `Gists: write`
permission, which stage 5's real submit needs and is added in stage 3.

0. **Spike** (`spike/review/`, throwaway; `REPORT.md` holds verdicts):
   `POST /gists` with a `Gists: write` user token and its file size;
   anonymous `git fetch --depth 1` of an unadvertised commit of a
   *secret* gist; `repository_dispatch` into a private repository; whether
   such a run can write the Actions cache; whether the standard private
   runner validates a real submission; a loader and service-worker
   prototype on Chrome, Firefox and Safari over a real `lax serve` render
   with the absolute-link option; the review origin's Pages deploy; the
   constants table.
1. **Cryptography and the tar** (`src/shared/sealed.ts`,
   `src/shared/review-pack.ts`): boxes with associated data, chunked
   content encryption, the page key, the session file, the ustar writer,
   `inventoryFiles` exported, the extractor lifted to a host module.
   Fixed test vectors; a folder round trip; CLI tar and unseal digest
   agree; chunk truncation and reorder fail closed; extractor caps.
2. **The seam and the record shapes**: the `directory` source kind and
   its siblings; `sealedSource`, `review`, `tokens.json` and
   `sourceDigest` in the two schema modules; `.lax-review.json` in the
   generated-files list; the gist-only URL check; the general blob method
   in `capture-store.ts`. The fake-runner suite gains a directory-source
   case; the host e2e proves the same report for a git source and its
   directory copy.
3. **Workflows and CLI, outcome and report only**: review marker and
   `dispatch-review` with the caps and refusals in `submission.yml` and
   `control-plane.ts`; `review.yml` and `src/workflows/review.ts` (fetch,
   unseal, validate wiring, publish-review without pages, failure
   reporter, expire, cache-save); the CLI verbs and local state; the
   rehearsal patcher and `workflow-definition.test.ts` made mode-aware;
   `fake-github.ts` grows gists and `repository_dispatch`; the e2e drives
   a sealed submit and reads the outcome from a fake review origin. Tests
   for associated-data mismatch, replay by comment id, token squatting,
   caps and kill switch, expiry by age and by promotion.
4. **The website**: the `review` renderer option, subtree extraction
   with `assets/` and root fonts, the loader, worker and service worker
   in `lax-website/assets/site/review/`, the pages repository's deploy;
   publish-review gains the bundle and `current.json`. Tests: a fixture
   bundle decrypts and every page serves through the worker under the
   site CSP; no request leaves the origin; the deploy copies only
   validated names and refuses a `pageBuilder` mismatch. Prerequisite:
   the `anonymous`/`unlisted` website work TODO.md already owes.
5. **Rehearsal** (`scripts/rehearsal/` gains a review variant with
   scratch repositories for the closed repository, the review database
   and the pages repository): a real sealed submit end to end, the
   passcode round trip, a failure at minute 30, `owners`, `reseal`,
   `delete`, expiry, the caps, the history squash. Measures cost per run.
6. **Production and docs**: Team plan; the closed repository, the review
   database, the review package with its access grant, the pages
   repository with DNS; three App registrations; environments; the review
   key pair and session key; spending limit and kill switch; README,
   `assets/instructions.md` ("Private review": the promotion steps and
   the anonymity statement), spec-notes, TODO; the first real review of a
   flagship draft, recorded in `history/`.

## Open questions for Jan

1. **The Worker** (next section): yes or no. This decides the shape of
   stages 1, 3 and 4.
2. The Team plan as a precondition, either way.
3. Retention 180 days from the last submit or `extend`, ceiling 365?
4. Insist on `anonymous: true` unless `--named` is passed?
5. Scope: the whole thing, or `lax export` first (alternatives below).

## The Worker alternative

Issues are the right input channel only under the no-server rule: they
are the one thing an arbitrary GitHub account can do to our repository
that both authenticates the actor and starts a workflow. That rule costs
this plan: the envelope-and-box grammar, four jobs before validation, the
gist, the outcome-file ordering, the public metadata, client-side
decryption, the service worker, a separate origin, the 1 GB cap.

One stateless Cloudflare Worker with an R2 bucket, about 300 lines,
removes all of that while leaving the trust core untouched. The CLI
authenticates to it with the author's existing user token, which the
Worker verifies against GitHub. The upload goes into R2; the Worker sends
the `repository_dispatch` with a stored token. The closed repository
fetches the upload from R2, runs the unchanged pipeline, and puts the
rendered pages and report back. The Worker serves the pages behind a
server-side passcode check with rate limiting, and serves status to the
CLI.

| | issues and static pages (this plan) | one Worker |
| --- | --- | --- |
| new GitHub Apps | 3 | 1 |
| jobs before validation | route, dispatch, fetch, unseal | one fetch |
| client-side cryptography | boxes, chunked encryption, scrypt loader, service worker | none, or CLI-side encryption kept as belt and braces |
| public metadata | issue, opener, timing, ciphertext, tokens | none |
| access control | passcode-derived key, offline brute force | server-side check |
| size limits | gist file size, 1 GB Pages | none that matters |
| operated components | none | one Worker, one bucket, one dispatch token outside GitHub |
| monthly cost | Team plan | Team plan; Cloudflare's free tier likely suffices |

Unchanged under both: the closed repository, the review database, the
review package, the Team plan, the validation seam, the render subtree,
trust rules 1 to 5. The Worker never validates and never holds a
database key. It holds the dispatch token and, at rest, the author's
source and pages, as GitHub holds a private repository's.

The no-server doctrine came from `history/oom.md` and the go-live box
stop; its target was a machine running Lean with memory and uptime to
babysit. A Worker is not that. **Recommendation: take the Worker** if
owning a Cloudflare account with one secret in it is acceptable, and
rebuild the intake and viewing halves of this plan on it. If the
doctrine is absolute, this plan is the honest cost of it.

## What the reviews changed

Round 1 (security, codebase, platform, usability), taken into version 2:

- The reply key, `rekey` and any result on the issue are gone; the CLI
  chooses token and passcode once per record; links survive resubmits.
- Boxes are bound to issue, commenter, key id and verb.
- Fetch split from unseal; extraction in the credential-free validate
  job with the hardened extractor.
- Two publisher Apps; a copy-only deploy; a separate review origin.
- Caps in the public route job, a kill switch, a spending limit, a
  Pages budget.
- Team plan, 2026 rates, 8 GB standard runners, indexed hidden markers,
  no git push to gists, 64 KB dispatch payloads.
- The CLI needs its own tar writer; links are relative; `comments.js`
  posts the page URL; `sourceCommit` rejects a digest; `commitTimestamp`
  reads git; the rehearsal patcher asserts exact counts.
- Failure reported at minute 30, `owners`, `extend`, `reseal`, honest
  promotion steps, admin verbs, the pin-bump chore, the anonymity
  statement, the name-leak warning.

Round 2 (security, coherence), taken into version 3:

- A plaintext envelope beside the box, so route and fetch can check
  verb, gist, digest and size, and route by verb.
- `owners` is plaintext and opener-only; the owner rule is checked in
  route before any run and repeated in fetch; co-owners no longer depend
  on decrypting anything.
- Tokens are public; `tokens.json` and first-writer-wins stop squatting.
- Stale-write by highest processed comment id, against re-dispatch
  replay of old `submit`, `reseal` or `delete`.
- Outcome files per comment id at a public path derived from it, so
  failures before unseal report without a token, and `current.json`
  ordered by comment id, so an old run cannot overwrite a new one.
- Ciphertext archiving and the stored content key dropped: review
  records are resubmitted, never revalidated; nothing is stored under
  the review key.
- The bundle carries `assets/` and links out only by absolute URL; the
  service worker fetches nothing cross-origin.
- The `data` branch is squashed daily and on `delete`/`reseal`, so
  removed bundles leave history.
- Gist fetch with no deepening in a size-limited workspace.
- Squatting remedy is `admin owners` + `reset-draft`, not `delete`.
- Per-record byte budget instead of eviction; retention ceiling.
- Passcode only in `~/.lax`; `.lax-review.json` a generated file the
  gate refuses when tracked.
- Session file between unseal and publish; verb-based job routing; the
  expire job handles promoted ids; admin verbs bypass the owner rule.
- Terms, constants and tests tables; stage 3 without pages, stage 4
  with.

Rejected or deferred, with the reason:

- **Per-publish tokens** against stable links: stable wins; bundle
  files are content-addressed and fetched with `no-store`.
- **Per-token isolation on the review origin**: impossible on a static
  host; documented as residual.
- **Serving the id under a neutral name**: package names carry the id
  in every Lean file.
- **Revalidating review records**: would need the ciphertext and content
  key archived under the review key; resubmission is cheaper and stores
  nothing.

Alternatives considered and not chosen, recorded for the scope question:

- **`lax export`**: `lax serve`'s render of the folder written as a
  self-contained static site the author uploads as supplementary
  material, labelled "author-built, archive validation on acceptance".
  About a week, no crypto, no repositories, no Apps, and it uses the
  channel every conference already has. It does not carry the archive's
  verdict, which is the reason this plan exists; it is the cheapest first
  step if that verdict turns out not to be what venues ask for.
- **An unlisted, anonymous public submission from a throwaway
  account**: archive-attested, zero new code once the website flags
  land; but source, captures and pages are public in the clear.
- **Waiting until acceptance**: the honest baseline the instructions
  should state either way.
