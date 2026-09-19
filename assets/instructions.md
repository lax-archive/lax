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
  the past, so you can also pull off this one. Keep helper lemmas purposeful:
  `lax build` warns when a theorem-kind helper is not used, directly or
  transitively, by any annotated proof theorem in the submission. The build is
  still valid, but remove the helper unless retaining it is intentional.

- A result that spans several submissions is registered bottom-up, each
  dependent pinning the registered commit of what it builds on with a git
  require. While the pieces are still unregistered drafts side by side, name
  the dependency with a `path` require on its checkout, relative to the
  requiring package directory (`[[require]] name = "LaxN" path =
  "../../other/concepts"`, in every package that imports it), and iterate with
  `lax build --nonstrict`; the default build and `lax submit` refuse that
  edge, and once the dependency is registered the nonstrict build prints the
  git require to put in its place.

Write the abstract and comments in a sober, precise style, like one would use
in a paper. Double-check that the math will display well. Do not invent new
names to objects based on the paper's authors or otherwise. Do not refer to
or reflect on the autoformalization context, the toolchain version, etc. Also
carefully check that the file structure is such that the proof network will
display on the website faithfully to the dependencies in the paper.

# Additional Info

The first time you work with Lax, you want to run `lax print spec` to
familiarize yourself with the tool. Once you are familiar with the full
dimensions of the task, you may want to adjust the environment so that it feels
comfortable to you: create your own memory files, entry points and workflows.
Be supportive of the user. They might not be that familiar with recent
agent systems, so feel free to make suggestions that improve the overall
experience and productivity.
