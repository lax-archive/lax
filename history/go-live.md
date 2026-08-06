# Go-live: database port, cutover, and deployment finish (2026-08-06)

Closed record of taking the rewritten control plane live. Open leftovers
from these runs live in TODO.md; this file keeps what happened and why.

## Porting the production database

All 13 drafts were republished with ghcr captures via `scripts/port-db/`
(bottom-up in dependency order, re-validated through the control plane);
the 3 `init` stubs needed nothing. Notes from the run:

- lax-11/12 (commit `7567bb4e`) and lax-3/5/15 (commit `8c4d271`) record
  source commits that exist only on the lax-submissions branch
  `port/chain-requires` (the sibling-path→git-require chain conversion).
  Deleting that branch strands their sources.
- The six unowned records (lax-9/10/16/17/18/41) were ported via a
  temporary maintainer exception: repo-admin ruleset bypass on
  lax-database + `jan3er` inserted into `owner-list.json` (numeric-id
  sorted!), then both restored. Scripts in the 2026-08-06 session
  scratchpad; owner lists verified restored.
- ghcr org policy initially forced `lax-captures` private (the go-live
  risk the live rehearsal flagged, confirmed) — fixed by allowing public
  packages org-wide, flipping the package, then re-restricting. Anonymous
  pull verified.
- Driver friction observed (candidate follow-ups are in TODO.md): three
  i/o-timeout casualties had to be re-driven because transient `gh`
  failures during polling failed the record; a duplicate comment raced
  after a timed-out POST (CAS rejected it correctly, but the driver
  created the race); lax-17's validate runs ~28 min against a 20-min
  default driver timeout.

## The box stop and DNS cutover

The old Hetzner box was fully stopped and powered off 2026-08-06: all
units disabled (`lax-deploy.timer`, `lax-ops-backup.timer`,
`lax-server.service`, `caddy`) and the irreplaceable state (db.git +
ops.sqlite) exported to `~/lax-box-final-20260806-153311.tar.gz` on Jan's
machine. Stopping the box first also killed its latest-following
`lax-deploy` timer, which would otherwise have installed a
`lax-server`-less npm package onto the live server on the first release.
laxarchive.org was then set as the lax-website Pages custom domain and
Cloudflare A/CNAME records repointed at GitHub Pages. Decommission
leftovers (server deletion, credential rotation) are in TODO.md.

## HTTPS

Let's Encrypt provisioning for laxarchive.org sat stuck for over an hour
with correct, unproxied DNS. A custom-domain remove/re-add on the Pages
settings kicked it; the cert landed ~30 minutes later and a watcher from
the cutover session flipped `https_enforced`. HTTP→HTTPS and www→apex
redirects verified.

## First npm release (0.1.18 → 0.1.19)

- The npm trusted-publisher registration had pinned the *old* repository's
  identity — the repo that held the name `lax-archive/lax` before the
  lax-legacy rename. The new repo's OIDC token failed as a masked E404 on
  `npm publish` even though the registration's displayed org/repo/workflow
  looked correct. **Lesson: trusted publishing binds the repository, not
  the name — delete and re-create the registration after any repo
  replacement.**
- A stale `v0.1.18` tag from 2026-08-02 (pre-rework commit, never
  released, no GitHub release) was deleted and re-pointed at main first.
- The real-install test caught a packaging bug: the inspector's Lean
  sources (`src/submission-validation/lean/inspector/`) were not in the
  tarball, so every npm install failed Inspect. Shipped as 0.1.19 by
  adding the directory to package.json `files` (the resolver's second
  candidate path already expected it). **Lesson: `prepack` rebuilds
  `dist/` and would wipe the imported page-builder — the release workflow
  publishes the packed tarball (lifecycle scripts don't run on tarballs),
  which is why the vendored bundle survives; a plain `npm publish` from a
  laptop would silently drop it.**
- 0.1.19 verified from the registry: `lax doctor`, full `lax build`
  including first-use inspector compile, `lax serve` rendering all 16
  archive records.

## Production round trip

lax-14 (finite-ramsey) was updated through the full path: trivial source
change pushed to lax-submissions branch `roundtrip-20260806` (commit
`42a14ff9`), `/lax submit` comment on issue 14, validate → publish
(archive commit `629f760b`) → website dispatch → Pages deploy — and the
round trip earned its keep by exposing a silent deploy bug. **Pages
dedupes artifact deployments by `pages_build_version`, which
deploy-pages takes from `GITHUB_SHA`.** Dispatch- and schedule-triggered
rebuilds run on an unchanged lax-website main, so every database-driven
redeploy declared the same version and GitHub kept serving the *first*
deployment of that SHA: the run reported success, the artifact contained
the new page, the site never changed. An attempted fix that overrode
`GITHUB_SHA` on the deploy step (lax-website `31ada74`) was ineffective —
the runner's own `GITHUB_*` variables beat step-level `env`. The real
fix (lax-website `48206c3` + the config flip) switched Pages to serve
the `gh-pages` branch directly: the workflow already maintains that tree
and only commits when content changes, so publishing is triggered by the
content push itself and the dedup trap cannot exist. Two hardenings
rode along: a `CNAME` file committed into the tree (branch builds must
carry the custom domain) and a verify step that polls the *live site's
bytes* against the pushed tree (`792fc2b`) — not the Pages build status,
which proved to be a false-negative source: the Pages backend can exceed
its own 10-minute deploy timeout and report "errored" while still
finishing minutes later (it ran ~12 min all afternoon after the cert
churn, vs ~30 s in the morning). Edge cache is `max-age=600`; unique
query strings bust it.
