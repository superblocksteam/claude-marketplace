import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Channel, ChannelBranch, ChannelMarketplace } from "../.github/scripts/channels.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sourceSha = "0123456789abcdef0123456789abcdef01234567";

test("each channel names its CLI tag, marketplace, and branch", () => {
  assert.deepEqual(
    Channel.all().map(({ name, distTag, branch, marketplace }) => ({
      name,
      distTag,
      branch,
      marketplace,
    })),
    [
      { name: "beta", distTag: "beta", branch: "main", marketplace: "superblocks" },
      { name: "next", distTag: "next", branch: "next", marketplace: "superblocks-next" },
      { name: "dev", distTag: "master", branch: "master", marketplace: "superblocks-dev" },
    ],
  );
  assert.throws(() => Channel.named("prod"), /Unknown channel "prod"; expected beta, next, or dev/);
});

test("every channel pins one exact CLI version in package.json and its lockfile", () => {
  for (const channel of Channel.all()) {
    const pin = channel.pinDirectory(root);
    const spec = readJson(join(pin, "package.json")).dependencies["@superblocksteam/cli"];
    const lockfile = readJson(join(pin, "package-lock.json"));
    assert.match(spec, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `${channel.name} must pin exactly`);
    assert.equal(lockfile.packages[""].dependencies["@superblocksteam/cli"], spec);
    assert.equal(channel.cliVersion(root), spec);
  }
});

test("public channels lock only public npm; dev locks Superblocks packages from GitHub Packages", () => {
  for (const channel of Channel.all()) {
    const lockfile = readJson(join(channel.pinDirectory(root), "package-lock.json"));
    const hosts = new Set();
    for (const [path, entry] of Object.entries(lockfile.packages)) {
      if (!entry.resolved) continue;
      const host = new URL(entry.resolved).origin;
      hosts.add(host);
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      if (!channel.isPublic && name.startsWith("@superblocksteam/")) {
        assert.equal(host, "https://npm.pkg.github.com", `${path} must come from GitHub Packages`);
      }
    }
    assert.deepEqual(
      [...hosts].sort(),
      channel.isPublic
        ? ["https://registry.npmjs.org"]
        : ["https://npm.pkg.github.com", "https://registry.npmjs.org"],
      `${channel.name} lockfile registries`,
    );
  }
});

test("only public channels may ship preinstalled release artifacts", () => {
  assert.doesNotThrow(() => Channel.named("beta").assertPublic());
  assert.doesNotThrow(() => Channel.named("next").assertPublic());
  assert.throws(
    () => Channel.named("dev").assertPublic(),
    /dev installs private GitHub Packages builds and must not ship public artifacts/,
  );
});

test("a branch channel's marketplace carries its pin, name, and a version per source and CLI", (t) => {
  const destination = mkdtempSync(join(tmpdir(), "superblocks-channel-"));
  t.after(() => rmSync(destination, { force: true, recursive: true }));
  const next = Channel.named("next");
  new ChannelMarketplace(next, root).write(destination, sourceSha);

  const marketplace = readJson(join(destination, ".claude-plugin/marketplace.json"));
  const manifest = readJson(
    join(destination, "plugins/superblocks-plugin/.claude-plugin/plugin.json"),
  );
  const version = `0.0.0-next.g0123456789ab.cli-${next.cliVersion(root)}`;
  assert.equal(marketplace.name, "superblocks-next");
  assert.equal(marketplace.plugins[0].name, "superblocks");
  assert.equal(marketplace.plugins[0].displayName, "Superblocks (next)");
  assert.equal(marketplace.plugins[0].version, version);
  assert.equal(manifest.version, version);
  assert.equal(manifest.displayName, "Superblocks (next)");
  for (const file of ["package.json", "package-lock.json"]) {
    assert.deepEqual(
      readJson(join(destination, "plugins/superblocks-plugin", file)),
      readJson(join(next.pinDirectory(root), file)),
    );
  }
  assert.ok(existsSync(join(destination, "plugins/superblocks-plugin/scripts/launch-mcp.mjs")));
  assert.ok(existsSync(join(destination, "plugins/superblocks-plugin/skills/configure/SKILL.md")));
  for (const excluded of [
    ".github",
    "tests",
    "channels",
    "plugins/superblocks-plugin/node_modules",
  ]) {
    assert.ok(!existsSync(join(destination, excluded)), `${excluded} must not be published`);
  }
});

test("the beta marketplace is main's own tree", (t) => {
  const destination = mkdtempSync(join(tmpdir(), "superblocks-channel-"));
  t.after(() => rmSync(destination, { force: true, recursive: true }));
  new ChannelMarketplace(Channel.named("beta"), root).write(destination, sourceSha);
  for (const file of [
    ".claude-plugin/marketplace.json",
    "plugins/superblocks-plugin/.claude-plugin/plugin.json",
    "plugins/superblocks-plugin/package.json",
    "plugins/superblocks-plugin/package-lock.json",
  ]) {
    assert.deepEqual(readJson(join(destination, file)), readJson(join(root, file)), file);
  }
});

test("publishing a channel branch appends to its history and never rewrites it", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-channel-branch-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const origin = join(directory, "origin.git");
  const repository = join(directory, "repository");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const identity = ["-c", "user.name=test", "-c", "user.email=test@example.com"];
  git(directory, "init", "--quiet", "--bare", origin);
  git(directory, "init", "--quiet", repository);
  git(repository, "remote", "add", "origin", origin);
  writeFileSync(join(repository, "legacy.txt"), "previous dev marketplace\n");
  git(repository, "add", "legacy.txt");
  git(repository, ...identity, "commit", "--quiet", "-m", "legacy");
  git(repository, "push", "--quiet", "origin", "HEAD:refs/heads/next");
  const legacy = git(origin, "rev-parse", "next");

  const branch = new ChannelBranch(Channel.named("next"), root, repository);
  const first = branch.publish(sourceSha);
  assert.equal(first.published, true);
  assert.equal(git(origin, "rev-parse", "next"), first.commit);
  assert.equal(git(origin, "rev-parse", "next^"), legacy);
  const files = git(origin, "ls-tree", "-r", "--name-only", "next").split("\n");
  assert.ok(files.includes(".claude-plugin/marketplace.json"));
  assert.ok(!files.includes("legacy.txt"));
  const marketplace = JSON.parse(git(origin, "show", "next:.claude-plugin/marketplace.json"));
  assert.equal(marketplace.name, "superblocks-next");
  assert.match(
    git(origin, "log", "-1", "--format=%s", "next"),
    /^chore\(channel\): publish next with CLI \S+ from 0123456789ab$/,
  );

  assert.deepEqual(branch.publish(sourceSha), { published: false, commit: first.commit });
  const second = branch.publish("fedcba9876543210fedcba9876543210fedcba98");
  assert.equal(second.published, true);
  assert.equal(git(origin, "rev-parse", "next^"), first.commit);

  assert.throws(
    () => new ChannelBranch(Channel.named("beta"), root, repository).publish(sourceSha),
    /beta is published by merging to main/,
  );
});
