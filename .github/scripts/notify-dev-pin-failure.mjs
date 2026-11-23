/** Sends a Slack alert for an unsuccessful dev CLI pin update. */

import { setTimeout as sleep } from "node:timers/promises";

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 2_000];
const MAX_RETRY_AFTER_SECONDS = 60;

/** Delivers a workflow failure alert to Slack with bounded retries. */
class DevPinFailure {
  #env;

  constructor(env) {
    this.#env = env;
  }

  /** Posts the alert and reports delivery without exposing webhook credentials. */
  async deliver() {
    const webhook = this.#env.SLACK_WEBHOOK_URL;
    if (!webhook)
      throw new Error("Configure STAGING_SLACK_WEBHOOK_URL for dev pin failure notifications.");
    if (!URL.canParse(webhook))
      throw new Error("Dev pin failure notification could not be delivered. Check webhook access.");

    const body = JSON.stringify({ message: this.#message() });
    const attempts = RETRY_DELAYS_MS.length + 1;
    let attempt = 0;
    for (const delay of [...RETRY_DELAYS_MS, undefined]) {
      attempt += 1;
      const delivery = await this.#post(webhook, body);
      if (delivery.ok) return;
      const final = delay === undefined || !delivery.retryable;
      console.error(
        `Delivery attempt ${attempt} of ${attempts} failed (${delivery.reason})${final ? "" : "; retrying"}.`,
      );
      if (final) throw new Error(delivery.error);
      await sleep(Math.max(delay, delivery.retryAfterMs));
    }
  }

  #message() {
    if (!/^\d+$/.test(this.#env.GITHUB_RUN_ID ?? ""))
      throw new Error("A GitHub run ID is required for dev pin failure notifications.");

    const jobs = ["credentials", "prepare", "verify", "publish"].filter(
      (job) => this.#env[`${job.toUpperCase()}_RESULT`] === "failure",
    );
    const dispatch = this.#env.GITHUB_EVENT_NAME === "repository_dispatch";
    const trigger = dispatch ? "repository_dispatch" : "workflow_dispatch";
    const prepared = this.#env.PREPARED_CLI_VERSION || "";
    const version = prepared || this.#env.DISPATCH_CLI_VERSION || "";
    const label = prepared ? "CLI version" : "Requested CLI version (unverified)";
    const displayVersion =
      version.length <= 128 &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
        ? version
        : "unavailable";
    const runUrl = `${this.#env.GITHUB_SERVER_URL}/${this.#env.GITHUB_REPOSITORY}/actions/runs/${this.#env.GITHUB_RUN_ID}`;
    const restart = "start a new Update dev pin workflow on main";
    const recovery = dispatch ? restart : `re-run all jobs or ${restart}`;
    return (
      `:warning: Dev CLI pin update failed. Failed jobs: ${jobs.join(", ") || "unavailable"}. ` +
      `${displayVersion === "unavailable" ? "CLI version" : label}: ${displayVersion}. Trigger: ${trigger}. Check ${runUrl}. ` +
      `Fix the failing job, then ${recovery} to prepare and verify the current @master version.`
    );
  }

  async #post(webhook, body) {
    let response;
    try {
      response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = error?.cause?.code ?? error?.code;
      const kind = /^[A-Z0-9_]{3,64}$/.test(cause ?? "") ? cause : (error?.name ?? "Error");
      return {
        reason: `network error ${kind}`,
        ok: false,
        retryable: true,
        retryAfterMs: 0,
        error: "Dev pin failure notification could not be delivered. Check webhook access.",
      };
    }

    response.body?.cancel().catch(() => {});
    const { ok, status, headers } = response;
    const retryAfter = headers.get("Retry-After") ?? "";
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
    return {
      ok,
      reason: `HTTP ${status}`,
      retryable: status >= 500 || (status === 429 && seconds <= MAX_RETRY_AFTER_SECONDS),
      retryAfterMs: status === 429 ? seconds * 1_000 : 0,
      error: `Dev pin failure notification failed (HTTP ${status}).`,
    };
  }
}

await new DevPinFailure(process.env).deliver();
console.log("Sent dev pin failure notification.");
