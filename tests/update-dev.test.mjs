import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DevPinUpdate } from "../.github/scripts/update-dev-pin.mjs";

const plugin = "plugins/superblocks-plugin";

test("dev publishes a verified pin directly to master, leaving main and the caller's checkout untouched", (t) => {
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
      "node_modules/@superblocksteam/cli": { version: "1.0.0" },
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
    "import assert from 'node:assert/strict'; assert.ok(process.env.TEST_PLUGIN_DIRECTORY); assert.equal(process.env.GH_TOKEN, undefined);\n",
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
    `[url "file://${origin}"]\n insteadOf = https://github.com/superblocksteam/claude-marketplace.git\n`,
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
appendFileSync(process.env.DEV_CALLS, JSON.stringify({ command: process.argv[1].split("/").pop(), args, token: process.env.GH_TOKEN, projectNpmrc: existsSync(".npmrc"), proxy: process.env.npm_config_https_proxy, tls: process.env.npm_config_strict_ssl }) + "\n");
assert.equal(process.env.GH_TOKEN, undefined);
`;
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}\n${common}
if (args[0] === "view") {
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
  if (!state.corruptPin) lock.packages[""].dependencies["@superblocksteam/cli"] = state.version;
  writeFileSync("package.json", JSON.stringify(pkg));
  writeFileSync("package-lock.json", JSON.stringify(lock));
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
if (state.advanceDuringSmoke) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args) => execFileSync("git", ["--git-dir", state.origin, ...args], { env, encoding: "utf8" }).trim();
  const previous = git("rev-parse", "master");
  const commit = git("commit-tree", git("rev-parse", "master^{tree}"), "-p", previous, "-m", "concurrent dev update");
  git("update-ref", "refs/heads/master", commit, previous);
}
`,
    { mode: 0o755 },
  );
  const state = (value) => writeFileSync(stateFile, JSON.stringify(value));
  const tip = () => {
    git("fetch", "--quiet", "origin", "master");
    return git("rev-parse", "FETCH_HEAD");
  };
  const update = new DevPinUpdate();
  state({ version: "1.0.1" });
  assert.match(update.publish(), /master now pins 1\.0\.1/);
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
  assert.match(update.publish(), /already pins 1\.0\.1/);
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
  for (const failure of ["failPin", "corruptPin", "failVerify", "failSmoke"]) {
    state({ version: "1.0.2", [failure]: true });
    assert.throws(() => update.publish());
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
    assert.throws(() => update.publish(), /Invalid CLI version/);
    assert.equal(tip(), published);
  }
  for (const rawVersion of ["", "not JSON"]) {
    state({ rawVersion });
    assert.throws(() => update.publish(), /invalid JSON/);
  }
  state({ version: "1.0.2", versionAfter: "1.0.3" });
  assert.throws(
    () => update.publish(),
    (error) => {
      console.log("Dev stale registry tag rejected:", error.message);
      return /changed|stale/i.test(error.message);
    },
  );
  assert.equal(tip(), published);
  state({ version: "1.0.4", advanceDuringSmoke: true, origin });
  assert.throws(() => update.publish(), /git .*push/);
  const raced = tip();
  assert.notEqual(raced, published);
  assert.equal(
    JSON.parse(git("show", `${raced}:${plugin}/package.json`)).dependencies["@superblocksteam/cli"],
    "1.0.1",
  );
  console.log("Dev concurrent push rejected; existing CLI pin preserved:", raced);
});
