import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { dependencies } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const DEFAULT_CLI_PACKAGE = `@superblocksteam/cli@${dependencies["@superblocksteam/cli"]}`;
const NO_PIN_ERRORS = ["ENOENT", "ENOTDIR"];
const TRUE_VALUES = ["true", "1", "yes", "y"];
const FALSE_VALUES = ["false", "0", "no", "n"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function pinFilePath() {
  try {
    return join(homedir(), ".superblocks", "plugin.json");
  } catch {
    return undefined;
  }
}

function readPinnedPackage() {
  const pinFile = pinFilePath();
  if (!pinFile) return undefined;
  let contents;
  try {
    contents = readFileSync(pinFile, "utf8");
  } catch (error) {
    if (NO_PIN_ERRORS.includes(error.code)) return undefined;
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
    readPinnedPackage() ?? {
      source: "The plugin default",
      spec: DEFAULT_CLI_PACKAGE,
      installed: true,
    }
  );
}

function readBrowserLogin() {
  const value = process.env.SUPERBLOCKS_MCP_BROWSER_LOGIN?.trim().toLowerCase();
  if (!value || TRUE_VALUES.includes(value)) return "true";
  if (FALSE_VALUES.includes(value)) return "false";
  fail("SUPERBLOCKS_MCP_BROWSER_LOGIN must be true or false.");
}

const { source: packageSource, spec: packageSpec, installed = false } = selectPackage();
const packageMatch = packageSpec.match(/^@superblocksteam\/(cli(?:-ephemeral)?)(?:@(.+))?$/);
if (!packageMatch) {
  fail(`${packageSource} must select @superblocksteam/cli or @superblocksteam/cli-ephemeral.`);
}
const [, packageName, selector] = packageMatch;
if (
  selector &&
  !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(selector) &&
  !/^file:[A-Za-z0-9_./:+-]+$/.test(selector)
) {
  fail(`${packageSource} must use an exact version, tag, or file URL.`);
}
const browserLogin = readBrowserLogin();

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
const scopedRegistry = githubOnly ? "https://npm.pkg.github.com/" : "https://registry.npmjs.org/";
const registryArgs = [
  "--registry=https://registry.npmjs.org/",
  `--@superblocksteam:registry=${scopedRegistry}`,
];
// --prefer-online re-resolves the package on every launch and reinstalls in
// the foreground whenever the tag moves, which outlasts the host's ~10s MCP
// connect window. Launch from npm's cache and refresh that cache in the
// background, so a moved tag is picked up on the next launch.
const npxArgs = [
  "--yes",
  "--prefer-offline",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  ...registryArgs,
  `--package=${packageSpec}`,
  "--",
  "superblocks",
  "mcp",
  "serve",
];
const command = installed ? process.execPath : "npx";
const args = installed
  ? [
      fileURLToPath(new URL("../node_modules/@superblocksteam/cli/bin/run.js", import.meta.url)),
      "mcp",
      "serve",
    ]
  : npxArgs;
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !["NPM_CONFIG_PACKAGE", "SUPERBLOCKS_CLI_PACKAGE"].includes(name.toUpperCase()),
    ),
  ),
  SUPERBLOCKS_MCP_BROWSER_LOGIN: browserLogin,
};

if (Number(process.versions.node.split(".")[0]) < 24) {
  fail("Node.js 24 or newer is required to run Superblocks MCP.");
}
console.error(
  `Superblocks MCP package: ${packageSpec} (source: ${packageSource}; registry: ${scopedRegistry}${
    githubOnly ? ", requires npm authentication" : ""
  }).`,
);
if (!installed && !selector?.startsWith("file:")) {
  const cacheAddArgs = ["cache", "add", packageSpec, "--prefer-online", ...registryArgs];
  try {
    (process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/D", "/S", "/C", "npm.cmd", ...cacheAddArgs], {
          detached: true,
          env,
          stdio: "ignore",
          windowsHide: true,
        })
      : spawn("npm", cacheAddArgs, { detached: true, env, stdio: "ignore" })
    )
      .on("error", () => {})
      .unref();
  } catch {}
}
if (process.platform !== "win32" && typeof process.execve === "function") {
  try {
    process.execve(
      installed ? command : "/usr/bin/env",
      installed ? [command, ...args] : ["env", command, ...args],
      env,
    );
  } catch {}
}

const result =
  process.platform === "win32" && !installed
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/D", "/S", "/C", "npx.cmd", ...npxArgs], {
        env,
        stdio: "inherit",
        windowsHide: true,
      })
    : spawnSync(command, args, { env, stdio: "inherit" });
if (result.error) {
  console.error(`Could not start the Superblocks CLI: ${result.error.message}`);
  process.exitCode = 1;
} else {
  if (result.signal) console.error(`Superblocks CLI terminated by ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}
