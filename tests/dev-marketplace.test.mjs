import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("dev publication follows main and preserves the branch after npm failures or concurrent updates", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dev-marketplace-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const remote = join(directory, "remote.git");
  const checkout = join(directory, "checkout");
  const bin = join(directory, "bin");
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["clone", remote, checkout]);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("switch", "-c", "main");
  for (const path of [".claude-plugin", "plugins/superblocks-plugin/.claude-plugin"]) {
    mkdirSync(join(checkout, path), { recursive: true });
  }
  for (const path of [
    ".claude-plugin/marketplace.json",
    "plugins/superblocks-plugin/package.json",
    "plugins/superblocks-plugin/.claude-plugin/plugin.json",
  ]) {
    cpSync(new URL(`../${path}`, import.meta.url), join(checkout, path));
  }
  writeFileSync(join(checkout, "feature.txt"), "first main change");
  git("add", ".");
  git("commit", "-m", "Initial main");
  git("push", "origin", "main");
  const firstMain = git("rev-parse", "HEAD");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.TEST_NPM_FAIL) process.exit(1);
if (process.env.TEST_RACE_SHA) require("node:child_process").execFileSync("git", [
  "--git-dir", process.env.TEST_REMOTE, "update-ref", "refs/heads/dev", process.env.TEST_RACE_SHA
]);
const root = "plugins/superblocks-plugin";
const manifest = JSON.parse(fs.readFileSync(root + "/package.json"));
if (manifest.dependencies["@superblocksteam/cli"] !== "next") process.exit(2);
fs.writeFileSync(root + "/package-lock.json", JSON.stringify({
  packages: { "node_modules/@superblocksteam/cli": { version: "2.0.167-next.0" } }
}));
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const script = fileURLToPath(new URL("../.github/scripts/publish-dev.mjs", import.meta.url));
  const publish = (env = {}) =>
    spawnSync(process.execPath, [script], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
  const first = publish();
  assert.equal(first.status, 0, first.stderr);
  const dev = git("rev-parse", "origin/dev");
  assert.equal(git("rev-parse", "origin/dev^"), firstMain);
  const readDev = (path) => JSON.parse(git("show", `origin/dev:${path}`));
  const marketplace = readDev(".claude-plugin/marketplace.json");
  const plugin = readDev("plugins/superblocks-plugin/.claude-plugin/plugin.json");
  assert.equal(marketplace.name, "superblocks-dev");
  assert.equal(
    readDev("plugins/superblocks-plugin/package.json").dependencies["@superblocksteam/cli"],
    "next",
  );
  assert.equal(plugin.version, marketplace.plugins[0].version);
  assert.notEqual(
    plugin.version,
    JSON.parse(git("show", "main:plugins/superblocks-plugin/.claude-plugin/plugin.json")).version,
  );
  assert.equal(git("show", "main:feature.txt"), "first main change");
  assert.equal(
    JSON.parse(git("show", "main:plugins/superblocks-plugin/package.json")).dependencies[
      "@superblocksteam/cli"
    ],
    "beta",
  );

  git("switch", "main");
  writeFileSync(join(checkout, "feature.txt"), "latest main change");
  git("add", "feature.txt");
  git("commit", "-m", "Update main");
  git("push", "origin", "main");
  const latestMain = git("rev-parse", "HEAD");
  const failed = publish({ TEST_NPM_FAIL: "1" });
  assert.notEqual(failed.status, 0);
  assert.equal(git("ls-remote", "origin", "refs/heads/dev").split(/\s/)[0], dev);
  git("restore", ".");
  const updated = publish();
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(git("rev-parse", "origin/dev^"), latestMain);
  assert.equal(git("show", "origin/dev:feature.txt"), "latest main change");
  assert.notEqual(
    readDev("plugins/superblocks-plugin/.claude-plugin/plugin.json").version,
    plugin.version,
  );
  const raced = publish({ TEST_REMOTE: remote, TEST_RACE_SHA: latestMain });
  assert.notEqual(raced.status, 0);
  assert.match(raced.stderr, /stale info/);
  assert.equal(git("ls-remote", "origin", "refs/heads/dev").split(/\s/)[0], latestMain);
});
