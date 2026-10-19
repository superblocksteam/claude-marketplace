import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

import { DevPinUpdate } from "../.github/scripts/dev-pin.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("a validated dev patch advances only master and refuses unrelated files or concurrent changes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-dev-publish-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = join(directory, "origin.git");
  const checkout = join(directory, "checkout");
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const identity = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com"];
  git(directory, "init", "--quiet", "--bare", origin);
  mkdirSync(checkout);
  git(checkout, "init", "--quiet", "--initial-branch=master");
  git(checkout, "remote", "add", "origin", origin);
  for (const path of [".claude-plugin", "plugins"])
    cpSync(join(root, path), join(checkout, path), {
      recursive: true,
      filter: (source) => !source.split("/").includes("node_modules"),
    });
  const json = (path) => JSON.parse(readFileSync(join(checkout, path), "utf8"));
  const write = (path, value) =>
    writeFileSync(join(checkout, path), JSON.stringify(value, null, 2) + "\n");
  const marketplace = json(".claude-plugin/marketplace.json");
  marketplace.name = "superblocks-dev";
  write(".claude-plugin/marketplace.json", marketplace);
  git(checkout, "add", ".");
  git(checkout, ...identity, "commit", "--quiet", "-m", "initial");
  for (const branch of ["main", "next", "master"])
    git(checkout, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  const parent = git(checkout, "rev-parse", "HEAD");
  const packagePath = "plugins/superblocks-plugin/package.json";
  const lockPath = "plugins/superblocks-plugin/package-lock.json";
  const manifestPath = "plugins/superblocks-plugin/.claude-plugin/plugin.json";
  const pin = json(packagePath);
  pin.dependencies["@superblocksteam/cli"] = "3.0.1";
  write(packagePath, pin);
  const lock = json(lockPath);
  lock.packages[""].dependencies["@superblocksteam/cli"] = "3.0.1";
  lock.packages["node_modules/@superblocksteam/cli"].version = "3.0.1";
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.split("node_modules/").at(-1).startsWith("@superblocksteam/"))
      entry.resolved = "https://npm.pkg.github.com/fixture.tgz";
  }
  write(lockPath, lock);
  const manifest = json(manifestPath);
  manifest.version = "0.0.0-dev.cli-3.0.1";
  write(manifestPath, manifest);
  marketplace.plugins[0].version = manifest.version;
  write(".claude-plugin/marketplace.json", marketplace);
  const patch = join(directory, "pin.patch");
  writeFileSync(patch, git(checkout, "diff", "--binary") + "\n");
  git(checkout, "restore", ".");
  git(checkout, "checkout", "--quiet", "--detach", parent);
  const publisher = new DevPinUpdate(checkout);
  const result = publisher.publish(patch);
  assert.equal(git(origin, "rev-parse", "master^"), parent);
  assert.equal(git(origin, "rev-parse", "master"), result.commit);
  assert.equal(git(origin, "rev-parse", "main"), parent);
  assert.equal(git(origin, "rev-parse", "next"), parent);
  const files = git(origin, "diff", "--name-only", parent, "master").split("\n");
  assert.deepEqual(files, [".claude-plugin/marketplace.json", manifestPath, lockPath, packagePath]);
  console.log(
    "Published dev patch:",
    JSON.stringify({
      branch: "master",
      cliVersion: JSON.parse(git(origin, "show", `master:${packagePath}`)).dependencies[
        "@superblocksteam/cli"
      ],
      parent,
      commit: result.commit,
      files,
      otherBranches: "unchanged",
    }),
  );

  writeFileSync(join(checkout, "unexpected.txt"), "unrelated file\n");
  git(checkout, "add", "unexpected.txt");
  const badPatch = join(directory, "bad.patch");
  writeFileSync(badPatch, git(checkout, "diff", "--cached", "--binary") + "\n");
  git(checkout, "restore", "--staged", "unexpected.txt");
  rmSync(join(checkout, "unexpected.txt"));
  assert.throws(() => publisher.publish(badPatch), /Unexpected dev pin change/);
  assert.equal(git(origin, "rev-parse", "master"), result.commit);
  git(checkout, "restore", "--staged", ".");
  rmSync(join(checkout, "unexpected.txt"));

  for (const attack of ["mode", "delete", "outside"]) {
    if (attack === "mode") chmodSync(join(checkout, packagePath), 0o755);
    if (attack === "delete") rmSync(join(checkout, manifestPath));
    if (attack === "outside")
      writeFileSync(
        join(checkout, "plugins/superblocks-plugin/skills/configure/SKILL.md"),
        "unrelated edit\n",
      );
    writeFileSync(badPatch, git(checkout, "diff", "--binary") + "\n");
    git(checkout, "restore", ".");
    assert.throws(() => publisher.publish(badPatch), /Unexpected dev pin change/);
    assert.equal(git(checkout, "rev-parse", "HEAD"), result.commit);
    assert.equal(git(origin, "rev-parse", "master"), result.commit);
    git(checkout, "restore", "--staged", ".");
    git(checkout, "restore", ".");
    console.log(
      "Rejected dev patch:",
      JSON.stringify({
        attack,
        error: "Unexpected dev pin change",
        remote: git(origin, "rev-parse", "master"),
      }),
    );
  }
  writeFileSync(join(checkout, "dirty.txt"), "leave existing work alone\n");
  assert.throws(() => publisher.publish(patch), /Dev pin checkout must be clean/);
  assert.equal(git(origin, "rev-parse", "master"), result.commit);
  rmSync(join(checkout, "dirty.txt"));

  const stale = join(directory, "stale");
  git(directory, "clone", "--quiet", "--branch", "master", origin, stale);
  git(stale, "reset", "--quiet", "--hard", parent);
  writeFileSync(join(checkout, "concurrent.txt"), "preserve concurrent work\n");
  git(checkout, "add", "concurrent.txt");
  git(checkout, ...identity, "commit", "--quiet", "-m", "concurrent change");
  git(checkout, "push", "--quiet", "origin", "HEAD:refs/heads/master");
  const concurrent = git(origin, "rev-parse", "master");
  assert.throws(() => new DevPinUpdate(stale).publish(patch), /Command failed: git push/);
  assert.equal(git(origin, "rev-parse", "master"), concurrent);
  console.log(
    "Rejected dev patches:",
    JSON.stringify({
      unrelatedFile: "Unexpected dev pin change",
      staleParent: "non-fast-forward",
      master: git(origin, "rev-parse", "master"),
    }),
  );
});
