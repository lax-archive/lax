import { execFileSync } from "node:child_process";
import { updateDatabase } from "./database.js";
import { updateWebsiteRenderer } from "./website-renderer.js";

export async function upgradeCli(): Promise<void> {
  console.log("lax upgrade: installing lax-archive@latest");
  execFileSync("npm", ["install", "--global", "lax-archive@latest"], {
    stdio: "inherit",
  });
  updateDatabase();
  await updateWebsiteRenderer();
}
