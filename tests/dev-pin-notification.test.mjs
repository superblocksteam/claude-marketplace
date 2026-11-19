import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

class NotificationFixture {
  requests = [];

  async start(t, status = 200) {
    this.server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      this.requests.push({ method: request.method, headers: request.headers, body });
      response.writeHead(status, { Location: this.webhook });
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
      ":warning: Dev CLI pin update failed. Check https://github.com/superblocksteam/claude-marketplace/actions/runs/98765. Fix the failing job, then re-run all jobs or start a new Update dev pin workflow on main to prepare and verify the current @master version.",
  });
});

test("a webhook redirect fails without forwarding credentials to another endpoint", async (t) => {
  const fixture = await new NotificationFixture().start(t, 307);
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
  const fixture = await new NotificationFixture().start(t, 500);
  const result = await fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /HTTP 500/);
  assert.equal(fixture.requests.length, 1);
});

test("invalid webhook configuration cannot leak credentials through fetch errors", async (t) => {
  const fixture = await new NotificationFixture().start(t);
  const result = await fixture.run({ SLACK_WEBHOOK_URL: "fixture-webhook-secret" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /could not be delivered/);
  assert.equal(fixture.requests.length, 0);
});
