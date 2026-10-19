import { fileURLToPath } from "node:url";

import { Channel } from "./channels.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const channel = Channel.current(root);
const commands = {
  pin: (spec) => console.log(channel.pinTo(root, spec) ? "CLI pin updated." : "CLI pin unchanged."),
  install: () => channel.install(channel.pinDirectory(root)),
  validate: () => channel.validate(root),
  info: () => {
    channel.validate(root);
    console.log(
      `channel=${channel.name}\nbranch=${channel.branch}\ncli_version=${channel.cliVersion(root)}`,
    );
  },
  "assert-public": () => channel.assertPublic(),
};

const [command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(commands, command) || args.length > (command === "pin" ? 1 : 0)) {
  throw new Error("Usage: node channel.mjs <pin [VERSION]|install|validate|info|assert-public>");
}
commands[command](...args);
