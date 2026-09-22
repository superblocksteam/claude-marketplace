import { spawnSync } from "node:child_process";

const packageSpec = process.env.SUPERBLOCKS_CLI_PACKAGE?.trim();
if (!packageSpec) {
  console.error(
    "SUPERBLOCKS_CLI_PACKAGE must select the Superblocks CLI package.",
  );
  process.exit(1);
}
const packageMatch = packageSpec.match(
  /^@superblocksteam\/cli(?:@(.+))?$/,
);
if (!packageMatch) {
  console.error("SUPERBLOCKS_CLI_PACKAGE must select @superblocksteam/cli.");
  process.exit(1);
}
const selector = packageMatch[1];
if (
  selector &&
  !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(selector) &&
  !/^file:[A-Za-z0-9_./:+-]+$/.test(selector)
) {
  console.error(
    "SUPERBLOCKS_CLI_PACKAGE must use an exact version, tag, or file URL.",
  );
  process.exit(1);
}

const npxArgs = [
  "--yes",
  "--prefer-online",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=https://registry.npmjs.org/",
  "--@superblocksteam:registry=https://registry.npmjs.org/",
  `--package=${packageSpec}`,
  "--",
  "superblocks",
  "mcp",
  "serve",
];
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !["NPM_CONFIG_PACKAGE", "SUPERBLOCKS_CLI_PACKAGE"].includes(
        name.toUpperCase(),
      ),
  ),
);

if (process.platform !== "win32") {
  if (typeof process.execve !== "function") {
    console.error("Node.js 24 or newer is required to run Superblocks MCP.");
    process.exit(1);
  }
  try {
    process.execve("/usr/bin/env", ["env", "npx", ...npxArgs], env);
  } catch (error) {
    console.error(`Could not start the Superblocks CLI: ${error.message}`);
    process.exit(1);
  }
}

const result = spawnSync(
  process.env.ComSpec ?? "cmd.exe",
  ["/D", "/S", "/C", "npx.cmd", ...npxArgs],
  { env, stdio: "inherit", windowsHide: true },
);
if (result.error) {
  console.error(`Could not start the Superblocks CLI: ${result.error.message}`);
  process.exitCode = 1;
} else {
  if (result.signal)
    console.error(`Superblocks CLI terminated by ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}
