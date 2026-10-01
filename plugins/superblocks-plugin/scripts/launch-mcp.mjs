import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CLI_PACKAGE = "@superblocksteam/cli@beta";
const pinFile = join(homedir(), ".superblocks", "plugin.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readPinnedPackage() {
  let contents;
  try {
    contents = readFileSync(pinFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    fail(`Could not read ${pinFile}: ${error.message}`);
  }
  let pin;
  try {
    pin = JSON.parse(contents);
  } catch {
    fail(`${pinFile} is not valid JSON.`);
  }
  if (typeof pin !== "object" || pin === null || Array.isArray(pin)) {
    fail(`${pinFile} must contain a JSON object.`);
  }
  if (pin.cliPackage === undefined) return undefined;
  if (typeof pin.cliPackage !== "string") {
    fail(`cliPackage in ${pinFile} must be a string.`);
  }
  return { source: `cliPackage in ${pinFile}`, spec: pin.cliPackage.trim() };
}

function selectPackage() {
  const fromEnv = process.env.SUPERBLOCKS_CLI_PACKAGE?.trim();
  if (fromEnv) return { source: "SUPERBLOCKS_CLI_PACKAGE", spec: fromEnv };
  return (
    readPinnedPackage() ?? { source: "The default package", spec: DEFAULT_CLI_PACKAGE }
  );
}

const { source: packageSource, spec: packageSpec } = selectPackage();
const packageMatch = packageSpec.match(
  /^@superblocksteam\/(cli(?:-ephemeral)?)(?:@(.+))?$/,
);
if (!packageMatch) {
  fail(
    `${packageSource} must select @superblocksteam/cli or @superblocksteam/cli-ephemeral.`,
  );
}
const [, packageName, selector] = packageMatch;
if (
  selector &&
  !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(selector) &&
  !/^file:[A-Za-z0-9_./:+-]+$/.test(selector)
) {
  fail(`${packageSource} must use an exact version, tag, or file URL.`);
}
const browserLogin = process.env.SUPERBLOCKS_MCP_BROWSER_LOGIN ?? "true";

const serverUrl = process.env.SUPERBLOCKS_SERVER_URL;
if (serverUrl) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    fail("SUPERBLOCKS_SERVER_URL must be a Superblocks server origin.");
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
    fail("SUPERBLOCKS_SERVER_URL must be an HTTPS origin (HTTP only on loopback).");
  }
}
if (browserLogin === "false" && serverUrl) {
  fail("Remove SUPERBLOCKS_SERVER_URL when SUPERBLOCKS_MCP_BROWSER_LOGIN is false.");
}

const githubOnly = packageName === "cli-ephemeral" || selector === "master";
const scopedRegistry = githubOnly
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
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !["NPM_CONFIG_PACKAGE", "SUPERBLOCKS_CLI_PACKAGE"].includes(
          name.toUpperCase(),
        ),
    ),
  ),
  SUPERBLOCKS_MCP_BROWSER_LOGIN: browserLogin,
};

if (Number(process.versions.node.split(".")[0]) < 24) {
  fail("Node.js 24 or newer is required to run Superblocks MCP.");
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
