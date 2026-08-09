# CLI output — a draft

A proposal for what every `lax` command prints on its happy path. Not
implemented; this is the thing to argue with first.

The complaint it answers: the CLI narrates its own internals. Issue numbers,
workflow run ids, archive commit SHAs, "the three stub files", "immutable
source triple", "lax-database", "the Website rebuild event was accepted" —
none of that is the author's business, and it arrives interleaved with the two
or three facts that are.

---

## The anchor example

**Today**

```
~/foodir  lax init
Opening the submission issue on lax-archive/lax.
Allocated lax-50: https://github.com/lax-archive/lax/issues/50
Waiting for initialization to commit the three stub files.
lax init: workflow run #31301766471: https://github.com/lax-archive/lax/actions/runs/31301766471
lax init: Initialized lax-50 in lax-database.

  Archive commit: 08cb70f14bcd220398543e2655f8beda08c881bf. The Website rebuild event was accepted.
warning: folder is not inside a git repository; `lax submit` will need one
Initialized lax-50 in /home/jan/foodir.
```

Nine lines, three of which say "initialized", four of which name machinery the
author cannot act on, and the one genuinely actionable line — no git repo — is
buried in the middle in lowercase log voice.

**Proposed** — while it runs:

```

  Creating a submission

  ✓ Signed in as jan3er
  ✓ Reserved lax-50
  ✓ Created the files
  ⠸ Preparing mathlib · first time on this machine, this takes a while   4m12s

```

and when it finishes:

```

  Creating a submission

  ✓ Signed in as jan3er
  ✓ Reserved lax-50
  ✓ Created the files
  ✓ Prepared mathlib             4m38s

  lax-50 · Bounded gaps between primes
  ~/foodir

  ! This folder is not in a git repository yet.
    lax submit needs one — run git init, then push it to GitHub.

  Next  Edit abstract.md and write concepts/Lax50/, then run lax build

```

---

## Rules

1. **No command-name prefixes.** The author knows what they typed. `lax init:`
   on every line is a log format, not a UI. Gone everywhere.
2. **One title, one result.** A slow command opens with a title line and closes
   with a bold one-line verdict. A fast command prints only the verdict.
3. **A step list only where there is real waiting.** `lax owners` finishes in
   three seconds and gets one line. `lax build` gets a list.
4. **Nothing is said twice.** "Initialized lax-50 in lax-database" and
   "Initialized lax-50 in /home/jan/foodir" are the same sentence.
5. **Internals are a `--verbose` concern.** Run ids, comment URLs, archive
   commits, dispatch outcomes, artifact names, the words *lax-database*,
   *control plane*, *source triple*, *stub files*, *dispatch* — none reach the
   happy path. They stay reachable, because they are exactly what a bug report
   needs.
6. **One link, and it is the one worth clicking.** The author's own page, not
   the machinery that produced it.
7. **Notes come last, in one block, each with the fix.** `!` yellow, two-space
   continuation, imperative fix on the second line.
8. **Elapsed time on anything over three seconds.** Silence for four minutes
   reads as a hang; `4m12s` reads as work.
9. **Author's nouns, not ours.** *your machine* and *the archive*, not *local
   validation* and *the trusted workflow*. *mathlib*, not *warm store*.
   *source*, not *immutable source triple*.
10. **Colour is one accent and one dim.** Green `✓`, yellow `!`, red `✗`,
    dim for every detail in the right-hand column, bold only for the verdict
    line and for commands the author should type. No boxes, no ASCII art, no
    background colours.
11. **Piped output is the same words.** No spinner, no cursor tricks, one line
    per settled step, still complete. Agents drive this CLI and read what it
    prints; the plain form has to carry everything the pretty one does.

Layout: two-space indent throughout, blank line under the title, blank line
above the verdict, step labels padded to a fixed column so details align.

---

## The commands

### `lax init`

Above. Variants:

Title defaulted to the folder name — say so once, in the identity block, so the
author sees the thing they will want to fix:

```
  lax-50 · foodir  (rename it in manifest.yaml)
```

TODO: default title is always empty

Machine that already has mathlib — the row settles instantly and carries no
time:

```
  ✓ Prepared mathlib
```

### `lax build`

Running:

```

  Building lax-50

  ✓ Checked the layout
  ✓ Resolved dependencies       mathlib, lax-12
  ⠴ Compiling concepts                                        1m04s

```

Done:

```

  Building lax-50

  ✓ Checked the layout
  ✓ Resolved dependencies       mathlib, lax-12
  ✓ Compiled concepts           1m04s
  ✓ Compiled proofs             3m21s
  ✓ Inspected the statements    4 concepts · 7 proofs

  Built lax-50 in 4m38s

  Next  Preview it with lax serve, or send it with lax submit

```

`build-output.json was written` disappears: the file is an implementation
detail the author never opens, and `.gitignore` already hides it.

With warnings the verdict stays, and the notes block follows it:

```
  Built lax-50 in 4m38s

  ! 2 warnings
    concepts · unused-import
      Lax50/Basic.lean imports Mathlib.Tactic but uses nothing from it
    proofs · long-line
      Lax50Proofs/Main.lean:88 is 143 characters
```

`--only concepts`:

```
  Compiled the concepts of lax-50 in 1m04s · partial build, nothing saved
```

`--replay` adds one row: `✓ Replayed the kernel proofs   2m10s`.

### `lax serve`

```

  Preview

  http://localhost:8123

  lax-50 and 1,204 published submissions.
  Rebuilds when lax build writes a new result. Ctrl-C to stop.

```

Each rebuild is one dim line, not a sentence:

```
  ↻ 14:22:07  rebuilt
```

A stale archive copy becomes a note rather than a repeated warning:

```
  ! Your copy of the archive is out of date. Run lax pull-db.
```

### `lax submit`

Running:

```

  Submitting lax-50

  ✓ Signed in as jan3er
  ✓ Checked your source          jan/primes @ a1b2c3d
  ✓ Checked on your machine      reused your last build
  ⠸ Checked by the archive       compiling proofs             6m02s

```

Done:

```

  Submitting lax-50

  ✓ Signed in as jan3er
  ✓ Checked your source          jan/primes @ a1b2c3d
  ✓ Checked on your machine      reused your last build
  ✓ Checked by the archive       6m41s
  ✓ Published                    9s

  lax-50 is a draft in the archive
  https://laxarchive.org/lax-50/

  Next  lax register lax-50 when you are ready to make it permanent

```

*your machine* / *the archive* is the whole mental model, and it costs two
words. `(https://github.com/jan/primes, a1b2c3…, .)` becomes
`jan/primes @ a1b2c3d`, which is what a developer reads without decoding.

When there is no current build, the local row runs for minutes and shows the
build's own phase as its detail rather than nesting a second list:

```
  ⠸ Checking on your machine     compiling proofs             2m40s
```

`--force` replaces two rows with one note, in the same block as the others:

```
  ! Skipping every local check. The archive is the only verdict.
```

### `lax register`

```

  Register lax-50

  Registering is permanent. The record becomes immutable and citable, and
  it can never be changed or removed.

  Type lax-50 to confirm › lax-50

  ✓ Registered                   4s

  lax-50 is registered
  https://laxarchive.org/lax-50/

```

The control plane's echo of the request is dropped from the happy path: the CLI
ran the same preflight one second earlier and printed its result. It reappears
the moment the two disagree, which is the only time it says anything.

### `lax delete`

```

  Delete lax-50

  This is permanent. lax-50 leaves the archive and the site, and its id is
  retired — it will never be reused.

  ! lax-51 and lax-53 build on lax-50 and will be left broken.

  Type lax-50 to confirm › lax-50

  ✓ Deleted

  lax-50 is gone.

```

### `lax owners`

Three seconds of work, so no title and no list:

```
  ✓ lax-50 is now owned by alice and bob
```

### `lax doctor`

Running — every row spins concurrently, and the two rows that genuinely queue
say what they are waiting for:

```

  Checking your setup

  ✓ Lax                 0.1.23 · node v22.11.0 · linux
  ⠧ Lean                installing v4.30.0, a few minutes    2m41s
  ✓ Git                 2.43.0
  ⠹ Account
  ⠋ Archive             updating
  ⠙ Mathlib             waiting for Lean

```

Done:

```

  Checking your setup

  ✓ Lax                 0.1.23 · node v22.11.0 · linux
  ✓ Lean                v4.30.0 · lake 5.0.0 · elan 3.1.1
  ✓ Git                 2.43.0
  ✓ Account             jan3er
  ✓ Archive             up to date
  ✓ Mathlib             ready
  ✓ Disk                214 GB free
  ✓ lax-50              ~/foodir

  Everything is ready.

```

Four of today's twelve rows — platform, node, npm, website renderer — are one
fact from the author's side: *is the lax install healthy*. They collapse into
`Lax` while they pass, and split back out with a full line and a fix the moment
one does not. Same for elan / lake / lean toolchain → `Lean`.

Paths leave the happy path too. `~/.lax/lax-database (up to date)` matters only
when it is *not* up to date; then the path is the first thing printed.

A failing check keeps today's shape, which is already right, with the fix
aligned under the detail column:

```
  ✗ Account             not signed in
                        → run lax login
  ! Mathlib             not downloaded yet
                        → the first lax build fetches it (several GB)

  1 problem · 1 note
```

### `lax login`

The scope notice moves **above** the code — it is a thing to read before
authorizing, not after:

```

  Sign in to GitHub

  Lax will be able to read your public profile and post issues and comments
  to lax-archive/lax as you. It cannot read or write your repositories, and
  it has no access to the archive itself.

  Open        https://github.com/login/device
  Enter code  ABCD-1234

  ⠋ Waiting for you to authorize                              22s

```

```

  ✓ Signed in as jan3er

  Next  Create a folder and run lax init

```

### `lax logout`

```
  ✓ Signed out
```

and, when there was nothing stored, `  Nothing to sign out of.`

### `lax pull-db`

Today this inherits git's stdio, so a clone paints a progress bar over
everything. Quiet it the way `lax doctor` already does:

```
  ✓ Archive up to date           1,204 submissions
```

```
  ✓ Archive updated              +3 · 1,204 submissions
```

### `lax update`

```
  ✓ Updated lax                  0.1.23 → 0.1.24
  ✓ Archive up to date           1,204 submissions
```

```
  ✓ lax is up to date            0.1.24
  ✓ Archive up to date           1,204 submissions
```

npm's install transcript goes behind `--verbose` with everything else.

### `lax --help`

```

  lax — the archive for machine-checked mathematics

  Getting started
    lax doctor            check your setup
    lax login             sign in with GitHub

  Making a submission
    lax init my-work      reserve an id and set up the folder
    lax build my-work     check it on your machine
    lax serve my-work     preview the pages
    lax submit my-work    send it to the archive as a draft
    lax register my-work  make it permanent and citable

  Also
    lax owners · lax delete · lax pull-db · lax update · lax spec

  lax <command> --help for options

```

---

## What moves to `--verbose`

Every phrase below is printed today on a happy path.

| Printed today | Verdict |
| --- | --- |
| `Opening the submission issue on lax-archive/lax.` | verbose |
| `Allocated lax-50: <issue url>` | → `✓ Reserved lax-50` |
| `Waiting for initialization to commit the three stub files.` | verbose |
| `lax init: workflow run #31301766471: <url>` | verbose |
| `lax init: Initialized lax-50 in lax-database.` | → the verdict line |
| `Archive commit: 08cb70f…` | verbose |
| `The Website rebuild event was accepted.` | verbose |
| `warning: folder is not inside a git repository; …` | → notes block |
| `Initialized lax-50 in /home/jan/foodir.` | duplicate, gone |
| `lax submit: preparing lax-50 in /home/jan/foodir.` | gone |
| `lax submit: authenticated as jan3er.` | → `✓ Signed in as jan3er` |
| `lax submit: refreshing the local lax-database checkout.` | verbose |
| `lax submit: reusing the current local build for a1b2c3d4e5f6` | → `reused your last build` |
| `Submitting lax-50 from (repo, sha, folder).` | → `jan/primes @ a1b2c3d` |
| `lax submit: command posted: <comment url>` | verbose |
| `validating: compile, kernel replay, inspection` | → `Checked by the archive` |
| `Updated lax-50 from its validated immutable source.` | → the verdict line |
| `lax build: validating lax-50` | → the title line |
| `lax build: OK — /home/…/build-output.json written` | → `Built lax-50 in 4m38s` |
| `lax build: found 2 warnings during local validation` | → `! 2 warnings` |
| `lax serve: loading the pinned lax-website renderer.` | gone |
| `site rebuilt from 47 Archive records` | → `↻ 14:22:07 rebuilt` |
| `lax register: checking lax-50 against a refreshed local lax-database.` | gone |
| `lax register: sending the registration command for lax-50.` | gone |
| `Registered lax-50; it is now immutable.` | → the verdict line |
| `Resolving 2 GitHub handles.` | → `✓ Checked 2 GitHub accounts` |
| `Refreshing ~/.lax/lax-database from https://…git.` | → `✓ Archive up to date` |
| `moved the existing database checkout from … to …` | verbose |
| the raw `git clone` / `npm install` transcripts | verbose |

---

## Phase names → rows

`lax build` emits nineteen internal phases. The author sees six.

| Phases | Row |
| --- | --- |
| `static validation` | Checked the layout |
| `dependency resolution`, `dependency provisioning`, `provision concepts`, `provision proofs` | Resolved dependencies |
| `warm store` | Prepared mathlib *(only when it does work)* |
| `compile concepts` | Compiled concepts |
| `compile proofs` | Compiled proofs |
| `replay concepts`, `replay proofs` | Replayed the kernel proofs *(`--replay` only)* |
| `inspector binary`, `inspect concepts`, `inspect proofs`, `judge inspection` | Inspected the statements |
| `install concept capture`, `capture concepts`, `capture proofs`, `emit`, `validation runtime` | *(silent — folded into the verdict)* |

Workflow jobs, for `lax submit`:

| Job | Row |
| --- | --- |
| `route` | *(the queued state of the next row)* |
| `validate` | Checked by the archive |
| `publish-submit`, `publish` | Published |

Finding phases in the notes block get the same treatment:
`compile-concepts` → `concepts`, `compile-proofs` → `proofs`, `static` →
`layout`, `resolution` → `dependencies`, `inspect` → `statements`.

---

## Implementation notes

Mostly deletion. The primitives already exist.

- `LoadingBlock` (`src/cli/loading.ts`) is exactly the step-list widget every
  command above needs — declared rows, concurrent settling, stable order,
  degrades to a plain streamed prefix without a TTY. Today only `lax doctor`
  uses it. Everything else uses `LoadingLine`, which can show one thing at a
  time.
- A small `src/cli/ui.ts` for the shapes the rules describe: `title()`,
  `step()`, `verdict()`, `note()`, `next()`, plus the colour decisions in one
  place so they can be turned off (`NO_COLOR`, `--no-color`, not a TTY).
- `follow.ts` currently prints the run URL and the rendered result comment
  directly. It becomes a progress source that returns an outcome; the caller
  decides what to print. `renderComment()` stays — a failure still needs the
  workflow's own words — but no longer runs on the happy path.
- Verbose is a global `-v/--verbose` on `program`, read through the same `ui`
  module, so adding a line to it is one call and never reaches the default.
- `https://laxarchive.org/` needs a constant; the CLI has no website base URL
  today (only `WEBSITE_REPOSITORY`).
- `lax pull-db` should stop inheriting git's stdio and use
  `updateDatabaseQuietly()`, which already exists for `lax doctor`.

## Open questions

jan: we keep lax sync. we rename lax spec to lax print spec and add lax print instructions with a dummy file

- `pull-db` is the only command named after the machinery rather than the
  thing. `lax sync`? And `lax spec` vs Jan's `lax print spec` /
  `lax print instructions`.
- Should a registered submission print its BibTeX key? "Registered" and
  "citable" are the same sentence, and the citation is the payoff. Jan: yes
- `lax serve` prints the port it was given. Should it pick a free one when
  8123 is taken, rather than failing?
  Jan: yes

