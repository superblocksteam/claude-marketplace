import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DevPinUpdate } from "../.github/scripts/channels.mjs";

test("dev updates open one exact-pin PR without modifying a checkout or leaking write credentials", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-dev-update-test-"));
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = join(directory, "origin.git");
  const checkout = join(directory, "checkout");
  const bin = join(directory, "bin");
  const stateFile = join(directory, "state.json");
  const callsFile = join(directory, "calls.jsonl");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const identity = ["-c", "user.name=test", "-c", "user.email=test@example.com"];
  git(directory, "init", "--quiet", "--bare", origin);
  git(directory, "init", "--quiet", "--initial-branch=main", checkout);
  git(checkout, "remote", "add", "origin", origin);
  mkdirSync(join(checkout, "channels/dev"), { recursive: true });
  mkdirSync(bin);
  const pin = (version) => {
    writeFileSync(
      join(checkout, "channels/dev/package.json"),
      JSON.stringify({
        dependencies: { "@superblocksteam/cli": version },
      }),
    );
    writeFileSync(
      join(checkout, "channels/dev/package-lock.json"),
      JSON.stringify({
        packages: {
          "": { dependencies: { "@superblocksteam/cli": version } },
          "node_modules/@superblocksteam/cli": { version },
        },
      }),
    );
    git(checkout, "add", "channels/dev");
    git(checkout, ...identity, "commit", "--quiet", "-m", `pin ${version}`);
    git(checkout, "push", "--quiet", "origin", "main");
  };
  pin("1.0.0");
  writeFileSync(join(checkout, "uncommitted.txt"), "leave this alone\n");
  const configuration = join(directory, "gitconfig");
  writeFileSync(
    configuration,
    `[url "file://${origin}"]\n  insteadOf = https://github.com/superblocksteam/claude-marketplace.git\n`,
  );
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: configuration,
    DEV_UPDATE_STATE: stateFile,
    DEV_UPDATE_CALLS: callsFile,
    GH_TOKEN: "fixture-write-credential",
    GITHUB_TOKEN: "fixture-other-write-credential",
    NODE_AUTH_TOKEN: "fixture-package-read-credential",
  });
  const common = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.DEV_UPDATE_STATE, "utf8"));
const log = (extra = {}) => appendFileSync(process.env.DEV_UPDATE_CALLS, JSON.stringify({
  command: process.argv[1].split("/").pop(), args, ...extra,
}) + "\n");
`;
  writeFileSync(
    join(bin, "npm"),
    String.raw`#!${process.execPath}
${common}
log({
  githubToken: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  npmrc: readFileSync(process.env.NPM_CONFIG_USERCONFIG, "utf8"),
});
if (args[0] === "view") console.log(JSON.stringify(state.version));
else if (args[0] === "install") {
  if (state.failPin) process.exit(1);
  const version = args[1].slice("@superblocksteam/cli@".length);
  for (const file of ["package.json", "package-lock.json"]) {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (file === "package.json") value.dependencies["@superblocksteam/cli"] = version;
    else {
      if (!state.corruptRootPin) value.packages[""].dependencies["@superblocksteam/cli"] = version;
      value.packages["node_modules/@superblocksteam/cli"].version = version;
    }
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  }
} else process.exit(2);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "gh"),
    String.raw`#!${process.execPath}
${common}
if (args[0] === "api") { log(); console.log("fixture-bot"); }
else if (args[1] === "list") { log(); console.log(JSON.stringify(state.open ? [{ url: state.open }] : [])); }
else if (args[1] === "create") {
  log({ body: readFileSync(args[args.indexOf("--body-file") + 1], "utf8") });
  if (state.failCreate) process.exit(1);
  state.open = "https://github.com/superblocksteam/claude-marketplace/pull/123";
  writeFileSync(process.env.DEV_UPDATE_STATE, JSON.stringify(state));
  console.log(state.open);
} else process.exit(2);
`,
    { mode: 0o755 },
  );
  const state = (value) => writeFileSync(stateFile, JSON.stringify(value));
  const calls = () => readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse);
  const branch = (version) => `automation/dev-cli-${version}-pin`;
  const update = new DevPinUpdate();

  state({ version: "1.0.1" });
  assert.equal(update.open(), "https://github.com/superblocksteam/claude-marketplace/pull/123");
  const commit = git(origin, "rev-parse", branch("1.0.1"));
  assert.deepEqual(
    git(origin, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n"),
    ["channels/dev/package-lock.json", "channels/dev/package.json"],
  );
  assert.equal(
    JSON.parse(git(origin, "show", `${commit}:channels/dev/package.json`)).dependencies[
      "@superblocksteam/cli"
    ],
    "1.0.1",
  );
  const install = calls().find((call) => call.args[0] === "install");
  assert.equal(install.args[1], "@superblocksteam/cli@1.0.1");
  assert.ok(install.args.includes("--ignore-scripts"));
  assert.ok(
    calls()
      .find((call) => call.args[0] === "view")
      .args.includes("--prefer-online"),
  );
  for (const call of calls().filter((call) => call.command === "npm")) {
    assert.equal(call.githubToken, undefined);
    assert.equal(call.npmrc, "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n");
  }
  const created = calls().find((call) => call.args[1] === "create");
  assert.ok(created.args.includes("--draft"));
  assert.match(created.body, /@fixture-bot/);
  assert.match(created.body, /1\.0\.0.*1\.0\.1/);
  assert.equal(git(checkout, "status", "--short"), "?? uncommitted.txt");
  assert.equal(readFileSync(join(checkout, "uncommitted.txt"), "utf8"), "leave this alone\n");
  console.log(
    "Dev pin PR observed:",
    JSON.stringify({
      cliVersion: JSON.parse(git(origin, "show", `${commit}:channels/dev/package.json`))
        .dependencies["@superblocksteam/cli"],
      changedFiles: git(origin, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split(
        "\n",
      ),
      draft: created.args.includes("--draft"),
      checkoutStatus: git(checkout, "status", "--short"),
    }),
  );

  writeFileSync(callsFile, "");
  assert.match(update.open(), /\/pull\/123$/);
  assert.equal(
    calls().filter((call) => call.args[0] === "install" || call.args[1] === "create").length,
    0,
  );
  assert.equal(git(origin, "rev-parse", branch("1.0.1")), commit);

  pin("1.0.1");
  writeFileSync(callsFile, "");
  const unchanged = update.open();
  assert.equal(unchanged, "dev already pins 1.0.1; no PR needed.");
  console.log("Dev pin unchanged:", unchanged);
  assert.equal(calls().length, 1);

  for (const version of ["2.0.0+build.7", "2.0.0-SNAPSHOT.a+build.lock", "2.0.0-next.1+001"]) {
    state({ version });
    assert.match(update.open(), /\/pull\/123$/);
    const metadataPin = JSON.parse(
      git(origin, "show", `${branch(version)}:channels/dev/package.json`),
    );
    assert.equal(metadataPin.dependencies["@superblocksteam/cli"], version);
    console.log(
      "Dev pin build metadata accepted:",
      metadataPin.dependencies["@superblocksteam/cli"],
    );
  }

  for (const version of [
    "master",
    "1.0.2-bad..tag",
    ["1.0.2"],
    "1.0.2/other",
    "01.0.2",
    "1.0.2-next.01",
    "1.0.2\n",
  ]) {
    state({ version });
    assert.throws(
      () => update.open(),
      (error) => {
        assert.match(error.message, /Invalid CLI version/);
        console.log("Dev pin rejected:", error.message);
        return true;
      },
    );
  }
  state({ version: "1.0.2", failPin: true });
  assert.throws(() => update.open());
  assert.equal(git(origin, "ls-remote", origin, `refs/heads/${branch("1.0.2")}`), "");
  state({ version: "1.0.4", corruptRootPin: true });
  assert.throws(() => update.open(), /Dev pin does not match the requested CLI 1\.0\.4/);
  assert.equal(git(origin, "ls-remote", origin, `refs/heads/${branch("1.0.4")}`), "");

  state({ version: "1.0.3", failCreate: true });
  assert.throws(() => update.open());
  const orphan = git(origin, "rev-parse", branch("1.0.3"));
  state({ version: "1.0.3" });
  assert.match(update.open(), /\/pull\/123$/);
  assert.equal(
    git(origin, "rev-parse", branch("1.0.3")),
    orphan,
    "retry must reuse a pushed branch",
  );
});
