import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoFile = (path) => new URL(`../${path}`, import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(repoFile(path), "utf8"));

test("Superblocks exposes the editable CLI package value", async () => {
  const [marketplace, manifest, mcp] = await Promise.all([
    readJson(".claude-plugin/marketplace.json"),
    readJson("plugins/superblocks-plugin/.claude-plugin/plugin.json"),
    readJson("plugins/superblocks-plugin/.mcp.json"),
  ]);
  const server = mcp.mcpServers.superblocks;

  assert.equal(marketplace.plugins[0].version, manifest.version);
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, [
    "${CLAUDE_PLUGIN_ROOT}/scripts/launch-mcp.mjs",
  ]);
  assert.equal(server.env.NPM_CONFIG_PACKAGE, "@superblocksteam/cli@beta");
  assert.equal("SUPERBLOCKS_MCP_BROWSER_LOGIN" in server.env, false);
  assert.equal("SUPERBLOCKS_SERVER_URL" in server.env, false);
});

test("npx installs the package selected by NPM_CONFIG_PACKAGE", async (t) => {
  const mcp = await readJson("plugins/superblocks-plugin/.mcp.json");
  const server = mcp.mcpServers.superblocks;
  const packageEnvName = Object.entries(server.env).find(
    ([, value]) => value === "@superblocksteam/cli@beta",
  )?.[0];
  assert.equal(packageEnvName, "NPM_CONFIG_PACKAGE");

  const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-npx-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const packageDirectory = join(directory, "package");
  await mkdir(packageDirectory);
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      bin: { superblocks: "superblocks.js" },
      name: "superblocks-cli-test",
      version: "1.0.0",
    }),
  );
  const executable = join(packageDirectory, "superblocks.js");
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdout.write("configured package\\n");\n',
  );
  await chmod(executable, 0o755);

  const launcher = fileURLToPath(
    repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
  );
  const { stdout } = await execFile(
    process.execPath,
    [launcher],
    {
      cwd: directory,
      env: {
        ...process.env,
        [packageEnvName]: pathToFileURL(packageDirectory).href,
        NPM_CONFIG_CACHE: join(directory, "cache"),
        NPM_CONFIG_OFFLINE: "true",
        npm_config_package: "package-that-must-not-run",
      },
    },
  );
  assert.equal(stdout, "configured package\n");
});

test("MCP launch fails closed without a configured package", async () => {
  const launcher = fileURLToPath(
    repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
  );
  await assert.rejects(
    execFile(process.execPath, [launcher], {
      env: { ...process.env, NPM_CONFIG_PACKAGE: "" },
    }),
    /NPM_CONFIG_PACKAGE must select the Superblocks CLI package/,
  );
});
