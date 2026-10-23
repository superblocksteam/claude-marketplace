import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("dev package operations preserve npm-login credentials when no token is supplied", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-npm-login-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const npmrc = join(directory, "npmrc");
  writeFileSync(npmrc, "//npm.pkg.github.com/:_authToken=fixture-login-token\n");
  const environment = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
  delete environment.NODE_AUTH_TOKEN;
  delete environment.npm_config_userconfig;
  Channel.named("dev").withNpm((_, env) => {
    assert.equal(readFileSync(env.NPM_CONFIG_USERCONFIG, "utf8"), readFileSync(npmrc, "utf8"));
    assert.equal(env.NODE_AUTH_TOKEN, undefined);
  }, environment);
});

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
    if (!current.isPublic && path.split("node_modules/").at(-1).startsWith("@superblocksteam/"))
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
  const channel = Channel.named(current.isPublic ? "next" : "dev");
  channel.brand(directory);
  channel.brand(directory);
  let manifest = readJson(join(directory, MANIFEST));
  assert.equal(manifest.displayName, current.isPublic ? "Superblocks (next)" : "Superblocks (dev)");
  assert.match(manifest.version, /^0\.0\.0-(next|dev)\.h[0-9a-f]{12}\.cli-/);
  writeFileSync(
    join(directory, PLUGIN, "scripts/launch-mcp.mjs"),
    "console.log('changed plugin');\n",
  );
  assert.throws(() => channel.assertVersion(directory), /version.*stale/i);
  channel.brand(directory);
  assert.doesNotThrow(() => channel.assertVersion(directory));
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

test("dev rejects public-registry substitution of any scoped dependency", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-registry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ChannelMarketplace(current, root).write(directory);
  const path = join(directory, PLUGIN, "package-lock.json");
  const lock = readJson(path);
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name.split("node_modules/").at(-1).startsWith("@superblocksteam/") && entry.resolved)
      entry.resolved = `https://npm.pkg.github.com/${name.split("node_modules/").at(-1)}/${entry.version}`;
  }
  lock.packages["node_modules/parent/node_modules/@superblocksteam/sdk"] = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/@superblocksteam/sdk/-/sdk-1.0.0.tgz",
  };
  writeJson(path, lock);
  assert.throws(
    () => Channel.named("dev").cliVersion(directory),
    /registry.*@superblocksteam\/sdk/i,
  );
});
