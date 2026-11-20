/** Exercises the dev pin notifier through its HTTP request and CLI exit status. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

class NotificationFixture {
  requests = [];

  async start(t, ...replies) {
    this.server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      this.requests.push({
        method: request.method,
        headers: request.headers,
        body,
        time: performance.now(),
      });
      const reply = replies[this.requests.length - 1] ?? replies.at(-1) ?? { status: 200 };
      response.writeHead(reply.status, {
        Location: this.webhook,
        ...reply.headers,
      });
      response.end("fixture-webhook-secret");
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    t.after(() => new Promise((resolve) => this.server.close(resolve)));
    this.webhook = `http://127.0.0.1:${this.server.address().port}/fixture-webhook-secret`;
    return this;
  }

  async run(overrides = {}) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../.github/scripts/notify-dev-pin-failure.mjs", import.meta.url))],
      {
        env: {
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "superblocksteam/claude-marketplace",
          GITHUB_RUN_ID: "98765",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          PUBLISH_RESULT: "failure",
          PREPARED_CLI_VERSION: "2.0.0-SNAPSHOT.ae9733",
          SLACK_WEBHOOK_URL: this.webhook,
          ...overrides,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [status] = await once(child, "close");
    assert.ok(!output.includes("fixture-webhook-secret"), "Webhook credentials must stay private");
    return { status, output };
  }
}

test("dev pin failures send a Slack workflow message with a run link and recovery instructions", async (t) => {
  const fixture = await new NotificationFixture().start(t);
  const result = await fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(fixture.requests.length, 1);
  const [request] = fixture.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    message:
      ":warning: Dev CLI pin update failed. Failed jobs: publish. CLI version: 2.0.0-SNAPSHOT.ae9733. Trigger: workflow_dispatch. Check https://github.com/superblocksteam/claude-marketplace/actions/runs/98765. Fix the failing job, then re-run all jobs or start a new Update dev pin workflow on main to prepare and verify the current @master version.",
  });
});

test("a dispatch alert identifies the failed job and exact CLI and directs responders to a fresh run", async (t) => {
  const fixture = await new NotificationFixture().start(t);
  const result = await fixture.run({
    GITHUB_EVENT_NAME: "repository_dispatch",
    VERIFY_RESULT: "failure",
    PUBLISH_RESULT: "skipped",
    PREPARED_CLI_VERSION: "",
    DISPATCH_CLI_VERSION: "2.0.0-SNAPSHOT.aa736fe1dc9d8e89",
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(fixture.requests.length, 1);
  const { message } = JSON.parse(fixture.requests[0].body);
  assert.match(message, /Failed jobs: verify\./);
  assert.match(message, /Trigger: repository_dispatch\./);
  assert.match(
    message,
    /Requested CLI version \(unverified\): 2\.0\.0-SNAPSHOT\.aa736fe1dc9d8e89\./,
  );
  assert.match(message, /start a new Update dev pin workflow on main/);
  assert.doesNotMatch(message, /re-run all jobs|Failed jobs:.*publish/i);
});

test("a webhook redirect fails without forwarding credentials to another endpoint", async (t) => {
  const fixture = await new NotificationFixture().start(t, { status: 307 });
  const result = await fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal(fixture.requests.length, 1);
});

test("missing run metadata cannot send an unusable failure notification", async (t) => {
  const fixture = await new NotificationFixture().start(t);
  const result = await fixture.run({ GITHUB_RUN_ID: "" });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.requests.length, 0);
});

test("missing notification credentials fail with setup instructions and no request", async (t) => {
  const fixture = await new NotificationFixture().start(t);
  const result = await fixture.run({ SLACK_WEBHOOK_URL: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Configure STAGING_SLACK_WEBHOOK_URL/);
  assert.equal(fixture.requests.length, 0);
});

test("a rejected webhook fails without logging its response body", async (t) => {
  const fixture = await new NotificationFixture().start(t, { status: 400 });
  const result = await fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /HTTP 400/);
  assert.equal(fixture.requests.length, 1);
});

test("a transient webhook server error is retried with the same alert", async (t) => {
  const fixture = await new NotificationFixture().start(t, { status: 503 }, { status: 200 });
  const result = await fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[0].body, fixture.requests[1].body);
});

test("a Slack rate limit delays the next delivery attempt until Retry-After", async (t) => {
  const fixture = await new NotificationFixture().start(
    t,
    { status: 429, headers: { "Retry-After": "2" } },
    { status: 200 },
  );
  const result = await fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests[1].time - fixture.requests[0].time >= 1_950);
});

test("an invalid dispatch version cannot inject a Slack mention", async (t) => {
  const fixture = await new NotificationFixture().start(t);
  const result = await fixture.run({
    GITHUB_EVENT_NAME: "repository_dispatch",
    PREPARE_RESULT: "failure",
    PUBLISH_RESULT: "skipped",
    PREPARED_CLI_VERSION: "",
    DISPATCH_CLI_VERSION: "2.0.0 <!channel>",
  });
  assert.equal(result.status, 0, result.output);
  const { message } = JSON.parse(fixture.requests[0].body);
  assert.match(message, /Failed jobs: prepare\. CLI version: unavailable\./);
  assert.doesNotMatch(message, /<!channel>/);
});

test("invalid webhook configuration cannot leak credentials through fetch errors", async (t) => {
  const fixture = await new NotificationFixture().start(t);
  const result = await fixture.run({
    SLACK_WEBHOOK_URL: "fixture-webhook-secret",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /could not be delivered/);
  assert.equal(fixture.requests.length, 0);
});

test("retried deliveries log each failed attempt without webhook details", async (t) => {
  const fixture = await new NotificationFixture().start(t, { status: 503 }, { status: 200 });
  const result = await fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /attempt 1 of 3 failed \(HTTP 503\); retrying/i);
});

test("network failures report the error category without webhook details", async (t) => {
  const fixture = await new NotificationFixture().start(t);
  await new Promise((resolve) => fixture.server.close(resolve));
  fixture.server.listen = undefined;
  const result = await fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /ECONNREFUSED/);
  assert.match(result.output, /attempt 1 of 3 failed/i);
});
