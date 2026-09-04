#!/usr/bin/env node
// Print the `inspector-matrix` job's matrix: one leg per admitted environment.
//
//   node scripts/environments/matrix.mjs
//   {"include":[{"id":"v4.30.0","leanToolchain":"leanprover/lean4:v4.30.0", …}]}
//
// Read from the table's *source text* rather than from dist/, so the gate job
// that decides which toolchains to install needs no npm install and no
// TypeScript build — and so a table that cannot be parsed fails the job loudly
// instead of yielding a short matrix that quietly stops guarding an
// environment. `test/unit/environments-scripts.test.ts` pins this against the
// compiled table.

import { readTable } from "./table.mjs";

const include = readTable().map((entry) => ({
  id: entry.id,
  leanToolchain: entry.leanToolchain,
  inspector: entry.inspector,
}));
process.stdout.write(`${JSON.stringify({ include })}\n`);
