import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  const git = (...args) =>
    execFileSync(
      "git",
      ["-C", directory, "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args],
      {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    ).trim();
  git("init", "--quiet", "--initial-branch=main", "--template=");
  git("add", ".");
  channel.brand(directory);
  channel.brand(directory);
  let manifest = readJson(join(directory, MANIFEST));
  assert.equal(manifest.displayName, current.isPublic ? "Superblocks (next)" : "Superblocks (dev)");
  assert.match(manifest.version, /^0\.0\.0-(next|dev)\.h[0-9a-f]{12}\.cli-/);
  writeFileSync(join(directory, PLUGIN, ".DS_Store"), "local metadata");
  writeFileSync(join(directory, PLUGIN, "scripts/.launch-mcp.mjs.swp"), "editor state");
  assert.doesNotThrow(() => channel.assertVersion(directory));
  writeFileSync(join(directory, PLUGIN, "new-file.txt"), "new plugin content\n");
  git("add", `${PLUGIN}/new-file.txt`);
  assert.throws(() => channel.assertVersion(directory), /version.*stale/i);
  channel.brand(directory);
  assert.notEqual(readJson(join(directory, MANIFEST)).version, manifest.version);
  git("rm", "--quiet", "--force", `${PLUGIN}/new-file.txt`);
  channel.brand(directory);
  assert.equal(readJson(join(directory, MANIFEST)).version, manifest.version);
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
  git("add", "--update");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "versioned plugin",
  );
  const clean = mkdtempSync(join(tmpdir(), "superblocks-channel-clean-"));
  t.after(() => rmSync(clean, { recursive: true, force: true }));
  git("clone", "--quiet", directory, clean);
  assert.ok(!existsSync(join(clean, PLUGIN, ".DS_Store")));
  assert.doesNotThrow(() => channel.assertVersion(clean));
  channel.brand(clean);
  assert.equal(readJson(join(clean, MANIFEST)).version, changed.version);
  git(
    "update-index",
    "--add",
    "--cacheinfo",
    "160000",
    git("rev-parse", "HEAD"),
    `${PLUGIN}/external`,
  );
  assert.throws(() => channel.assertVersion(directory), /Unsupported plugin entry/);
  git("update-index", "--force-remove", `${PLUGIN}/external`);
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
      entry.resolved = `https://npm.pkg.github.com/download/${name.split("node_modules/").at(-1)}/${entry.version}/${"a".repeat(40)}`;
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

test("pin verification rejects another package's tarball on the expected registry", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-tarball-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ChannelMarketplace(current, root).write(directory);
  const path = join(directory, PLUGIN, "package-lock.json");
  const lock = readJson(path);
  lock.packages["node_modules/qs"].resolved =
    "https://registry.npmjs.org/unrelated/-/unrelated-6.16.1.tgz";
  writeJson(path, lock);
  assert.throws(() => current.cliVersion(directory), /tarball.*node_modules\/qs/i);
  lock.packages["node_modules/qs"].name = "unrelated";
  writeJson(path, lock);
  assert.throws(() => current.cliVersion(directory), /alias.*node_modules\/qs/i);
});

test("a decoy alias cannot substitute another package for the pinned CLI", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-cli-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ChannelMarketplace(current, root).write(directory);
  const path = join(directory, PLUGIN, "package-lock.json");
  const lock = readJson(path);
  const cli = lock.packages["node_modules/@superblocksteam/cli"];
  cli.name = "unrelated";
  cli.resolved = `https://registry.npmjs.org/unrelated/-/unrelated-${cli.version}.tgz`;
  lock.packages["node_modules/decoy"] = {
    version: "1.0.0",
    dependencies: { "@superblocksteam/cli": `npm:unrelated@${cli.version}` },
  };
  writeJson(path, lock);
  assert.throws(() => current.cliVersion(directory), /alias.*@superblocksteam\/cli/i);
});

test("an alias declaration only authorizes the dependency path it resolves to", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-alias-path-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ChannelMarketplace(current, root).write(directory);
  const path = join(directory, PLUGIN, "package-lock.json");
  const lock = readJson(path);
  const alias = {
    name: "unrelated",
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/unrelated/-/unrelated-1.0.0.tgz",
  };
  lock.packages["node_modules/renamed"] = alias;
  lock.packages["node_modules/decoy"] = {
    version: "1.0.0",
    dependencies: { renamed: "npm:unrelated@1.0.0" },
  };
  lock.packages["node_modules/decoy/node_modules/renamed"] = alias;
  writeJson(path, lock);
  assert.throws(() => current.cliVersion(directory), /alias.*node_modules\/renamed/i);
  delete lock.packages["node_modules/renamed"];
  writeJson(path, lock);
  assert.doesNotThrow(() => current.cliVersion(directory));
  lock.packages["node_modules/decoy/node_modules/@scope/consumer"] = {
    version: "1.0.0",
    dependencies: { renamed: "1.0.0" },
  };
  writeJson(path, lock);
  assert.throws(() => current.cliVersion(directory), /alias.*decoy\/node_modules\/renamed/i);
});

test("internal package names cannot alias public packages even through optional dependencies", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-sdk-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ChannelMarketplace(current, root).write(directory);
  const path = join(directory, PLUGIN, "package-lock.json");
  const lock = readJson(path);
  lock.packages["node_modules/@superblocksteam/cli"].optionalDependencies = {
    "@superblocksteam/sdk": "npm:unrelated@1.0.0",
  };
  lock.packages["node_modules/@superblocksteam/sdk"] = {
    name: "unrelated",
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/unrelated/-/unrelated-1.0.0.tgz",
  };
  writeJson(path, lock);
  assert.throws(() => current.cliVersion(directory), /alias.*@superblocksteam\/sdk/i);
  lock.packages["node_modules/@superblocksteam/cli"].dependencies["@superblocksteam/sdk"] =
    "npm:unrelated@1.0.0";
  writeJson(path, lock);
  assert.throws(() => current.cliVersion(directory), /alias.*@superblocksteam\/sdk/i);
  delete lock.packages["node_modules/@superblocksteam/sdk"].resolved;
  writeJson(path, lock);
  assert.throws(() => current.cliVersion(directory), /alias.*@superblocksteam\/sdk/i);
});

test("alias authorization checks every dependency section of a parent", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-alias-sections-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ChannelMarketplace(current, root).write(directory);
  const path = join(directory, PLUGIN, "package-lock.json");
  const lock = readJson(path);
  lock.packages["node_modules/renamed"] = {
    name: "unrelated",
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/unrelated/-/unrelated-1.0.0.tgz",
  };
  const parent = (lock.packages["node_modules/consumer"] = { version: "1.0.0" });
  for (const section of ["optionalDependencies", "devDependencies"]) {
    parent.dependencies = { renamed: "1.0.0" };
    parent[section] = { renamed: "npm:unrelated@1.0.0" };
    writeJson(path, lock);
    assert.throws(() => current.cliVersion(directory), /alias.*node_modules\/renamed/i);
    parent.dependencies.renamed = "npm:unrelated@^1.0.0";
    writeJson(path, lock);
    assert.throws(() => current.cliVersion(directory), /alias.*node_modules\/renamed/i);
    parent.dependencies.renamed = parent[section].renamed;
    writeJson(path, lock);
    assert.doesNotThrow(() => current.cliVersion(directory));
    delete parent[section];
  }
});

test("source rejection diagnostics identify mismatches without exposing URL secrets", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-source-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ChannelMarketplace(current, root).write(directory);
  const path = join(directory, PLUGIN, "package-lock.json");
  const lock = readJson(path);
  const entry = lock.packages["node_modules/qs"];
  const original = { ...entry };
  for (const [patch, expected] of [
    [{ name: "unrelated" }, /alias.*expected qs.*found unrelated/],
    [
      {
        resolved:
          "https://PRIVATE_USER:PRIVATE_PASSWORD@wrong.invalid/package?PRIVATE_QUERY#PRIVATE_FRAGMENT",
      },
      /registry.*expected https:\/\/registry\.npmjs\.org.*found https:\/\/wrong\.invalid.*userinfo/,
    ],
    [
      { resolved: "https://registry.npmjs.org/%50RIVATE_PATH?PRIVATE_QUERY#PRIVATE_FRAGMENT" },
      /tarball.*expected \/qs\/-\/qs-.*found path match false.*query.*fragment/,
    ],
    [
      { resolved: "https://registry.npmjs.org/wrong-path?PRIVATE_QUERY#PRIVATE_FRAGMENT" },
      /tarball.*expected \/qs\/-\/qs-.*found path match false.*query.*fragment/,
    ],
    [
      { resolved: `${original.resolved}?PRIVATE_QUERY` },
      /tarball.*found path match true.*query present \(forbidden\).*fragment absent/,
    ],
  ]) {
    lock.packages["node_modules/qs"] = { ...original, ...patch };
    writeJson(path, lock);
    assert.throws(
      () => current.cliVersion(directory),
      (error) => {
        assert.doesNotMatch(error.message, /PRIVATE_|%50RIVATE_/);
        assert.match(error.message, expected);
        return true;
      },
    );
  }
});
