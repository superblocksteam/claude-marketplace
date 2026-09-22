import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("Superblocks starts browser login without terminal API-key setup", async () => {
  const [marketplace, manifest, mcp, setup] = await Promise.all([
    readJson(".claude-plugin/marketplace.json"),
    readJson("plugins/superblocks-plugin/.claude-plugin/plugin.json"),
    readJson("plugins/superblocks-plugin/.mcp.json"),
    readFile("plugins/superblocks-plugin/skills/configure/SKILL.md", "utf8"),
  ]);
  const server = mcp.mcpServers.superblocks;

  assert.equal(marketplace.plugins[0].version, manifest.version);
  assert.deepEqual(server.args.slice(-3), ["superblocks", "mcp", "serve"]);
  assert.equal(server.args.includes("--browser-login"), false);
  assert.equal(server.env.SUPERBLOCKS_MCP_BROWSER_LOGIN, "true");
  assert.equal(
    server.env.SUPERBLOCKS_SERVER_URL,
    "https://app.superblocks.com",
  );
  assert.equal(
    server.env.NPM_CONFIG_PACKAGE,
    "@superblocksteam/cli@beta",
  );
  assert.equal(
    server.args.some((argument) => argument.startsWith("--package=")),
    false,
  );
  assert.equal("userConfig" in manifest, false);
  assert.match(setup, /Node\.js 24.*npm\s+10/is);
  assert.match(setup, /https:\/\/app\.superblocks\.com/);
  assert.match(setup, /opens.*browser/i);
  assert.match(
    setup,
    /Customize MCP settings[\s\S]*SUPERBLOCKS_SERVER_URL[\s\S]*SUPERBLOCKS_MCP_BROWSER_LOGIN/,
  );
  assert.match(setup, /SUPERBLOCKS_MCP_BROWSER_LOGIN[\s\S]*"false"/);
  assert.match(
    setup,
    /"false"[\s\S]*remove\s+`SUPERBLOCKS_SERVER_URL`[\s\S]*existing CLI session/,
  );
  assert.doesNotMatch(setup, /API key|superblocks login|config set domain/i);
});
