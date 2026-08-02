import { setTimeout as delay } from "node:timers/promises";
import { CONTROL_REPOSITORY_ID } from "../shared/constants.js";
import { GitHubClient } from "../shared/github.js";
import { storeGitHubAppCredentials } from "./auth.js";
import {
  credentialsFromTokenResponse,
  GITHUB_APP_CLIENT_ID,
  requestDeviceCode,
  requestDeviceToken,
} from "./github-app.js";

export async function login(): Promise<void> {
  const device = await requestDeviceCode(GITHUB_APP_CLIENT_ID);
  console.log(`Open ${device.verification_uri} and enter code ${device.user_code}`);
  const deadline = Date.now() + device.expires_in * 1_000;
  let interval = Math.max(device.interval, 5);
  while (Date.now() < deadline) {
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
  throw new Error("GitHub device code expired; run `lax login` again");
}
