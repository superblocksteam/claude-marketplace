import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TRUE_VALUES = ["true", "1", "yes", "y"];
const FALSE_VALUES = ["false", "0", "no", "n"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readBrowserLogin() {
  const value = process.env.SUPERBLOCKS_MCP_BROWSER_LOGIN?.trim().toLowerCase();
  if (!value || TRUE_VALUES.includes(value)) return "true";
  if (FALSE_VALUES.includes(value)) return "false";
  fail("SUPERBLOCKS_MCP_BROWSER_LOGIN must be true or false.");
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

const command = process.execPath;
const args = [
  fileURLToPath(new URL("../node_modules/@superblocksteam/cli/bin/run.js", import.meta.url)),
  "mcp",
  "serve",
];
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
console.error("Superblocks MCP CLI: installed plugin dependency.");
if (process.platform !== "win32" && typeof process.execve === "function") {
  try {
    process.execve(command, [command, ...args], env);
  } catch {}
}

const result = spawnSync(command, args, { env, stdio: "inherit", windowsHide: true });
if (result.error) {
  console.error(`Could not start the Superblocks CLI: ${result.error.message}`);
  process.exitCode = 1;
} else {
  if (result.signal) console.error(`Superblocks CLI terminated by ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}
