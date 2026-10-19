import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DevPinUpdate } from "../.github/scripts/dev-pin.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the writer reconstructs the validated pin without consuming files from package execution", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-dev-publish-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = join(directory, "origin.git");
  const checkout = join(directory, "checkout");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
const args = process.argv.slice(2);
assert.ok(args.includes("--ignore-scripts"));
if (args[0] === "view") console.log(JSON.stringify(process.env.FIXTURE_ADVANCE_TAG && existsSync(process.env.FIXTURE_ADVANCE_TAG) ? "3.0.2" : process.env.FIXTURE_TAG || "3.0.1"));
else {
  assert.ok(args.includes("--package-lock-only"));
  const pin = JSON.parse(readFileSync("package.json"));
  const lock = JSON.parse(readFileSync("package-lock.json"));
  pin.dependencies["@superblocksteam/cli"] = "3.0.1";
  lock.packages[""].dependencies["@superblocksteam/cli"] = "3.0.1";
  lock.packages["node_modules/@superblocksteam/cli"].version = "3.0.1";
  if (process.env.FIXTURE_DIFFERENT_LOCK) lock.packages["node_modules/@superblocksteam/cli"].integrity = "sha512-different";
  if (process.env.FIXTURE_CORRUPT === "dependency") lock.packages[""].dependencies["@superblocksteam/cli"] = "3.0.0";
  if (process.env.FIXTURE_CORRUPT === "nested") lock.packages["node_modules/outer/node_modules/@superblocksteam/sdk-api"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/sdk.tgz" };
  const sources = { file: "file:../escape", git: "git+https://github.com/example/untrusted.git", link: "link:../escape" };
  if (sources[process.env.FIXTURE_CORRUPT]) lock.packages["node_modules/outer"] = { version: "1.0.0", resolved: sources[process.env.FIXTURE_CORRUPT] };
  if (process.env.FIXTURE_CORRUPT === "registry") lock.packages["node_modules/@superblocksteam/cli"].resolved = "https://registry.npmjs.org/cli.tgz";
  writeFileSync("package.json", JSON.stringify(pin, null, 2) + "\\n");
  writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\\n");
  if (process.env.FIXTURE_ADVANCE_TAG) writeFileSync(process.env.FIXTURE_ADVANCE_TAG, "3.0.2");
}
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "fixture-write" };
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
  const packagePath = "plugins/superblocks-plugin/package.json";
  const lockPath = "plugins/superblocks-plugin/package-lock.json";
  const manifestPath = "plugins/superblocks-plugin/.claude-plugin/plugin.json";
  const marketplace = json(".claude-plugin/marketplace.json");
  marketplace.name = "superblocks-dev";
  write(".claude-plugin/marketplace.json", marketplace);
  const lock = json(lockPath);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.split("node_modules/").at(-1).startsWith("@superblocksteam/"))
      entry.resolved = "https://npm.pkg.github.com/fixture.tgz";
  }
  write(lockPath, lock);
  git(checkout, "add", ".");
  git(checkout, ...identity, "commit", "--quiet", "-m", "initial");
  for (const branch of ["main", "next", "master"])
    git(checkout, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  const parent = git(checkout, "rev-parse", "HEAD");
  const prepared = new DevPinUpdate(checkout).prepare("3.0.1", env);
  assert.equal(prepared.changed, true);
  assert.match(prepared.pinDigest, /^[a-f0-9]{64}$/);
  // Package code runs after prepare and can mutate every file in this checkout.
  const injected = json(manifestPath);
  injected.hooks = { SessionStart: [{ hooks: [{ type: "command", command: "untrusted" }] }] };
  write(manifestPath, injected);
  const changedPin = json(packagePath);
  changedPin.dependencies.untrusted = "1.0.0";
  write(packagePath, changedPin);
  const writer = join(directory, "writer");
  git(directory, "clone", "--quiet", "--branch", "master", origin, writer);
  git(writer, "checkout", "--quiet", "--detach", prepared.sourceSha);
  const result = new DevPinUpdate(writer).publish("3.0.1", prepared.pinDigest, env);
  assert.equal(git(origin, "rev-parse", "master^"), parent);
  assert.equal(git(origin, "rev-parse", "master"), result.commit);
  assert.equal(git(origin, "rev-parse", "main"), parent);
  assert.equal(git(origin, "rev-parse", "next"), parent);
  assert.deepEqual(result.files, [lockPath, packagePath]);
  assert.equal(JSON.parse(git(origin, "show", `master:${manifestPath}`)).hooks, undefined);
  assert.equal(
    JSON.parse(git(origin, "show", `master:${packagePath}`)).dependencies.untrusted,
    undefined,
  );
  console.log("Published dev pin:", JSON.stringify(result));

  const resetWriter = () => git(writer, "reset", "--quiet", "--hard", parent);
  resetWriter();
  for (const corrupt of ["dependency", "registry", "nested", "file", "git", "link"]) {
    assert.throws(
      () =>
        new DevPinUpdate(writer).publish("3.0.1", prepared.pinDigest, {
          ...env,
          FIXTURE_CORRUPT: corrupt,
        }),
      corrupt === "dependency"
        ? /pin does not match/
        : /Unexpected package registry.*expected https:\/\/(npm.pkg.github.com|registry.npmjs.org), got (https:\/\/registry.npmjs.org|null)/,
    );
    console.log(
      "Rejected lock input:",
      JSON.stringify({
        corrupt,
        writerStatus: git(writer, "status", "--porcelain"),
        remoteMaster: git(origin, "rev-parse", "master"),
      }),
    );
    assert.equal(git(writer, "status", "--porcelain"), "");
    assert.equal(git(origin, "rev-parse", "master"), result.commit);
  }
  assert.throws(
    () =>
      new DevPinUpdate(writer).publish("3.0.1", prepared.pinDigest, {
        ...env,
        FIXTURE_DIFFERENT_LOCK: "1",
      }),
    /does not match the validated pin: expected [a-f0-9]{64}, got [a-f0-9]{64}/,
  );
  assert.equal(git(origin, "rev-parse", "master"), result.commit);
  resetWriter();
  const oldManifest = JSON.parse(git(writer, "show", `HEAD:${manifestPath}`));
  oldManifest.version = "1.0.0";
  writeFileSync(join(writer, manifestPath), JSON.stringify(oldManifest));
  git(writer, "add", ".");
  git(writer, ...identity, "commit", "--quiet", "-m", "invalid fixed version");
  assert.throws(
    () => new DevPinUpdate(writer).publish("3.0.1", prepared.pinDigest, env),
    /must omit version/,
  );
  assert.equal(git(origin, "rev-parse", "master"), result.commit);
  resetWriter();
  const skipped = new DevPinUpdate(writer).publish("3.0.1", prepared.pinDigest, {
    ...env,
    FIXTURE_TAG: "3.0.2",
  });
  assert.equal(skipped.changed, false);
  assert.equal(git(origin, "rev-parse", "master"), result.commit);
  git(origin, "update-ref", "refs/heads/master", parent);
  const advancedDuringInstall = new DevPinUpdate(writer).publish("3.0.1", prepared.pinDigest, {
    ...env,
    FIXTURE_ADVANCE_TAG: join(directory, "advanced-tag"),
  });
  assert.equal(advancedDuringInstall.changed, false);
  assert.equal(git(writer, "rev-parse", "HEAD"), parent);
  assert.equal(git(origin, "rev-parse", "master"), parent);
  console.log(
    "Skipped tag moved during writer resolution:",
    JSON.stringify({ initialTag: "3.0.1", finalTag: "3.0.2", remoteMaster: parent }),
  );
  git(origin, "update-ref", "refs/heads/master", result.commit);
  resetWriter();
  git(checkout, "fetch", "--quiet", "origin", "master");
  git(checkout, "reset", "--quiet", "--hard", result.commit);
  writeFileSync(join(checkout, "concurrent.txt"), "preserve concurrent work\n");
  git(checkout, "add", ".");
  git(checkout, ...identity, "commit", "--quiet", "-m", "concurrent change");
  git(checkout, "push", "--quiet", "origin", "HEAD:refs/heads/master");
  const concurrent = git(origin, "rev-parse", "master");
  assert.throws(
    () => new DevPinUpdate(writer).publish("3.0.1", prepared.pinDigest, env),
    /Command failed: git.*push/s,
  );
  assert.equal(git(origin, "rev-parse", "master"), concurrent);
  console.log(
    "Rejected writer changes:",
    JSON.stringify({
      badDependency: true,
      wrongRegistry: true,
      changedResolution: true,
      fixedVersion: true,
      staleEvent: true,
      staleParent: true,
      remoteMaster: concurrent,
    }),
  );
});
