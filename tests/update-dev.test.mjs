import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DevPinUpdate } from "../.github/scripts/update-dev-pin.mjs";

const plugin = "plugins/superblocks-plugin";

test("the local dev update only requests the isolated workflow", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-dev-dispatch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls.json");
  writeFileSync(
    join(directory, "gh"),
    `#!${process.execPath}\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.DISPATCH_CALLS, JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o755 },
  );
  const script = fileURLToPath(new URL("../.github/scripts/update-dev.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [script], {
    env: { ...process.env, PATH: directory, DISPATCH_CALLS: calls },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(readFileSync(calls, "utf8")), [
    "workflow",
    "run",
    "update-dev.yml",
    "--repo",
    "superblocksteam/claude-marketplace",
    "--ref",
    "main",
  ]);
  assert.match(output, /requested/i);
  const env = { ...process.env, PATH: directory };
  delete env.GH_TOKEN;
  const publish = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../.github/scripts/dev-pin.mjs", import.meta.url)),
      "publish",
      "0".repeat(40),
    ],
    { env, encoding: "utf8" },
  );
  assert.notEqual(publish.status, 0);
  assert.match(publish.stderr, /Configure CHANNEL_PUBLISH_TOKEN/);
});

test("dev prepares an immutable pin, verifies it separately, and publishes without executing the CLI", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-dev-update-"));
  const environment = { ...process.env };
  t.after(() => {
    process.env = environment;
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = join(directory, "origin.git");
  const checkout = join(directory, "checkout");
  const bin = join(directory, "bin");
  const stateFile = join(directory, "state.json");
  const callsFile = join(directory, "calls.jsonl");
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
      cwd: checkout,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  mkdirSync(checkout);
  mkdirSync(bin);
  git("init", "--quiet", "--bare", origin);
  git("init", "--quiet", "--initial-branch=master");
  git("remote", "add", "origin", origin);
  const write = (path, value) => {
    const destination = join(checkout, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    );
  };
  write("package.json", { private: true });
  write("README.md", "tracked documentation\n");
  write(`${plugin}/package.json`, { dependencies: { "@superblocksteam/cli": "1.0.0" } });
  write(`${plugin}/package-lock.json`, {
    packages: {
      "": { dependencies: { "@superblocksteam/cli": "1.0.0" } },
      "node_modules/@superblocksteam/cli": {
        version: "1.0.0",
        resolved: `https://npm.pkg.github.com/download/@superblocksteam/cli/1.0.0/${"a".repeat(40)}`,
        integrity: "sha512-fixture-1.0.0",
      },
      "node_modules/@superblocksteam/sdk": {
        version: "1.0.0",
        resolved: `https://npm.pkg.github.com/download/@superblocksteam/sdk/1.0.0/${"b".repeat(40)}`,
        integrity: "sha512-sdk-1.0.0",
      },
      "node_modules/unrelated": { version: "1.0.0" },
    },
  });
  write(`${plugin}/.npmrc`, "https-proxy=https://untrusted.invalid/\nstrict-ssl=false\n");
  write(`${plugin}/.claude-plugin/plugin.json`, {
    name: "superblocks",
    displayName: "Superblocks (dev)",
    version: "1.0.0",
  });
  write(".claude-plugin/marketplace.json", {
    name: "superblocks-dev",
    plugins: [{ name: "superblocks", displayName: "Superblocks (dev)", version: "1.0.0" }],
  });
  write(
    "tests/installed/dependency-security.test.mjs",
    "import assert from 'node:assert/strict'; assert.ok(process.env.TEST_PLUGIN_DIRECTORY); assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.NODE_AUTH_TOKEN, undefined);\n",
  );
  write(
    ".github/scripts/build-mcpb.mjs",
    "import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; mkdirSync(process.argv[3], {recursive:true}); writeFileSync(join(process.argv[3], 'fixture.mcpb'), 'test bundle');\n",
  );
  write(".github/scripts/smoke-mcpb.py", "fixture smoke boundary\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial master");
  git("push", "--quiet", "origin", "master", "HEAD:refs/heads/main");
  const main = git("rev-parse", "HEAD");
  write("uncommitted.txt", "leave this alone\n");
  const config = join(directory, "gitconfig");
  writeFileSync(
    config,
    `[url "file://${origin}"]\n insteadOf = https://github.com/superblocksteam/claude-marketplace.git\n[core]\n hooksPath = /dev/null\n`,
  );
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: config,
    DEV_STATE: stateFile,
    DEV_CALLS: callsFile,
    GH_TOKEN: "fixture-write-token",
    NODE_AUTH_TOKEN: "fixture-read-token",
  });
  delete process.env.NODE_TEST_CONTEXT;
  const common = String.raw`
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.DEV_STATE, "utf8"));
const artifact = { tarball: "https://npm.pkg.github.com/download/@superblocksteam/cli/" + state.version + "/" + "a".repeat(40), integrity: "sha512-fixture-" + state.version };
appendFileSync(process.env.DEV_CALLS, JSON.stringify({ command: process.argv[1].split("/").pop(), args, token: process.env.GH_TOKEN, projectNpmrc: existsSync(".npmrc"), proxy: process.env.npm_config_https_proxy, tls: process.env.npm_config_strict_ssl }) + "\n");
assert.equal(process.env.GH_TOKEN, undefined);
if (args[0] === "test" || process.argv[1].endsWith("/python3")) assert.equal(process.env.NODE_AUTH_TOKEN, undefined);
`;
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}\n${common}
if (args[0] === "view" && args[2] === "dist") {
  assert.equal(args[1], "@superblocksteam/cli@" + state.version);
  if (state.changedDigest) artifact.integrity = "sha512-replaced";
  if (state.changedTarball) artifact.tarball += "-replaced";
  console.log(JSON.stringify(Object.hasOwn(state, "distValue") ? state.distValue : artifact));
} else if (args[0] === "view") {
  state.reads = (state.reads ?? 0) + 1;
  writeFileSync(process.env.DEV_STATE, JSON.stringify(state));
  console.log(state.rawVersion ?? JSON.stringify(state.reads > 1 && state.versionAfter ? state.versionAfter : state.version));
}
else if (args[0] === "install") {
  assert.equal(existsSync(".npmrc"), false);
  assert.equal(args[1], "@superblocksteam/cli@" + state.version);
  assert.ok(args.includes("--ignore-scripts"));
  if (state.failPin) process.exit(17);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  pkg.dependencies["@superblocksteam/cli"] = state.version;
  lock.packages["node_modules/@superblocksteam/cli"].version = state.version;
  lock.packages["node_modules/@superblocksteam/cli"].resolved = artifact.tarball;
  lock.packages["node_modules/@superblocksteam/cli"].integrity = artifact.integrity;
  if (state.requiredDependency) {
    lock.packages["node_modules/@superblocksteam/cli"].dependencies = {"@superblocksteam/sdk": state.version};
    lock.packages["node_modules/@superblocksteam/sdk"] = {
      version: state.version,
      resolved: "https://npm.pkg.github.com/download/@superblocksteam/sdk/" + state.version + "/" + "b".repeat(40),
      integrity: "sha512-sdk-" + state.version,
      dependencies: { unrelated: "^1.2.0", "new-transitive": "2.0.0" }
    };
    lock.packages["node_modules/unrelated"].version = "1.2.0";
    lock.packages["node_modules/new-transitive"] = {
      version: "2.0.0", resolved: "https://registry.npmjs.org/new-transitive/-/new-transitive-2.0.0.tgz", integrity: "sha512-new-transitive"
    };
    if (state.invalidDependencySource) lock.packages["node_modules/@superblocksteam/sdk"].resolved = "https://registry.npmjs.org/@superblocksteam/sdk/-/sdk-" + state.version + ".tgz";
  }
  if (!state.corruptPin) lock.packages[""].dependencies["@superblocksteam/cli"] = state.version;
  writeFileSync("package.json", JSON.stringify(pkg));
  writeFileSync("package-lock.json", JSON.stringify(lock));
} else if (args[0] === "ci" && args.includes("--dry-run") && state.dryRunAuthFailure) {
  console.error("npm error code E401: fixture registry authentication failed");
  process.exit(1);
} else if (args[0] === "ci" && args.includes("--dry-run") && state.invalidLock) {
  console.error("npm error code EUSAGE: fixture dependency lock is not installable");
  process.exit(1);
} else if (args[0] === "ci" && args.includes("--dry-run") && state.requiredDependency) {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  if (lock.packages["node_modules/unrelated"].version !== "1.2.0") {
    console.error("npm error code EUSAGE: lockfile does not satisfy the CLI dependency range");
    process.exit(1);
  }
} else if (args[0] === "test" && state.failVerify) process.exit(18);
else if (!["test", "ci", "update"].includes(args[0])) process.exit(2);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "python3"),
    `#!${process.execPath}\n${common}
assert.equal(readFileSync(args[1], "utf8"), "test bundle");
if (state.failSmoke) process.exit(19);
if (state.tamperDuringSmoke) writeFileSync("plugins/superblocks-plugin/package.json", JSON.stringify({dependencies:{"@superblocksteam/cli":"9.9.9"}}));
if (state.advanceDuringSmoke) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args) => execFileSync("git", ["--git-dir", state.origin, ...args], { env, encoding: "utf8" }).trim();
  const previous = git("rev-parse", "master");
  const commit = git("commit-tree", git("rev-parse", "master^{tree}"), "-p", previous, "-m", "concurrent dev update");
  git("update-ref", "refs/heads/master", commit, previous);
}
if (state.rollbackDuringSmoke) execFileSync("git", ["--git-dir", state.origin, "update-ref", "refs/heads/master", state.rollbackDuringSmoke]);
`,
    { mode: 0o755 },
  );
  const state = (value) => writeFileSync(stateFile, JSON.stringify(value));
  const tip = () => {
    git("fetch", "--quiet", "origin", "master");
    return git("rev-parse", "FETCH_HEAD");
  };
  const update = new DevPinUpdate(checkout);
  const publish = () => {
    const candidate = update.prepare();
    if (!candidate.changed) return `master already pins ${candidate.version}`;
    const bundle = join(directory, "candidate.bundle");
    git("update-ref", "refs/heads/dev-pin-candidate", candidate.commit);
    git("bundle", "create", bundle, "refs/heads/dev-pin-candidate");
    const verification = join(directory, "verification");
    git("worktree", "add", "--quiet", "--detach", verification, candidate.commit);
    try {
      new DevPinUpdate(verification).verify(candidate.commit, join(directory, "dist"));
    } finally {
      git("worktree", "remove", "--force", verification);
      rmSync(join(directory, "dist"), { recursive: true, force: true });
    }
    const beforePublish = readFileSync(callsFile, "utf8").trim().split("\n").length;
    const publisher = join(directory, "publisher");
    git("clone", "--quiet", origin, publisher);
    let result;
    try {
      execFileSync("git", ["bundle", "unbundle", bundle], { cwd: publisher });
      result = new DevPinUpdate(publisher).publish(candidate.commit);
      assert.equal(tip(), candidate.commit);
    } finally {
      rmSync(publisher, { recursive: true, force: true });
    }
    const publicationCalls = readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .slice(beforePublish)
      .map(JSON.parse);
    assert.deepEqual(
      publicationCalls.map(({ command, args }) => [command, args[0]]),
      [
        ["npm", "view"],
        ["npm", "view"],
      ],
    );
    return result;
  };
  state({ version: "1.0.1" });
  const prepared = update.prepare();
  assert.equal(prepared.changed, true);
  assert.equal(tip(), main);
  assert.ok(
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .every(
        ({ command, args }) =>
          command === "npm" && ["view", "install", "update", "ci"].includes(args[0]),
      ),
  );
  assert.match(publish(), /master now pins 1\.0\.1/);
  const published = tip();
  assert.equal(
    JSON.parse(git("show", `${published}:${plugin}/package.json`)).dependencies[
      "@superblocksteam/cli"
    ],
    "1.0.1",
  );
  assert.equal(git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0], main);
  assert.equal(git("status", "--short"), "?? uncommitted.txt");
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.every((call) => call.token === undefined));
  assert.ok(calls.some((call) => call.command === "python3"));
  assert.ok(
    calls
      .filter((call) => call.command === "npm")
      .every((call) => call.proxy === "null" && call.tls === "true"),
  );
  assert.match(publish(), /already pins 1\.0\.1/);
  assert.equal(tip(), published);
  console.log(
    "Direct dev update observed:",
    JSON.stringify({
      main,
      master: published,
      pin: JSON.parse(git("show", `${published}:${plugin}/package.json`)).dependencies,
      checkout: git("status", "--short"),
      boundaryCalls: calls.map(({ command, args }) => ({ command, args })),
    }),
  );
  state({ version: "1.0.2", requiredDependency: true });
  const upgraded = update.prepare();
  const upgradedLock = JSON.parse(git("show", `${upgraded.commit}:${plugin}/package-lock.json`));
  assert.equal(upgradedLock.packages["node_modules/@superblocksteam/sdk"].version, "1.0.2");
  assert.equal(upgradedLock.packages["node_modules/unrelated"].version, "1.2.0");
  assert.equal(upgradedLock.packages["node_modules/new-transitive"].version, "2.0.0");
  assert.equal(tip(), published);
  state({ version: "1.0.2", requiredDependency: true, invalidDependencySource: true });
  assert.throws(() => update.prepare(), /Unexpected package registry.*superblocksteam\/sdk/);
  assert.equal(tip(), published);
  state({ version: "1.0.2", requiredDependency: true, invalidLock: true });
  assert.throws(
    () => update.prepare(),
    (error) => /EUSAGE/.test(error.stderr) && !/Unreviewed dependency/.test(error.message),
  );
  assert.equal(tip(), published);
  state({ version: "1.0.2", dryRunAuthFailure: true });
  assert.throws(
    () => update.prepare(),
    (error) => /E401/.test(error.stderr) && !/Unreviewed dependency/.test(error.message),
  );
  assert.equal(tip(), published);
  for (const [failure, expected] of [
    ["failPin", { status: 17, message: /npm install/ }],
    ["corruptPin", /package and lockfile must pin the same exact CLI version/],
    ["failVerify", { status: 18, message: /npm test/ }],
    ["failSmoke", { status: 19, message: /python3/ }],
    [
      "tamperDuringSmoke",
      {
        message:
          /Verification changed tracked files.*plugins\/superblocks-plugin\/package.json.*Re-run all jobs/,
      },
    ],
  ]) {
    state({ version: "1.0.2", [failure]: true });
    assert.throws(() => publish(), expected);
    assert.equal(tip(), published);
    console.log("Dev update rejected; master preserved:", failure, published);
  }
  for (const version of [
    "master",
    "^1.0.2",
    "1.0",
    "1.0.2/other",
    ["1.0.2"],
    "01.0.2",
    "1.0.2-next.01",
    "1.0.2\n",
  ]) {
    state({ version });
    assert.throws(() => publish(), /Invalid CLI version/);
    assert.equal(tip(), published);
  }
  for (const rawVersion of ["", "not JSON"]) {
    state({ rawVersion });
    assert.throws(() => publish(), /invalid JSON/);
    assert.equal(tip(), published);
  }
  for (const replacement of ["changedDigest", "changedTarball"]) {
    state({ version: "1.0.2", [replacement]: true });
    assert.throws(() => publish(), /artifact.*changed|integrity/i);
    assert.equal(tip(), published);
  }
  for (const distValue of [null, "invalid metadata", {}]) {
    state({ version: "1.0.2", distValue });
    assert.throws(() => publish(), /artifact.*changed/i);
    assert.equal(tip(), published);
  }
  state({ version: "1.0.2", versionAfter: "1.0.3" });
  assert.throws(
    () => publish(),
    (error) => {
      console.log("Dev stale registry tag rejected:", error.message);
      return (
        /master CLI tag changed: expected 1\.0\.2, found 1\.0\.3/.test(error.message) &&
        /Re-run all jobs/.test(error.message)
      );
    },
  );
  assert.equal(tip(), published);
  state({ version: "1.0.4", advanceDuringSmoke: true, origin });
  assert.throws(
    () => publish(),
    (error) => {
      assert.ok(error.message.includes(`master changed: expected ${published}, found ${tip()}`));
      assert.match(error.message, /Re-run all jobs/);
      assert.match(error.message, /failed jobs.*stale bundle/);
      return true;
    },
  );
  const raced = tip();
  assert.notEqual(raced, published);
  assert.equal(
    JSON.parse(git("show", `${raced}:${plugin}/package.json`)).dependencies["@superblocksteam/cli"],
    "1.0.1",
  );
  console.log("Dev concurrent push rejected; existing CLI pin preserved:", raced);
  state({ version: "1.0.5", rollbackDuringSmoke: main, origin });
  assert.throws(
    () => publish(),
    (error) => {
      assert.ok(error.message.includes(`master changed: expected ${raced}, found ${main}`));
      assert.match(error.message, /Re-run all jobs/);
      return true;
    },
  );
  assert.equal(tip(), main);
  console.log("Dev rollback preserved:", tip());
  state({ version: "1.0.6", requiredDependency: true });
  assert.match(publish(), /master now pins 1\.0\.6/);
  const finalLock = JSON.parse(git("show", `${tip()}:${plugin}/package-lock.json`));
  assert.equal(finalLock.packages["node_modules/@superblocksteam/sdk"].version, "1.0.6");
  assert.equal(finalLock.packages["node_modules/new-transitive"].version, "2.0.0");
  console.log("Dev full dependency graph published:", JSON.stringify(finalLock.packages));
});
