import { setTimeout as delay } from "node:timers/promises";
import { CONTROL_REPOSITORY_ID } from "../shared/constants.js";
import { GitHubClient } from "../shared/github.js";
import { storeGitHubAppCredentials } from "./auth.js";
import { LoadingLine } from "./loading.js";
import {
  credentialsFromTokenResponse,
  GITHUB_APP_CLIENT_ID,
  requestDeviceCode,
  requestDeviceToken,
} from "./github-app.js";

export const GITHUB_LOGIN_ACCESS_NOTICE = `Lax requests GitHub authorization to:
  - read your public GitHub profile to verify your identity; and
  - read and write issues and issue comments in lax-archive/lax.
This token cannot write repository contents or access lax-database or lax-website.`;

export async function login(): Promise<void> {
  console.log(GITHUB_LOGIN_ACCESS_NOTICE);
  const device = await requestDeviceCode(GITHUB_APP_CLIENT_ID);
  console.log(`Open ${device.verification_uri} and enter code ${device.user_code}`);
  const deadline = Date.now() + device.expires_in * 1_000;
  let interval = Math.max(device.interval, 5);
  // The device flow is minutes of polling; a heartbeat on stdout keeps the
  // wait visible (spinning on a TTY, printed once when redirected) instead of
  // leaving the terminal silent between polls.
  const waiting = new LoadingLine(process.stdout);
  const heartbeat = `waiting for authorization (visit ${device.verification_uri}, code ${device.user_code})`;
  try {
    while (Date.now() < deadline) {
      waiting.update(heartbeat);
      await delay(interval * 1_000);
      const response = await requestDeviceToken(
        GITHUB_APP_CLIENT_ID,
        device.device_code,
        CONTROL_REPOSITORY_ID,
      );
      if (response.access_token !== undefined) {
        const credentials = credentialsFromTokenResponse(response, GITHUB_APP_CLIENT_ID);
        const user = await GitHubClient.forGitHubAppUser(credentials.accessToken).request<{
          login: string;
        }>("GET", "/user");
        storeGitHubAppCredentials(credentials);
        waiting.clear();
        console.log(`Logged in as ${user.login} through the Lax GitHub App.`);
        return;
      }
      if (response.error === "authorization_pending") continue;
      if (response.error === "slow_down") {
        interval += 5;
        continue;
      }
      throw new Error(
        typeof response.error_description === "string"
          ? response.error_description
          : typeof response.error === "string"
            ? response.error
            : "GitHub login failed",
      );
    }
  } finally {
    waiting.clear();
  }
  throw new Error("GitHub device code expired; run `lax login` again");
}
