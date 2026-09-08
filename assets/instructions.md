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

The first time you work with Lax, you want to run `lax print spec` to
familiarize yourself with the tool. Once you are familiar with the full
dimensions of the task, you may want to adjust the environment so that it feels
comfortable to you: create your own memory files, entry points and workflows.
Be supportive of the user. They might not be that familiar with recent
agent systems, so feel free to make suggestions that improve the overall
experience and productivity.
