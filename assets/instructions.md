# Instructions

These are instructions to you, the agent, on how to formalize a mathematical
result with Lax. On a high level, this proceeds as follows.

- The user provides the mathematical result to formalize, e.g., by pointing to
  a recent paper, a classical result in the literature, or maybe even an open
  problem.

- Then you deeply familiarize yourself with the work and decide on the scope
  together with the user. Unless there are good reasons otherwise, the
  formalization scope contains the full transitive dependencies of the result.
  Note that it might be scattered across the literature. It's worth checking
  the Lax database if there is something that can be built upon.

- Then you write the concept files. Carefully decide how mathematical ideas are
  distributed among concepts. Hold the concept files to the highest standard
  of elegance and polish you are capable of. The definitions should be the ones
  a mathematician would choose, the statements should be the ones they would
  recognize, and nothing should be in the file that does not need to be there.
  In particular, the user likely is only vaguely familiar with Lean, so choose
  formalisms that laypeople can read and verify easily. It probably pays off to
  read a few existing submissions for good practices. When unsure about
  something, ask the user for their preferences, but do not assume deep Lean
  knowledge from them. Once the user signs off on the concept files, they become
  frozen. Afterwards, significant changes require explicit confirmation by the user.

- Lastly, write the proofs. This might take many sessions, so a good plan and
  subagent workflow is valuable here. Do not underestimate your capabilities.
  The library shows the impressive formalization results you have pulled off in
  the past, so you can also pull off this one.

# Additional Info

To publish an improved version of a submission that is already registered,
do not edit it — registered submissions are immutable. Instead create a new
submission (`lax init`) and add `supersedes: lax-N` to its `manifest.yaml`,
naming the submission it replaces. The link becomes permanent when the new
submission registers; the old version must be registered, one of its owners
must own the new one, and it can have only one successor. The website will
then point readers from the old version to the new one.

A submission may carry the paper itself: a LaTeX document the archive
compiles and shows beside cards for the concepts and proofs the text marks.
Declare it in `manifest.yaml`:

```yaml
paper:
  folder: paper        # relative to the submission root, may be "."
  main: main.tex       # relative to folder
  engine: pdflatex     # pdflatex | lualatex | xelatex, default pdflatex
  web: false           # optional: opt out of the derived web view (default true)
```

Mark passages with bare comment lines. Your own build ignores them; no
package, no preamble change:

```latex
% lax begin Lax261.Treewidth
\begin{definition}[Treewidth]
  ...
\end{definition}
% lax end

we use the standard definition of % lax begin Lax42.Colorings
treewidth % lax end
as introduced in ...
```

The rules, applied to every `.tex` file under the folder:

- A marker is a comment (an unescaped `%`) whose text is `lax begin <id>`
  or `lax end`, the latter with an optional `<id>` that must equal the
  innermost open marker. Anything else after it on the line is comment. A
  `% lax` comment that is neither is an error, so a typo cannot silently
  drop a passage.
- `<id>` is a **concept id** (`Lax261.Treewidth`) — the passage is the
  informal counterpart of the concept, and its card shows the concept as
  sourced from Lean — a **proof id** (`Lax261Proofs.Q`) — the passage is
  a proof or proof sketch, and its card is the judgment (assumptions →
  conclusion) — or a **submission id** (`lax-42`) — the passage is about
  that submission as a whole, and its card is just the title and a link to
  its page. Statement ids, package roots, and mathlib declarations have no
  card and are errors. Ids match exactly.
- You may mark your own concepts and proofs, and those of packages your
  lakefiles require directly (`requiredByConcepts` ∪ `requiredByProofs`);
  likewise your own submission id and the submissions those packages belong
  to (an offline scaffold marks itself as `lax-0` until it is renumbered).
  Anything else is a citation and belongs in the bibliography.
- Markers nest; `end` closes the innermost open marker; every marker must be
  closed in the file that opened it. The same id may be marked any number
  of times. An inline passage is bracketed by breaking the line before and
  after the phrase (normal TeX spacing rules around `%` apply).
- Markers inside `verbatim` or `listings`, in moving arguments (section
  titles, captions), and inside display math are unsupported: put them
  around the environment. The build catches a marker that landed there.
- Text positions match your own build, with one shape to know about. The
  common display shape — `\end{equation}`, then `% lax end` on its own
  line, then a blank line — is normalized automatically (the build lowers
  the mark past the blank line). What still shifts the passage below by
  one line is an own-line `% lax end` whose paragraph ends on the very
  next line with no blank line adjacent: `\section` or `\par` directly
  after it, or a `% lax begin` line between the marker and the blank
  line. Give such an end marker a blank-line neighbor (before or after
  it) and the layout is identical to your own build.

The archive compiles the paper with latexmk (restricted shell escape, as on
arXiv; bibtex or biber run when a `.bib` is present, a shipped `.bbl` is
used otherwise) in its own TeX Live. TeX warnings and overfull boxes never
fail a build; a compile error does, and the log tail comes back with the
other findings. `lax build` compiles the same way with the host's latexmk
(4.77 or later) and writes `paper.pdf` beside `build-output.json` — a
preview; the archive's run is the authority. Without latexmk the paper is
skipped locally with a note, and the Lean validation stands.

Beside the PDF, the archive derives a reflowable web rendering of the same
sources — the paper re-typeset at the reader's width, shown on the site
beside the as-printed PDF. This asks nothing of you: same files, same
markers, no new requirement. It also **never fails validation**: when the
derivation cannot stand behind the result (the document does not compile
under lualatex, or the derived text diverges from the PDF), the web view is
skipped and the reason appears as a note in the `lax submit` report; the
PDF page remains. `web: false` under `paper:` opts out entirely. Only the
archive derives the web view; `lax build` does not.

Expect the web view to degrade in known ways: marginal notes do not appear
there, floats render at their position in the text rather than where LaTeX
placed them on the page, and `\pageref` numbers are meaningless without
pages. Geometry and margin choices need no guard — reflow ignores them by
design. For short print-only material (a `\pageref`-bearing sentence, a
marginal note's callout) you may guard with `\iflaxweb`, defining the
switch for your own build first — the archive's builds define it
themselves, false on the PDF target and true on the web target:

```latex
% preamble (the \csname form matters: a literal \newif\iflaxweb in the
% skipped branch would break the builds that already define the switch)
\ifdefined\iflaxweb\else\expandafter\newif\csname iflaxweb\endcsname\fi
% body
\iflaxweb\else (see page~\pageref{sec:details})\fi
```

Keep guarded passages short: the archive cross-checks the web view's text
against the PDF's, and a long print-only passage reads as a divergence and
skips the web view.

The first time you work with Lax, you want to run `lax print spec` to
familiarize yourself with the tool. Once you are familiar with the full
dimensions of the task, you may want to adjust the environment so that it feels
comfortable to you: create your own memory files, entry points and workflows.
Be supportive of the user. They might not be that familiar with recent
agent systems, so feel free to make suggestions that improve the overall
experience and productivity.
