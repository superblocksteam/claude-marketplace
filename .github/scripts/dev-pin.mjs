import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DevPinUpdate } from "./update-dev-pin.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const update = new DevPinUpdate(root);
const [command, commit, destination] = process.argv.slice(2);
if (command === "prepare") {
  const result = update.prepare();
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `commit=${result.commit}\nchanged=${result.changed}\n`,
    );
} else if (command === "verify" && commit && destination) {
  update.verify(commit, resolve(destination));
} else if (command === "publish" && commit) {
  if (!process.env.GH_TOKEN)
    throw new Error("Configure CHANNEL_PUBLISH_TOKEN with contents write permission.");
  console.log(update.publish(commit));
} else {
  throw new Error("Usage: node dev-pin.mjs <prepare|verify|publish> [commit] [destination]");
}
