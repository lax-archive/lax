// Runs in every fork before any test module (and hence any src/ module) is
// imported: point the archive's mathlib pin at the fake (see fake-mathlib.ts).
// LAX_E2E runs keep the real pin — combine LAX_E2E=1 only with the e2e test
// files, or every fast test will download real mathlib.
import { fakeMathlib } from "./fake-mathlib.js";
import { putToolchainOnPath } from "./paths.js";

if (process.env.LAX_E2E !== "1") {
  const { url, rev } = fakeMathlib();
  process.env.LAX_MATHLIB_URL = url;
  process.env.LAX_MATHLIB_REV = rev;
}
// After the seam: the helper imports src, whose pins freeze the env on import.
await putToolchainOnPath();
