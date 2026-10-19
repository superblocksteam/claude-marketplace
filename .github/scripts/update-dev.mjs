import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DevPinUpdate } from "./dev-pin.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const [command, ...args] = process.argv.slice(2);
const update = new DevPinUpdate(root);
if (command === "prepare" && args.length === 1) {
  const result = update.prepare(...args);
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${result.changed}\nsource_sha=${result.sourceSha}\npin_digest=${result.pinDigest || ""}\n`,
    );
} else if (command === "publish" && args.length === 2) {
  console.log(JSON.stringify(update.publish(...args)));
} else {
  throw new Error("Usage: node update-dev.mjs <prepare VERSION|publish VERSION DIGEST>");
}
