# Formalizing a result with Lax

These instructions are for you, the agent. When a user asks you to formalize
some result, this is how the work goes. It says how to proceed, not how the
system is defined: run `lax print spec` for the full specification of the Lax
ecosystem — the layout, the concept dialect, and everything validation
enforces — and work from that rather than from guesses or from examples.

## Before you write anything

**Read the spec.** `lax print spec`. Every rule you would otherwise infer is
written down there.

**Set yourself up to work across sessions.** A formalization is not one
sitting. Before the first line of Lean, create your own memory files and entry
points: where the state of the work lives, what you write down at the end of a
session, what the next session reads first to pick the thread back up. Assume
the user has never run a project this way — most people have not. Walk them
through what you are setting up, where it lives, and what you will need from
them when you start again.

## Concepts first

Write the concept files first, and then stop and ask the user to review them.
The concepts are the statement of what will be proved; a flawless proof of the
wrong statement is worth nothing, and the user is the only one who can tell you
that the statement is the one they meant.

Hold the concept files to the highest standard of elegance and polish you are
capable of. They are the part of the submission that other people read, cite,
and build on: the definitions should be the ones a mathematician would choose,
the statements should be the ones they would recognize, and nothing should be in
the file that does not need to be there.

Reading the existing library before you invent anything pays off — it is where
the conventions of the archive actually live. `lax sync` brings your copy of the
archive up to date, `lax serve --database-only` browses it locally, and
<https://laxarchive.org> serves the same pages.

## The commands

The user has usually reserved the submission already, with `lax init`, so you
are working in a folder that is set up. From there:

```sh
lax build <folder>      # check it on your machine
lax serve <folder>      # preview the pages the archive would publish
lax submit <folder>     # send it to the archive as a draft
lax register <folder>   # make it permanent and citable
```

- `lax build` is the loop you live in. It runs the archive's own validation
  locally and reports what it found; iterate until it is clean. While the proofs
  are still empty, `--only concepts` is faster, and `--replay` adds the kernel
  replay the archive performs.
- `lax serve` renders the submission and the archive together and serves them
  for preview, rebuilding whenever `lax build` produces a new result.
- `lax submit` sends the *pushed* commit, so commit and push before you run it.
  A draft can be replaced: fix something, push, and submit again.
- `lax register` is permanent. The record becomes immutable and citable and can
  never be changed or removed, so it is the user's decision to make, not yours.

If the folder has not been set up yet, `lax init <folder>` reserves the id and
scaffolds the layout. If a command complains about the machine rather than about
the submission, `lax doctor` checks the setup and prints the fix.
