import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  Channel,
  ChannelMarketplace,
  MANIFEST,
  MARKETPLACE,
  PLUGIN,
  writeJson,
} from "../.github/scripts/channels.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const current = Channel.current(root);

test("channels form the main -> next -> master chain", () => {
  assert.deepEqual(
    Channel.all().map(({ name, distTag, branch, parent }) => ({ name, distTag, branch, parent })),
    [
      { name: "beta", distTag: "beta", branch: "main", parent: undefined },
      { name: "next", distTag: "next", branch: "next", parent: "main" },
      { name: "dev", distTag: "master", branch: "master", parent: "next" },
    ],
  );
  assert.throws(() => Channel.named("prod"), /Unknown channel/);
});

test("this branch owns one consistent exact CLI pin and its registry", () => {
  const spec = current.cliVersion(root);
  assert.ok(Channel.isExactVersion(spec));
  const lock = readJson(join(current.pinDirectory(root), "package-lock.json"));
  const hosts = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!entry.resolved) continue;
    const host = new URL(entry.resolved).origin;
    hosts.add(host);
    if (!current.isPublic && path.endsWith("node_modules/@superblocksteam/cli"))
      assert.equal(host, "https://npm.pkg.github.com");
  }
  assert.deepEqual(
    [...hosts].sort(),
    current.isPublic
      ? ["https://registry.npmjs.org"]
      : ["https://npm.pkg.github.com", "https://registry.npmjs.org"],
  );
  assert.ok(!existsSync(join(root, "channels")), "other channels' pins belong to their branches");
});

test("packaging copies the current channel without changing its pin or branding", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-channel-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  new ChannelMarketplace(current, root).write(directory);
  for (const file of [
    MARKETPLACE,
    MANIFEST,
    `${PLUGIN}/package.json`,
    `${PLUGIN}/package-lock.json`,
  ])
    assert.deepEqual(readJson(join(directory, file)), readJson(join(root, file)));
  assert.ok(existsSync(join(directory, PLUGIN, "scripts/launch-mcp.mjs")));
  assert.ok(existsSync(join(directory, PLUGIN, "skills/configure/SKILL.md")));
  assert.ok(!existsSync(join(directory, ".github")));
  assert.ok(!existsSync(join(directory, PLUGIN, "node_modules")));
  const other = Channel.all().find((channel) => channel !== current);
  assert.throws(() => new ChannelMarketplace(other, root).write(directory), /Check out/);
  assert.throws(() => other.pinTo(root, "1.0.0"), /Check out/);
});

test("non-production branding is idempotent and follows each code or CLI update", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-channel-brand-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ChannelMarketplace(current, root).write(directory);
  const channel = current.isMain ? Channel.named("next") : current;
  channel.brand(directory, "0123456789abcdef");
  channel.brand(directory, "0123456789abcdef");
  let manifest = readJson(join(directory, MANIFEST));
  assert.equal(manifest.displayName, `Superblocks (${channel.name})`);
  assert.equal(
    manifest.version,
    `0.0.0-${channel.name}.g0123456789ab.cli-${channel.cliVersion(directory)}`,
  );
  channel.brand(directory, "fedcba9876543210");
  const changed = readJson(join(directory, MANIFEST));
  assert.notEqual(changed.version, manifest.version);
  assert.equal(readJson(join(directory, MARKETPLACE)).plugins[0].version, changed.version);
  const pkg = readJson(join(directory, PLUGIN, "package.json"));
  pkg.dependencies["@superblocksteam/cli"] = "master";
  writeJson(join(directory, PLUGIN, "package.json"), pkg);
  assert.throws(() => channel.cliVersion(directory), /same exact CLI version/);
});

test("only public channels may ship preinstalled release artifacts", () => {
  assert.doesNotThrow(() => Channel.named("beta").assertPublic());
  assert.doesNotThrow(() => Channel.named("next").assertPublic());
  assert.throws(() => Channel.named("dev").assertPublic(), /must not ship public artifacts/);
});
