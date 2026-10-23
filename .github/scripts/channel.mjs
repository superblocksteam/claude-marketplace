import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Channel, ChannelMarketplace } from "./channels.mjs";
import { ChannelBranch } from "./forward-channel.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const commands = {
  pin: (channel, spec = channel.distTag) => {
    channel.pinTo(root, spec);
    channel.brand(root);
  },
  version: (channel) => {
    channel.assertCurrent(root);
    channel.brand(root);
  },
  install: (channel, pluginDirectory) => channel.install(resolve(pluginDirectory)),
  marketplace: (channel, destination) =>
    new ChannelMarketplace(channel, root).write(resolve(destination)),
  verify: (channel, destination) => channel.verify(root, resolve(destination)),
  "assert-public": (channel) => channel.assertPublic(),
  prepare: (channel, sourceSha) => {
    const result = new ChannelBranch(channel, root).prepare(sourceSha);
    console.log(`${channel.branch} candidate: ${JSON.stringify(result)}`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `commit=${result.commit}\n`);
  },
  publish: (channel, commit) => {
    const result = new ChannelBranch(channel, root).publish(commit);
    console.log(`${channel.branch}: ${JSON.stringify(result)}`);
  },
};

const [command, name, ...args] = process.argv.slice(2);
if (!Object.hasOwn(commands, command) || !name) {
  throw new Error(
    "Usage: node channel.mjs <pin|version|install|marketplace|verify|assert-public|prepare|publish> <channel> [arguments]",
  );
}
commands[command](Channel.named(name), ...args);
