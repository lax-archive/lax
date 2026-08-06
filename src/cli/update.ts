import { execFileSync } from "node:child_process";
import { pullDatabase } from "./database.js";

export async function updateCli(): Promise<void> {
  console.log("lax update: installing lax-archive@latest");
  execFileSync("npm", ["install", "--global", "lax-archive@latest"], {
    stdio: "inherit",
  });
  pullDatabase();
}
