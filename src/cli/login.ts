import { setTimeout as delay } from "node:timers/promises";
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID } from "../shared/constants.js";
import { GitHubClient } from "../shared/github.js";
import { storeGitHubAppCredentials } from "./auth.js";
import {
  credentialsFromTokenResponse,
  GITHUB_APP_CLIENT_ID,
  requestDeviceCode,
  requestDeviceToken,
} from "./github-app.js";
import * as ui from "./ui.js";

/**
 * What the author is about to authorize, in their own terms. Printed *above*
 * the code: it is a thing to read before authorizing, not after.
 */
export const GITHUB_LOGIN_ACCESS_NOTICE = [
  `Lax will be able to read your public GitHub profile and post issues and`,
  `comments to ${CONTROL_REPOSITORY} as you. It cannot write repository contents,`,
  `and it has no access to lax-database or lax-website.`,
];

export async function login(): Promise<void> {
  ui.title("Sign in to GitHub");
  for (const text of GITHUB_LOGIN_ACCESS_NOTICE) ui.line(text);
  const device = await requestDeviceCode(GITHUB_APP_CLIENT_ID);
  ui.blank();
  // Keep the URL free of trailing punctuation: terminals linkify up to the next
  // whitespace, so a comma or paren right after it breaks the link.
  ui.aside("Open      ", device.verification_uri);
  ui.aside("Enter code", ui.bold(device.user_code));

  const deadline = Date.now() + device.expires_in * 1_000;
  let interval = Math.max(device.interval, 5);
  // The device flow is minutes of polling, so the wait is a row of its own
  // rather than a silent terminal between polls.
  const steps = new ui.Steps();
  steps.add("authorize", "Waiting for you to authorize");
  try {
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
        steps.settle("authorize", { label: `Signed in as ${user.login}`, time: false });
        steps.finish();
        ui.done();
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
    steps.finish();
  }
  throw new Error("the GitHub device code expired; run `lax login` again");
}
