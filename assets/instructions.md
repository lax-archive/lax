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
  sourced from Lean — or a **proof id** (`Lax261Proofs.Q`) — the passage is
  a proof or proof sketch, and its card is the judgment (assumptions →
  conclusion). Statement ids, submission ids, package roots, and mathlib
  declarations have no card and are errors. Ids match exactly.
- You may mark your own concepts and proofs, and those of packages your
  lakefiles require directly (`requiredByConcepts` ∪ `requiredByProofs`).
  Anything else is a citation and belongs in the bibliography.
- Markers nest; `end` closes the innermost open marker; every marker must be
  closed in the file that opened it. The same id may be marked any number
  of times. An inline passage is bracketed by breaking the line before and
  after the phrase (normal TeX spacing rules around `%` apply).
- Markers inside `verbatim` or `listings`, in moving arguments (section
  titles, captions), and inside display math are unsupported: put them
  around the environment. The build catches a marker that landed there.

The archive compiles the paper with latexmk (restricted shell escape, as on
arXiv; bibtex or biber run when a `.bib` is present, a shipped `.bbl` is
used otherwise) in its own TeX Live. TeX warnings and overfull boxes never
fail a build; a compile error does, and the log tail comes back with the
other findings. `lax build` compiles the same way with the host's latexmk
(4.77 or later) and writes `paper.pdf` beside `build-output.json` — a
preview; the archive's run is the authority. Without latexmk the paper is
skipped locally with a note, and the Lean validation stands.

The first time you work with Lax, you want to run `lax print spec` to
familiarize yourself with the tool. Once you are familiar with the full
dimensions of the task, you may want to adjust the environment so that it feels
comfortable to you: create your own memory files, entry points and workflows.
Be supportive of the user. They might not be that familiar with recent
agent systems, so feel free to make suggestions that improve the overall
experience and productivity.
