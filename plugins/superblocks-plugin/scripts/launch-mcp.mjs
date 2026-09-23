import { spawnSync } from "node:child_process";

const packageSpec = process.env.SUPERBLOCKS_CLI_PACKAGE?.trim();
if (!packageSpec) {
  console.error(
    "SUPERBLOCKS_CLI_PACKAGE must select the Superblocks CLI package.",
  );
  process.exit(1);
}
const packageMatch = packageSpec.match(
  /^@superblocksteam\/cli(?:-ephemeral)?(?:@(.+))?$/,
);
if (!packageMatch) {
  console.error(
    "SUPERBLOCKS_CLI_PACKAGE must select @superblocksteam/cli or @superblocksteam/cli-ephemeral.",
  );
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

const serverUrl = process.env.SUPERBLOCKS_SERVER_URL;
if (serverUrl) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    console.error("SUPERBLOCKS_SERVER_URL must be a Superblocks server origin.");
    process.exit(1);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    console.error("SUPERBLOCKS_SERVER_URL must be an HTTPS origin (HTTP only on loopback).");
    process.exit(1);
  }
}
if (process.env.SUPERBLOCKS_MCP_BROWSER_LOGIN === "false" && serverUrl) {
  console.error("Remove SUPERBLOCKS_SERVER_URL when SUPERBLOCKS_MCP_BROWSER_LOGIN is false.");
  process.exit(1);
}

const scopedRegistry = packageSpec.startsWith("@superblocksteam/cli-ephemeral")
  ? "https://npm.pkg.github.com/"
  : "https://registry.npmjs.org/";
const npxArgs = [
  "--yes",
  "--prefer-online",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=https://registry.npmjs.org/",
  `--@superblocksteam:registry=${scopedRegistry}`,
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

if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("Node.js 24 or newer is required to run Superblocks MCP.");
  process.exit(1);
}
if (process.platform !== "win32" && typeof process.execve === "function") {
  try {
    process.execve("/usr/bin/env", ["env", "npx", ...npxArgs], env);
  } catch {}
}

const result =
  process.platform === "win32"
    ? spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/D", "/S", "/C", "npx.cmd", ...npxArgs],
        { env, stdio: "inherit", windowsHide: true },
      )
    : spawnSync("npx", npxArgs, { env, stdio: "inherit" });
if (result.error) {
  console.error(`Could not start the Superblocks CLI: ${result.error.message}`);
  process.exitCode = 1;
} else {
  if (result.signal)
    console.error(`Superblocks CLI terminated by ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}
