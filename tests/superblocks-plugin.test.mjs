import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

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
