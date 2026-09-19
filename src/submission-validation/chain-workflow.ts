/**
 * The single piece of user-facing prose that walks an author from a rejected
 * cross-submission edge to the workflow that replaces it. Path requires
 * between submissions are refused by the archive (see validators/lakefile.ts;
 * only a local `lax build --nonstrict` admits them, as siblings); a chain of
 * submissions is landed bottom-up, each member pinned into its dependent by
 * commit. Both the static rejection and Resolution's "that triple is not the
 * registered one" rejections append this, so the workflow is discoverable
 * from wherever the author first hits the wall.
 */
export const CHAIN_WORKFLOW_HINT =
  "Multi-submission work uses the chain workflow: commit, submit and register the " +
  "dependency first, then reference it from its dependent as a git require pinned to that exact " +
  'commit (`[[require]] name = "LaxN", git = "https://github.com/you/yourrepo", ' +
  'rev = "<commit>", subDir = "<folder>/concepts"`), and repeat one level up the chain.';
