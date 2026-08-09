// Removing a temp tree that may hold a sealed warm store.
//
// `makeStoreReadOnly` strips write permission from directories as well as
// files, and rm needs it back on a directory before it can unlink what is
// inside. Plain `fs.rmSync` therefore fails with EACCES on any home a warm
// build touched — everywhere except as root, which ignores the permission bits
// and made this look fine locally while CI's unprivileged runner failed.

import fs from "node:fs";
import path from "node:path";

/** Remove `root`, reopening sealed directories on the way down. */
export function removeTree(root: string): void {
  // lstat, not exists: a home whose `warm` is a symlink into the shared cache
  // must be unlinked, never followed and chmod'd — that would seal the cache
  // every other test shares.
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(root);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const entry of fs.readdirSync(root)) removeTree(path.join(root, entry));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
