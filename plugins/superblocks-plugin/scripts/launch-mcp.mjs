import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CLI_PACKAGE = "@superblocksteam/cli@beta";
const NO_SETTINGS_ERRORS = ["ENOENT", "ENOTDIR"];
const TRUE_VALUES = ["true", "1", "yes", "y"];
const FALSE_VALUES = ["false", "0", "no", "n"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

class UserSettings {
  #path;
  #values;

  get #settings() {
    this.#values ??= this.#read();
    return this.#values;
  }

  #read() {
    try {
      this.#path = join(homedir(), ".superblocks", "plugin.json");
    } catch {
      return {};
    }
    let contents;
    try {
      contents = readFileSync(this.#path, "utf8");
    } catch (error) {
      if (NO_SETTINGS_ERRORS.includes(error.code)) return {};
      fail(`Could not read ${this.#path}: ${error.message}`);
    }
    let settings;
    try {
      settings = JSON.parse(contents);
    } catch {
      fail(`${this.#path} is not valid JSON.`);
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      fail(`${this.#path} must contain a JSON object.`);
    }
    return settings;
  }

  resolve(envName, settingName) {
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return { source: envName, value: fromEnv };
    const setting = this.#settings[settingName];
    if (setting === undefined) return undefined;
    const source = `${settingName} in ${this.#path}`;
    if (typeof setting !== "string") fail(`${source} must be a string.`);
    return setting.trim() ? { source, value: setting.trim() } : undefined;
  }
}

function readBrowserLogin() {
  const value = process.env.SUPERBLOCKS_MCP_BROWSER_LOGIN?.trim().toLowerCase();
  if (!value || TRUE_VALUES.includes(value)) return "true";
  if (FALSE_VALUES.includes(value)) return "false";
  fail("SUPERBLOCKS_MCP_BROWSER_LOGIN must be true or false.");
}

const userSettings = new UserSettings();
const { source: packageSource, value: packageSpec } = userSettings.resolve(
  "SUPERBLOCKS_CLI_PACKAGE",
  "cliPackage",
) ?? { source: "The plugin default", value: DEFAULT_CLI_PACKAGE };
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
const browserLogin = readBrowserLogin();

const server = userSettings.resolve("SUPERBLOCKS_SERVER_URL", "serverUrl");
if (server) {
  let url;
  try {
    url = new URL(server.value);
  } catch {
    fail(`${server.source} must be a Superblocks server origin.`);
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
    fail(`${server.source} must be an HTTPS origin (HTTP only on loopback).`);
  }
}
if (browserLogin === "false" && server) {
  fail(`Remove ${server.source} when SUPERBLOCKS_MCP_BROWSER_LOGIN is false.`);
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
  ...(server && { SUPERBLOCKS_SERVER_URL: server.value }),
};

if (Number(process.versions.node.split(".")[0]) < 24) {
  fail("Node.js 24 or newer is required to run Superblocks MCP.");
}
console.error(
  `Superblocks MCP package: ${packageSpec} (source: ${packageSource}; registry: ${scopedRegistry}${
    githubOnly ? ", requires npm authentication" : ""
  }).`,
);
if (server) {
  console.error(`Superblocks MCP server: ${server.value} (source: ${server.source}).`);
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
