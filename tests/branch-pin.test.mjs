import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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

import { Channel } from "../.github/scripts/channels.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("a checkout owns one pin, selected by its marketplace identity", () => {
  const channel = Channel.current(root);
  channel.validate(root);
  assert.equal(channel.pinDirectory(root), join(root, "plugins/superblocks-plugin"));
  assert.equal(existsSync(join(root, "channels")), false);
  console.log(
    "Checkout pin:",
    JSON.stringify({
      channel: channel.name,
      branch: channel.branch,
      cliVersion: channel.cliVersion(root),
      marketplace: JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"))
        .name,
    }),
  );
});

test("pinning updates only this branch's pin, with no partial writes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-branch-pin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert.equal(existsSync(".npmrc"), false);
assert.equal(process.env.npm_config_strict_ssl, "true");
assert.equal(process.env.npm_config_proxy, "null");
assert.equal(process.env.npm_config_https_proxy, "null");
assert.ok(args.includes("--ignore-scripts"));
const version = process.env.FIXTURE_VERSION;
if (args[0] === "view") console.log(JSON.stringify(version));
else if (args[0] === "install") {
  assert.ok(args.includes("--save-exact"));
  assert.ok(args.includes("--package-lock-only"));
  const registry = args.find(arg => arg.startsWith("--@superblocksteam:registry=")).split("=")[1];
  for (const file of ["package.json", "package-lock.json"]) {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (file === "package.json") value.dependencies["@superblocksteam/cli"] = version;
    else {
      if (!process.env.FIXTURE_CORRUPT) value.packages[""].dependencies["@superblocksteam/cli"] = version;
      for (const [path, entry] of Object.entries(value.packages)) {
        if (path.split("node_modules/").at(-1).startsWith("@superblocksteam/")) entry.resolved = registry + "fixture.tgz";
      }
      value.packages["node_modules/@superblocksteam/cli"].version = version;
    }
    writeFileSync(file, JSON.stringify(value, null, 2) + "\\n");
  }
} else process.exit(2);
`,
    { mode: 0o755 },
  );
  for (const channel of Channel.all()) {
    const checkout = join(directory, channel.name);
    mkdirSync(checkout);
    for (const path of [".claude-plugin", "plugins"])
      cpSync(join(root, path), join(checkout, path), {
        recursive: true,
        filter: (source) => !source.split("/").includes("node_modules"),
      });
    cpSync(join(root, ".github/scripts"), join(checkout, ".github/scripts"), { recursive: true });
    const marketplacePath = join(checkout, ".claude-plugin/marketplace.json");
    const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
    marketplace.name = channel.marketplace;
    writeFileSync(marketplacePath, JSON.stringify(marketplace));
    const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch=" + channel.branch);
    git("add", ".");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--quiet",
      "-m",
      "initial",
    );
    writeFileSync(
      join(channel.pinDirectory(checkout), ".npmrc"),
      "https-proxy=https://untrusted.invalid/\nstrict-ssl=false\n",
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "fixture-write",
      GITHUB_TOKEN: "fixture-write",
      FIXTURE_VERSION: "3.0.1",
    };
    assert.equal(channel.pinTo(checkout, "3.0.1", env), true);
    channel.validate(checkout, channel.branch);
    assert.doesNotThrow(() => channel.validate(checkout, "feature/shared-plugin-change"));
    assert.throws(
      () => channel.validate(checkout, channel.branch === "next" ? "main" : "next"),
      /belongs on .*expected/,
    );
    assert.equal(channel.cliVersion(checkout), "3.0.1");
    const manifest = JSON.parse(
      readFileSync(join(checkout, "plugins/superblocks-plugin/.claude-plugin/plugin.json"), "utf8"),
    );
    assert.equal(manifest.version, undefined);
    const files = git("diff", "--name-only").split("\n");
    assert.deepEqual(files, [
      "plugins/superblocks-plugin/package-lock.json",
      "plugins/superblocks-plugin/package.json",
    ]);
    const before = git("diff");
    assert.equal(channel.pinTo(checkout, "3.0.1", env), false);
    assert.equal(git("diff"), before);
    for (const spec of ["latest", "^3.0.1", "3.0.1\n", "file:/tmp/other", "3.0.1-next.01"]) {
      assert.throws(() => channel.pinTo(checkout, spec, env), /Invalid CLI version or tag/);
      assert.equal(git("diff"), before);
    }
    assert.throws(
      () =>
        channel.pinTo(checkout, "3.0.2", {
          ...env,
          FIXTURE_VERSION: "3.0.2",
          FIXTURE_CORRUPT: "1",
        }),
      /CLI pin does not match its lockfile: package.json=3.0.2, lock dependency=3.0.1, locked CLI=3.0.2/,
    );
    assert.equal(git("diff"), before);
    console.log(
      "Branch pin update:",
      JSON.stringify({
        branch: channel.branch,
        cliVersion: channel.cliVersion(checkout),
        files,
        repeatedUpdate: "unchanged",
        invalidUpdate: "rejected without changes",
      }),
    );
    if (channel.name === "dev") {
      git("add", ...files);
      git(
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "--quiet",
        "-m",
        "pin",
      );
      rmSync(join(channel.pinDirectory(checkout), ".npmrc"));
      const outputFile = join(directory, "github-output");
      const prepare = (version, environment) =>
        execFileSync(
          process.execPath,
          [join(checkout, ".github/scripts/update-dev.mjs"), "prepare", version],
          {
            cwd: checkout,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...environment, GITHUB_OUTPUT: outputFile },
          },
        );
      assert.match(prepare("3.0.0", env), /Skipping CLI 3\.0\.0: @master has moved/);
      assert.equal(
        readFileSync(outputFile, "utf8"),
        `changed=false\nsource_sha=${git("rev-parse", "HEAD")}\npin_digest=\n`,
      );
      console.log("Skipped prepare GITHUB_OUTPUT:", readFileSync(outputFile, "utf8").trim());
      writeFileSync(outputFile, "");
      assert.throws(() => prepare("master", env), /Invalid CLI version/);
      assert.equal(readFileSync(outputFile, "utf8"), "");
      const prepared = JSON.parse(prepare("3.0.2", { ...env, FIXTURE_VERSION: "3.0.2" }));
      assert.equal(prepared.changed, true);
      assert.equal(
        readFileSync(outputFile, "utf8"),
        `changed=true\nsource_sha=${git("rev-parse", "HEAD")}\npin_digest=${prepared.pinDigest}\n`,
      );
      console.log("Updated prepare GITHUB_OUTPUT:", readFileSync(outputFile, "utf8").trim());
      assert.equal(channel.cliVersion(checkout), "3.0.2");
      assert.match(prepared.pinDigest, /^[a-f0-9]{64}$/);
      console.log(
        "Prepared dev update:",
        JSON.stringify({
          sourceSha: prepared.sourceSha,
          cliVersion: channel.cliVersion(checkout),
          outdatedEvent: "skipped",
        }),
      );
    }
  }
});
