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
  assert.deepEqual(server.args.slice(-4), [
    "superblocks",
    "mcp",
    "serve",
    "--browser-login",
  ]);
  assert.equal("env" in server, false);
  assert.equal("userConfig" in manifest, false);
  assert.match(setup, /Node\.js 24.*npm\s+10/is);
  assert.match(setup, /https:\/\/app\.superblocks\.com/);
  assert.match(setup, /opens.*browser/i);
  assert.doesNotMatch(setup, /API key|superblocks login|config set domain/i);
});
