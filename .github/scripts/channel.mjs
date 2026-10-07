import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Channel, ChannelBranch, ChannelMarketplace } from "./channels.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const commands = {
  pin: (channel, spec = channel.distTag) => channel.pinTo(root, spec),
  install: (channel, pluginDirectory) => channel.install(resolve(pluginDirectory)),
  marketplace: (channel, destination, sourceSha) =>
    new ChannelMarketplace(channel, root).write(resolve(destination), sourceSha),
  "assert-public": (channel) => channel.assertPublic(),
  publish: (channel, sourceSha) => {
    const { published, commit } = new ChannelBranch(channel, root).publish(sourceSha);
    console.log(`${channel.branch}: ${published ? "published" : "unchanged at"} ${commit}`);
  },
};

const [command, name, ...args] = process.argv.slice(2);
if (!(command in commands) || !name) {
  throw new Error(
    "Usage: node channel.mjs <pin|install|marketplace|assert-public|publish> <channel> [arguments]",
  );
}
commands[command](Channel.named(name), ...args);
