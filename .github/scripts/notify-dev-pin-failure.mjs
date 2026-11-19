const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook)
  throw new Error("Configure STAGING_SLACK_WEBHOOK_URL for dev pin failure notifications.");
if (!/^\d+$/.test(process.env.GITHUB_RUN_ID ?? ""))
  throw new Error("A GitHub run ID is required for dev pin failure notifications.");

const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const message = `:warning: Dev CLI pin update failed. Check ${runUrl}. Fix the failing job, then re-run all jobs or start a new Update dev pin workflow on main to prepare and verify the current @master version.`;
let response;
try {
  response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
} catch {
  throw new Error("Dev pin failure notification could not be delivered. Check webhook access.");
}
if (!response.ok) throw new Error(`Dev pin failure notification failed (HTTP ${response.status}).`);
console.log("Sent dev pin failure notification.");
