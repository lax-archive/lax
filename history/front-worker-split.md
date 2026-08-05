# The front/worker split (2026-07-26/27, reverted)

> **Status: implemented, run in production for one day, and reverted
> (2026-07-27).** The split worked — the shadow phase, the flip, the
> provisioner and the lost-lease failure path all did their job — but it
> was too many moving parts for what it bought: a worker-count bug, a
> worker-type default that never made it to the box (every big Replay
> OOM-killed on a swapless 16 GB worker), clock-skew false alarms, and a
> billing-capable credential on an internet-facing host. Production is
> back to the single box in [DEPLOYMENT.md](../DEPLOYMENT.md) (local
> executor, `LEAN_NUM_THREADS=1`, 16 GB RAM + 32 GB swap); the remote
> executor code was removed from the tree in the same revert (the
> build/submit seam it was built on remains). The likelier next step is a
> GitHub-Actions-hosted build. This document is the complete record: the
> design, how it ran in production, and the revert. Parts of the design
> outlived the split and are live — the build-keyed store
> (spec-notes.md), the ops database and its backup, and the release/pull
> deploy — with DEPLOYMENT.md and spec-notes.md now the authoritative
> text for those; the sections here are their design rationale.

Design doc for the two-machine deployment architecture (2026-07-26), as it
ran on 2026-07-26/27.

## Why split

Three reasons, in increasing order of importance:

- **Cost.** The always-on cpx42 (~€30/mo) is sized for kernel Replay's
  ~8 GB peak, which runs a few minutes per submission. Splitting into a
  tiny always-on front (~€4/mo) plus a big worker created on demand and
  billed hourly (~€0.05/h ≈ a cent per submission) cuts the bill to
  roughly €8/mo total — and, more importantly, makes *bigger* affordable:
  if a future submission needs a 32 GB replay, that is a per-job server
  type, not a doubling of the monthly bill.
- **Security.** Today one machine holds every secret *and* runs untrusted
  author code, separated only by bwrap. After the split, the machine with
  the secrets (db deploy key, ops database, soon ORCID credentials) never
  executes author code at all, and the machine that does holds **zero
  secrets** — it receives only `(id, repository, commit, folder)` and is
  deleted after an idle window. GitHub tokens are verified on the front
  and never travel to the worker. bwrap stays mandatory on the worker as
  defense in depth; a sandbox escape now reaches a throwaway VM and the
  store volume, not the archive's identity.
- **Operations.** A toolchain/mathlib pin bump becomes "warm a fresh store
  directory, test a worker against it, flip config" instead of an in-place
  re-warm on the live box.

## Roles

**Front** (always-on, small — cax11/cpx11 class, no Lean toolchain, no
bwrap): public HTTPS via Caddy exactly as today; GitHub token
verification; the ops database (allowlist, later comments); the job queue
(in-memory, same lossy restart semantics as today); `db.git` + working
clone, the write lock, the GitHub mirror hook and its deploy key; sitegen;
and the **provisioner** that creates and deletes workers through the
Hetzner API.

**Worker** (ephemeral, x86 — must match the architecture the store was
built on; default cpx42, type is front config): created from a small
snapshot (OS, Node, git, bwrap, elan + pinned toolchain, the lax package,
the userns sysctl from DEPLOYMENT.md), attaches the store volume, and runs
a new `lax-server worker` mode: poll the front over public HTTPS for jobs,
run untrusted fetch + the full server pipeline + capture (all existing
code), report the result. **No inbound ports at all** — the worker only
dials out, so its firewall story is "default deny, done". Authentication
to the front is a random per-boot token injected via cloud-init user_data;
the front accepts it only for the worker it just created.

The single-writer design is untouched: one front, one `db.git`, the same
in-process lock. There is also only ever one worker (the store volume
attaches to one server at a time, which matches the already-serial queue).

## State

| where | what | lost if destroyed? |
|---|---|---|
| front disk | `db.git` + clone, ops.sqlite, site, secrets | **irreplaceable** (db mirrored to GitHub; ops.sqlite gets its own backup, below) |
| store volume | warm mathlib workspace(s) + submission captures, i.e. today's `store/` | re-derivable (re-warm + rebuild submissions) but expensive — treat as durable |
| worker snapshot | OS + toolchain + lax package | rebuildable from a recipe script |
| worker disk | job scratch | disposable by design |

The volume holds the *entire* store, keyed per pin as today
(`<toolchain>-<rev>` dirs), so the snapshot stays small (a few GB) and a
pin bump does not rebuild it unless the toolchain itself changes. Workers
mount the volume read-write; the sandbox profiles inside the worker keep
exposing the store read-only to author code, unchanged.

## The store across two machines: keyed captures

Today `promoteCapture` renames the staged capture to `store/submissions/
<id>` *inside* the db write lock, so the store entry and the db record can
never disagree. With the pipeline on the worker and the lock on the front,
that atomicity would need a lock held across network round-trips to a
machine that can die mid-promote — and a promote whose db commit then
fails would leave the store silently disagreeing with the record, which is
exactly the trust-chain poisoning the current ordering exists to prevent.

So instead of stretching the lock, make promotion harmless: **key store
entries by build**. Captures land at `store/submissions/<id>/<captureId>/`
(the job id serves as captureId), the build-output gains a `captureId`
field, and `trustedDepDirs` — which already loads each dependency's
build-output — resolves the store path through it. The flow becomes:

1. Worker finishes the pipeline, promotes its staging dir to
   `<id>/<captureId>` on the volume — **before** reporting, so a
   reported success always has its artifacts in place.
2. Worker reports the result (build output incl. captureId, warnings,
   violations, transcript tail) to the front.
3. Front, under the lock, re-validates owner/mutability exactly as today
   and commits record + build-output. If validation fails, nothing
   references the capture.
4. Unreferenced captures are garbage, not corruption: the worker sweeps
   `store/submissions/` on boot, deleting entries no build-output
   references (it has a db clone, see below) past a grace age.

Re-drafts stop overwriting in place — each build is a new entry and the
old one becomes garbage — which also removes the current
overwrite-vs-concurrent-reader wrinkle. This is the one real
architecture-level code change and has a spec touchpoint (spec-notes.md
entry).

**The worker needs the db.** `trustedDepDirs` and Resolution read records
and build-outputs from a db clone. The job payload carries the front's
current db head; the worker maintains a clone fetched from the front via a
`GET /worker/db.bundle` endpoint (a git bundle of the working branch) —
not from the GitHub mirror, whose background push may lag the head the
front just committed.

## Front ↔ worker protocol

All under `/worker/*` on the public HTTPS endpoint, bearer-authenticated
with the per-boot token (never a GitHub token). Payloads are JSON.

- `POST /worker/poll` — long-poll (~25 s hold) for the next job:
  `{job: {jobId, id, repository, commit, folder, register, dbHead}}` or
  `{job: null, idleMs}` telling the worker how long the front has seen an
  empty queue.
- `POST /worker/result/<jobId>` — terminal outcome: success (build
  output with captureId, warnings) or failure (violations, error,
  transcript tail). The front finishes the job under its lock and answers
  the CLI pollers exactly as today.
- `GET /worker/db.bundle` — git bundle of the db working branch.

Job state on the front stays in-memory and lossy. Two new failure edges,
both resolved by timeouts on the front: a worker that stops polling marks
its running job failed ("worker lost") after a deadline, and a worker
that never comes up fails the queued jobs the same way; CLIs resubmit,
as they already do after a restart.

## Provisioner and reaper (front)

Worker lifecycle: on the first queued job, create the worker (snapshot +
volume attach + user_data with the token and front URL); leave it polling
while jobs keep arriving; delete it after ~20 min of idle queue (boot
thrash is worse than 20 idle minutes at ~€0.05/h). Creation from snapshot
plus volume attach is roughly a minute — a cold submit goes from ~1 min
to ~3 min wall clock, which the polling CLI absorbs without changes.

Two safety nets, because a front crash mid-provision otherwise leaks a VM
that bills forever:

- **Reaper** (systemd timer on the front, hourly): delete any server
  labeled `role=lax-worker` older than a max age (6 h), detach the volume
  if left attached.
- **Billing alert** in the Hetzner console, and the project kept dedicated
  to lax so the API token's blast radius is bounded.

The Hetzner API token is the one new secret: it can create servers (=
spend money) and touch the volume. It lives beside the deploy key in
`/home/lax/secrets/` on the front (never under `/etc` — see DEPLOYMENT.md
on what the sandbox can read; moot on the front, which runs no sandbox,
but the rule keeps its teeth). The front is also where the ORCID client
secret will live for the comment section — same reasoning: the machine
that holds it never runs author code.

## Ops database (allowlist now, comments soon)

A single SQLite file on the front (`<home>/ops.sqlite`) via the built-in
`node:sqlite` — no new dependency, no server process, single-writer like
everything else here. (On Node 22 the module is behind
`--experimental-sqlite`; stable in current Node — bump the box's Node
when convenient rather than adding a dependency.)

- **Now — allowlist:** a `handles` table gating the write endpoints
  (create, submit) right after token verification, with a clear rejection
  telling non-listed users how to request access. This ships on the
  *current* box first; it does not wait for the split. Deliberately not
  in `db.git`: that repo is the public, citable archive — operational
  admin state (and one day moderation state) doesn't belong in a public
  mirror.
- **Soon — ORCID-authed comments:** comments are relational, mutable,
  and moderatable — the opposite of the append-only archive — so they go
  in the same SQLite file (`comments`: record id, ORCID iD, display
  name, body, created, state), written by the front only. ORCID's public
  API OAuth (authorization-code flow, free tier) gives a verified ORCID
  iD; client id + secret live in `/home/lax/secrets/`. The static site
  gains a progressively-enhanced comment block per record that fetches
  from a small front API; core navigation stays JavaScript-free per the
  existing sitegen stance. Full design when the feature is scheduled —
  the decision folded in *now* is only where the data lives.
- **Backup doctrine update:** `ops.sqlite` joins `db.git` as
  irreplaceable state, but it does *not* get the db mirror's treatment.
  A nightly systemd timer dumps it to SQL text and uploads it to a
  **private Hetzner Object Storage bucket** (`lax-ops-backup`, versioning
  on, a lifecycle rule expiring noncurrent versions), with S3 credentials
  in `/home/lax/secrets/rclone.conf`. Not a private git repo, which was
  the first plan: this file will hold ORCID comments, and a git history
  is immutable and third-party, so honouring a deletion request would
  mean rewriting the history of the backup itself. A bucket deletes when
  told to and stays in the same project as the box. History comes from
  object versioning, so the key is stable (`ops.sql`) and restore is one
  fetch.

## Code changes (seams, not a rewrite)

- **Executor seam:** split `runSubmitJob` at its existing boundary. The
  untrusted half (sandboxed fetch → `runServerPipeline` →
  `captureSubmission`/promote) becomes the worker job; the trusted half
  (owner/mutability re-validation → db commit → mirror push → sitegen)
  stays on the front. A `local` executor runs both in-process — today's
  behavior, the default, what tests and `LAX_E2E` exercise unchanged — a
  `remote` executor puts the queue + protocol between them.
- **Keyed captures** as above (`store.ts`, `trustedDepDirs`, build-output
  schema, boot-time GC).
- **`lax-server worker`** mode: poll loop + db-bundle sync around the
  existing pipeline code.
- **Front-mode preflights:** `serve` with the remote executor must not
  require elan/lake/bwrap (`src/server/main.ts`) — the front runs none of
  them. The bwrap-mandatory rule moves to the worker mode, unweakened.
- **Provisioner + reaper:** one small module against the Hetzner REST
  API, plus a systemd timer. This is deliberately the only
  provider-specific code in the system.
- **Allowlist check** in the write routes + the SQLite wrapper.

## Runbooks

**Snapshot build** (scripted, rerun on toolchain change or lax release —
though workers `npm i -g` the front-pinned lax version at boot, so
routine releases need no new snapshot): create a builder server from
plain Ubuntu 24.04 → userns sysctl, Node, git, bwrap, elan + pinned
toolchain for user `lax`, worker systemd unit → snapshot (label it with
toolchain + lax version) → delete builder.

**Volume (re)warm** (first setup and every mathlib/toolchain pin bump):
boot a worker manually with the volume attached, run `lax-server warm`
against it into the new `<toolchain>-<rev>` dir, smoke-test one
submission end to end, then flip the front's pin. Old pin dirs are
garbage-collected later (existing TODO item).

**Release and deploy (decided 2026-07-26; sized for two maintainers and
a daily cadence).** The published `lax-archive` package is the deploy
artifact — the same immutable thing users install, which keeps the
founding one-codebase property end to end and makes "what is live" a
version number. Two halves:

- **Release = CI on a git tag** (GitHub Actions): run the fast suite,
  then publish to npm via OIDC trusted publishing — no npm token on any
  laptop or in any secret store, provenance attached, and no release can
  come from an untested working tree. This is the two-maintainer
  property that matters.
- **Deploy = the front pulls.** A systemd timer (~2 min) compares the
  npm dist-tag `production` against the installed version; on change it
  waits for the job queue to drain, `npm i -g` the tagged version, and
  restarts. Deploying is `npm dist-tag add lax-archive@<v> production`;
  rollback is moving the tag back. Workers install the same tag at boot,
  so one pin moves the fleet. There is deliberately **no deploy
  credential anywhere**: GitHub holds no SSH key to production, and a
  maintainer deploys daily without production SSH at all — the gate is
  npm publish rights, which are 2FA'd and already security-critical
  (they ship code to every user). Push-style CI-over-SSH was rejected
  for exactly that reason: it creates the strongest secret in the system
  to replicate what the dist-tag already expresses.

Break-glass: the manual ssh + tarball install (DEPLOYMENT.md recipe),
also the path for testing an unpublished build on a real box.

**Provisioning:** the front's setup (packages, sysctl, `lax` user,
systemd units, Caddy config, secrets dir skeleton) lives as an idempotent
`deploy/provision-front.sh` beside the existing `deploy/Caddyfile`,
written and first exercised by migration step 5 below — which thereby
doubles as the disaster-recovery drill: a dead front is provision +
restore `db.git`, `ops.sqlite`, and secrets.

**Worker debugging:** `hcloud server list -l role=lax-worker`, SSH via
the provisioner-injected key, `journalctl -u lax-worker -f`. Or set the
front's idle timeout high and keep one alive.

## Costs (Hetzner, rough)

| item | ~€/mo |
|---|---|
| front cax11 (2 vCPU ARM, 4 GB — no Lean, ARM is fine; cpx11 x86 ~€4.6 if any native dep ever objects) | 3.8 |
| store volume 50 GB | 2.4 |
| worker snapshot (compressed, few GB) | 0.5 |
| worker hours (cpx42 ~€0.05/h; even 100 submissions/mo ≈ €1) | ~1 |
| **total** | **~8** |

Versus ~€30/mo today, and the ceiling on per-job machine size is gone.

## Why Hetzner (and not GCP)

Considered and rejected (2026-07-26). GCP is neither cheaper nor easier
*for this design*: the sandbox needs real VMs with unprivileged user
namespaces, so the managed platforms that are GCP's actual selling point
(Cloud Run etc.) are off the table, and plain GCE VMs at 16 GB run
3–4× Hetzner's price before egress (billed there, 20 TB included here).
The other managed temptation — Cloud SQL — is answered by `node:sqlite`
at €0. Meanwhile the current box, hardening, DNS, and runbook are already
on Hetzner. The design keeps provider lock-in to the one provisioner
module; if Hetzner ever sours, that module is the porting surface.

Also rejected: packaging any of this in Docker. Snapshot-based bare-metal
workers avoid the container-vs-user-namespace fight entirely (bwrap needs
unprivileged userns, which container confinement blocks by default), and
the front is a plain Node process behind Caddy — a systemd unit each is
the whole packaging story.

## Migration from the current box (no switchover day)

1. **Allowlist + ops.sqlite** on the current box (independent, ships
   first).
2. **Executor seam** refactor, `local` mode — behavior identical, tests
   green, deployed as a routine upgrade.
3. **Worker path in the shadow:** keyed captures, worker mode,
   provisioner. Create volume + snapshot, warm the volume, run a manual
   worker against the *live* front in remote mode; the big box itself is
   still capable of `local` as instant fallback.
4. **Flip to remote** executor on the live box once a real submission has
   gone through the worker path.
5. **Shrink the front:** Hetzner can't rescale disks down, so create the
   fresh small front, move `db.git`, ops.sqlite, secrets, Caddy config,
   and the IP: either reassign the primary IP (make it non-auto-delete,
   same datacenter) or flip the two Cloudflare A records with a low TTL.
   Delete the cpx42. The domain, not the IP, is the archive's identity —
   BibTeX URLs never notice.

One detection pitfall carries over from the current deployment and stays
true on workers: the server's sandbox check is `bwrap --version`, so a
worker whose kernel/sysctl blocks unprivileged user namespaces starts
happily and the *first submit* fails. The snapshot recipe bakes in the
sysctl, and the volume-warm runbook's end-to-end smoke submission is the
real test — a version check is not.

## How it ran in practice (2026-07-26/27)

The machinery designed above was built and
exercised against the live archive: two real submissions (Lax5, Lax2)
were fetched, built and captured on an ephemeral worker while the box in
this document only validated and committed them. A submission took about
2½ minutes end to end that way.

Resources that existed then, **all deleted in the revert**: store volume
`lax-store` (id 106464828, 50 GB, fsn1 — a copy of the warm store plus the
split-era submission captures, which were rsync'd back to the box first),
worker snapshot id 412854302 (`lax-worker (lax-archive 0.1.6)`), the
`LAX_SERVER_EXECUTOR`/`LAX_WORKER_*` lines in `/etc/lax-server.env`, the
worker and hcloud tokens in `/home/lax/secrets/`, and
`lax-reap.service`/`.timer`.

### Four things that bit, and are now fixed in the recipe

Every one of these produced a machine that looked fine and did nothing —
worth keeping written down, because all four are invisible until a build
is actually attempted:

- **`hcloud server poweroff` cuts the power.** The last writes never left
  the page cache, so the snapshot contained a **zero-length**
  `lax-worker.service`. Use `hcloud server shutdown --wait` (and `sync`).
- **cloud-init's `runcmd` is not a reliable boot hook here.** On a
  snapshot boot the Hetzner datasource can lose its race with the network;
  cloud-init then reports `DataSourceNone`, silently runs nothing, and
  leaves no `/etc/lax-worker.env`. The unit is now *enabled in the
  snapshot* and reads the same user_data off `169.254.169.254` itself,
  with retries.
- **`SuccessAction=` is a `[Unit]` key.** In `[Service]` systemd ignores
  it with a warning nobody reads — and the idle worker would have stayed
  powered on, billing.
- **Global npm binaries are not in `/usr/local/bin`** on nodesource Node
  (they land in `/usr/bin`). Hardcoding the path made the unit's fallback
  branch exit 1 on a machine that was otherwise fine.

Also: the worker's firewall now *allows* SSH rather than `limit`-ing it.
Rate-limiting a throwaway, key-only machine mostly succeeds at locking out
the one operator who ever connects to it — and the symptom
(`Connection refused` from your IP, fine from everywhere else) reads
exactly like a broken boot.

### Remote for real (2026-07-26)

The front now provisions its own workers. A dedicated read/write Hetzner
token lives at `/home/lax/secrets/hcloud-token` (minted in the console —
the API cannot mint one), and `/etc/lax-server.env` carries
`LAX_SERVER_EXECUTOR=remote`, `LAX_WORKER_PROVIDER=hetzner`, image
`412854302`, volume `106464828`, `cpx42`/`fsn1`.

Verified end to end on the first real submission after the flip: `Lax10`
submitted at 15:33:43, worker `lax-worker-ms1yk1ko` created 200 ms later,
`drafted Lax10` at 15:35:46 — about two minutes, with the front only
validating and committing.

**The timers were missing on this box.** It was provisioned by hand long
before `provision-front.sh` existed, so it had `lax-server.service` and
nothing else — no reaper. In `manual` mode that was harmless; the moment
the front could create workers itself it became a billing leak with no
backstop. `lax-reap.timer`, `lax-deploy.timer` and `lax-ops-backup.timer`
are now installed and enabled. First runs behaved: reap kept a
three-minute-old worker (`maxAge` is 6 h; the worker's own 20-minute idle
shutdown is the usual path), and `lax-deploy` correctly no-opped with
"npm knows no lax-archive@production".

Worth remembering when the front does shrink: a hand-built box and the
provisioning script drift silently, and the drift only shows up when a
feature starts depending on it.

### What the remote path is actually known to do (2026-07-26)

Exercised against the live archive, not in tests. Worth keeping because the
happy path was verified twice before anyone looked at a failure, and the
failures are where the surprises were.

| Path | Result |
| --- | --- |
| Draft submit, cold worker | worker created 200 ms after submit, drafted in ~2 min |
| Register, warm worker | 32 s — the worker was still up from the previous job |
| Rejected build (`sorry`) | 21 axiom-hygiene violations, `submit` FAILED, **archive record untouched** |
| Release after success | fired at the 20-minute mark, worker deleted |
| Release after failure | also fired at 20 minutes — the `giveUp` path releases too |
| Reaper, keep branch | kept a 3-minute-old worker (`maxAge` 6 h) |
| `lax-deploy`, no-op branches | "no such tag", and "already current" |
| `lax-deploy`, upgrade branch | `0.1.6 → 0.1.7` unattended in 3 s, drain + install + restart |

The pull deploy is therefore real: moving the `production` dist-tag was the
only action, and the front upgraded itself within one timer period. Note the
firing *before* the tag moved exited silently — correct behaviour ("already
current"), but it reads exactly like a broken timer if you check between
firings. Look for the `lax-deploy: <old> → <new>` line, not for silence.

Still never executed: the reaper's **delete** branch, a **rollback** (move
the tag back), and `provision-front.sh` end to end.

**Clock warning for whoever debugs this next.** The box logs UTC and a German
laptop is UTC+2. Comparing the two invents a two-hour gap and makes a healthy
worker look like it leaked; this cost two false alarms in one session. Read
`date -u` on the box before concluding anything about elapsed time.

### The revert (2026-07-27)

The split became more trouble than it was worth — the immediate trigger
was Replay OOM-killing on every large submission (the worker ran as a
swapless 16 GB cpx42; the cx53 move existed only in prose), on top of the
worker-count bugs and the standing risk of a billing-capable hcloud token
on an internet-facing box — and with a GitHub-Actions-hosted build likely
next, it was retired rather than fixed. What was done, in order:

1. The three split-era captures the database references
   (`Lax10/0157a89f…`, `Lax2/7cad33e7…`, `Lax5/189b670f…`) were rsync'd
   from the volume back into `/home/lax/.lax-server/store/submissions/`.
2. `/etc/lax-server.env` reduced to the db URL (`local` is the code
   default); `LEAN_NUM_THREADS=1` in the `lean-threads.conf` drop-in;
   service restarted; `/healthz` reports `executor: "local"`.
3. Worker snapshot 412854302 and volume `lax-store` deleted;
   `lax-reap.timer` disabled and its units removed;
   `/home/lax/secrets/hcloud-token` and `worker-token` deleted.
4. The remote-executor code (worker, queue, provisioner, `/worker/*`
   protocol, `LAX_SERVER_EXECUTOR`) removed from the tree; shipped as
   0.1.8.

What the revert left owed — token revocation, bucket versioning, a Replay
re-measurement — is tracked live in TODO.md ("Owed after the front/worker
revert"), not here.
