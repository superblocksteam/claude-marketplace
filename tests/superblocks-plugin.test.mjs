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
import { pathToFileURL } from "node:url";
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
  assert.equal(server.env.NPM_CONFIG_PACKAGE, "@superblocksteam/cli@beta");
  assert.equal("SUPERBLOCKS_MCP_BROWSER_LOGIN" in server.env, false);
  assert.equal("SUPERBLOCKS_SERVER_URL" in server.env, false);
  assert.equal(
    server.args.some((argument) => argument.startsWith("--package=")),
    false,
  );
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

  const separator = server.args.indexOf("--");
  assert.notEqual(separator, -1);
  const args = [
    ...server.args.slice(0, separator),
    "--offline",
    ...server.args.slice(separator),
  ];
  const { stdout } = await execFile(
    process.platform === "win32" ? "npx.cmd" : "npx",
    args,
    {
      cwd: directory,
      env: {
        ...process.env,
        [packageEnvName]: pathToFileURL(packageDirectory).href,
        NPM_CONFIG_CACHE: join(directory, "cache"),
      },
    },
  );
  assert.equal(stdout, "configured package\n");
});
