import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Channel } from "../.github/scripts/channels.mjs";
import { ChannelBranch } from "../.github/scripts/forward-channel.mjs";

const plugin = "plugins/superblocks-plugin";
const manifest = `${plugin}/.claude-plugin/plugin.json`;
const marketplace = ".claude-plugin/marketplace.json";

class ChannelRepository {
  constructor(t, legacy = false) {
    this.directory = mkdtempSync(join(tmpdir(), "marketplace-forward-"));
    this.origin = join(this.directory, "origin.git");
    this.checkout = join(this.directory, "checkout");
    this.env = { ...process.env };
    t.after(() => rmSync(this.directory, { recursive: true, force: true }));
    this.git("init", "--quiet", "--bare", this.origin);
    this.git("init", "--quiet", "--initial-branch=main", this.checkout);
    this.ready = true;
    this.git("remote", "add", "origin", this.origin);
    this.write("package.json", { private: true });
    this.write(".github/workflows/channels.yml", "shared workflow\n");
    this.write("README.md", "shared documentation\n");
    this.write("shared.txt", "one\ntwo\nthree\n");
    this.write(`${plugin}/package.json`, {
      private: true,
      dependencies: { "@superblocksteam/cli": "1.0.0" },
      overrides: { qs: "6.16.0" },
    });
    this.pin("1.0.0");
    this.brand("beta");
    const destinations = [
      ["next", "next", "2.0.0-next.1"],
      ["master", "dev", "3.0.0-SNAPSHOT.1"],
    ];
    if (legacy) {
      for (const [, channel, version] of destinations) {
        this.pin(version);
        for (const file of ["package.json", "package-lock.json"])
          this.write(
            `channels/${channel}/${file}`,
            readFileSync(join(this.checkout, plugin, file), "utf8"),
          );
      }
      this.pin("1.0.0");
    }
    this.main = this.commit("main", "initial source");
    for (const [branch, channel, version] of destinations) {
      this.git("switch", "--quiet", "--detach", this.main);
      if (legacy) {
        this.git("switch", "--quiet", "--orphan", `legacy-${channel}`);
        this.write("README.md", "shared documentation\n");
        this.write(`${plugin}/package.json`, {
          private: true,
          dependencies: { "@superblocksteam/cli": version },
          overrides: { qs: "6.16.0" },
        });
      }
      this.pin(version);
      this.brand(channel);
      if (legacy) {
        const entry = JSON.parse(readFileSync(join(this.checkout, manifest), "utf8"));
        entry.version = `0.0.0-${channel}.g${this.main.slice(0, 12)}.cli-${version}`;
        this.write(manifest, entry);
      }
      this.commit(branch, `own ${channel} pin`);
    }
    this.git("switch", "--quiet", "main");
    if (legacy) {
      this.git("rm", "-r", "--quiet", "channels");
      this.main = this.commit("main", "move channel pins to their branches");
    }
    const bin = join(this.directory, "bin");
    mkdirSync(bin);
    this.npmCalls = join(this.directory, "npm-calls.jsonl");
    writeFileSync(
      join(bin, "npm"),
      `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FORWARD_NPM_CALLS, JSON.stringify({ args, token: process.env.GH_TOKEN, cwd: process.cwd() }) + "\\n");
if (process.env.FORWARD_FAIL_INSTALL) process.exit(17);
if (args[0] === "ci") {
  if (process.env.FORWARD_INVALID_LOCK) {
    console.error("npm error code EUSAGE: constrained lockfile does not satisfy dependency ranges");
    process.exit(1);
  }
  process.exit(0);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = args[0] === "update" ? pkg.dependencies["@superblocksteam/cli"] : args[1].slice("@superblocksteam/cli@".length);
pkg.dependencies["@superblocksteam/cli"] = version;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\\n");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.packages[""].dependencies = pkg.dependencies;
lock.packages["node_modules/@superblocksteam/cli"].version = version;
lock.overridesObserved = pkg.overrides;
if (process.env.FORWARD_FLOAT_DEPENDENCY) lock.packages["node_modules/unrelated"] = { version: "9.9.9", resolved: "https://registry.npmjs.org/unrelated/-/unrelated-9.9.9.tgz" };
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\\n");
`,
      { mode: 0o755 },
    );
    Object.assign(process.env, {
      PATH: `${bin}:${process.env.PATH}`,
      FORWARD_NPM_CALLS: this.npmCalls,
      GH_TOKEN: "fixture-write-token",
    });
    t.after(() => {
      process.env = this.env;
    });
  }

  git(...args) {
    return execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      {
        cwd: this.ready ? this.checkout : this.directory,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
  }

  write(path, value) {
    this.ready = true;
    const destination = join(this.checkout, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  json(ref, path) {
    return JSON.parse(this.git("show", `${ref}:${path}`));
  }

  pin(version) {
    const path = `${plugin}/package.json`;
    const pkg = JSON.parse(readFileSync(join(this.checkout, path), "utf8"));
    pkg.dependencies["@superblocksteam/cli"] = version;
    this.write(path, pkg);
    this.write(`${plugin}/package-lock.json`, {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: pkg.dependencies },
        "node_modules/@superblocksteam/cli": { version },
      },
    });
  }

  brand(name) {
    const channel = Channel.named(name);
    const entry = {
      name: "superblocks",
      displayName: channel.displayName("Superblocks"),
      version: "1.0.0",
      description: "original description",
    };
    this.write(manifest, entry);
    this.write(marketplace, { name: channel.marketplace, plugins: [entry] });
  }

  commit(branch, message) {
    this.git("add", ".");
    this.git("commit", "--quiet", "-m", message);
    const sha = this.git("rev-parse", "HEAD");
    this.git("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    return sha;
  }

  forward(name) {
    return new ChannelBranch(Channel.named(name), this.checkout);
  }
}

test("forward merges carry shared changes main -> next -> master while pins stay on their branches", (t) => {
  const repo = new ChannelRepository(t);
  repo.write("shared.txt", "one\ntwo\nupstream fix\n");
  const pkg = repo.json("HEAD", `${plugin}/package.json`);
  pkg.overrides.qs = "6.16.1";
  repo.write(`${plugin}/package.json`, pkg);
  repo.pin("1.0.1");
  const main = repo.commit("main", "shared fix and beta bump");
  repo.git("switch", "--quiet", "--detach", "origin/next");
  repo.write("next-only.txt", "staging experiment\n");
  const previous = repo.commit("next", "staging work");
  const next = repo.forward("next");
  const candidate = next.prepare(main);
  assert.equal(
    repo.git("rev-parse", "origin/next"),
    previous,
    "prepare cannot publish before validation",
  );
  assert.equal(repo.git("show", `${candidate.commit}:next-only.txt`), "staging experiment");
  assert.equal(repo.git("show", `${candidate.commit}:shared.txt`), "one\ntwo\nupstream fix");
  assert.deepEqual(
    repo.git("rev-list", "--parents", "-n", "1", candidate.commit).split(" ").slice(1),
    [previous, main],
  );
  assert.equal(
    repo.json(candidate.commit, `${plugin}/package.json`).dependencies["@superblocksteam/cli"],
    "2.0.0-next.1",
  );
  assert.equal(repo.json(candidate.commit, `${plugin}/package.json`).overrides.qs, "6.16.1");
  assert.equal(
    repo.json(candidate.commit, `${plugin}/package-lock.json`).overridesObserved.qs,
    "6.16.1",
  );
  assert.equal(repo.json(candidate.commit, marketplace).name, "superblocks-next");
  assert.equal(repo.json(candidate.commit, manifest).displayName, "Superblocks (next)");
  next.publish(candidate.commit);
  const dev = repo.forward("dev");
  const master = dev.prepare(candidate.commit);
  dev.publish(master.commit);
  repo.git("merge-base", "--is-ancestor", main, master.commit);
  repo.git("merge-base", "--is-ancestor", candidate.commit, master.commit);
  assert.equal(
    repo.json(master.commit, `${plugin}/package.json`).dependencies["@superblocksteam/cli"],
    "3.0.0-SNAPSHOT.1",
  );
  assert.equal(repo.json(master.commit, marketplace).name, "superblocks-dev");
  assert.equal(repo.json(master.commit, manifest).displayName, "Superblocks (dev)");
  assert.equal(repo.git("show", `${master.commit}:next-only.txt`), "staging experiment");
  assert.deepEqual(next.prepare(main), { changed: false, commit: candidate.commit });
  const calls = readFileSync(repo.npmCalls, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(
    calls.every(({ token }) => token === undefined),
    "npm must not receive GitHub write credentials",
  );
  console.log(
    "Forward merge observed:",
    JSON.stringify({
      main,
      next: candidate.commit,
      master: master.commit,
      nextPin: repo.json(candidate.commit, `${plugin}/package.json`).dependencies,
      devPin: repo.json(master.commit, `${plugin}/package.json`).dependencies,
      parents: repo.git("rev-list", "--parents", "-n", "1", master.commit),
    }),
  );
});

test("legacy package-only snapshots migrate without rewriting history or losing their pins", (t) => {
  const repo = new ChannelRepository(t, true);
  const previous = repo.git("rev-parse", "origin/next");
  const candidate = repo.forward("next").prepare(repo.main);
  const paths = repo.git("ls-tree", "-r", "--name-only", candidate.commit).split("\n");
  assert.ok(paths.includes(".github/workflows/channels.yml"));
  assert.ok(paths.includes("package.json"));
  repo.git("merge-base", "--is-ancestor", previous, candidate.commit);
  repo.git("merge-base", "--is-ancestor", repo.main, candidate.commit);
  assert.equal(
    repo.json(candidate.commit, `${plugin}/package.json`).dependencies["@superblocksteam/cli"],
    "2.0.0-next.1",
  );
  console.log(
    "Legacy migration observed:",
    JSON.stringify({ previous, candidate: candidate.commit, paths }),
  );
});

test("migration refuses to discard files unique to the destination snapshot", (t) => {
  const repo = new ChannelRepository(t, true);
  repo.git("switch", "--quiet", "--detach", "origin/next");
  repo.write(`${plugin}/local-skill.md`, "unique staging work\n");
  const previous = repo.commit("next", "staging addition");
  assert.throws(() => repo.forward("next").prepare(repo.main), /unexpected|unique|discard/i);
  assert.equal(repo.git("rev-parse", "origin/next"), previous);
});

test("migration rejects independent edits to a shared legacy path", (t) => {
  const repo = new ChannelRepository(t, true);
  repo.git("switch", "--quiet", "--detach", "origin/next");
  repo.write("README.md", "independent staging documentation\n");
  const previous = repo.commit("next", "edit shared legacy path");
  assert.throws(() => repo.forward("next").prepare(repo.main), /Legacy.*README.md/);
  assert.equal(repo.git("rev-parse", "origin/next"), previous);
});

test("migration rejects independent deletions from the legacy snapshot", (t) => {
  const repo = new ChannelRepository(t, true);
  repo.git("switch", "--quiet", "--detach", "origin/next");
  repo.git("rm", "README.md");
  const previous = repo.commit("next", "remove legacy documentation");
  assert.throws(() => repo.forward("next").prepare(repo.main), /Legacy.*README.md/);
  assert.equal(repo.git("rev-parse", "origin/next"), previous);
});

test("migration rejects a substituted legacy lockfile before installing it", (t) => {
  const repo = new ChannelRepository(t, true);
  repo.git("switch", "--quiet", "--detach", "origin/next");
  const lock = repo.json("HEAD", `${plugin}/package-lock.json`);
  lock.packages["node_modules/substituted"] = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/substituted/-/substituted-1.0.0.tgz",
    integrity: "changed-lock",
  };
  repo.write(`${plugin}/package-lock.json`, lock);
  const previous = repo.commit("next", "substitute legacy lockfile");
  assert.throws(() => repo.forward("next").prepare(repo.main), /Legacy.*package-lock.json/);
  assert.equal(repo.git("rev-parse", "origin/next"), previous);
  assert.equal(existsSync(repo.npmCalls), false, "substituted lockfile must never reach npm");
});

test("forward merges propagate the shared display name while retaining channel suffixes", (t) => {
  const repo = new ChannelRepository(t);
  const entry = repo.json("HEAD", manifest);
  entry.displayName = "Superblocks AI";
  repo.write(manifest, entry);
  const catalog = repo.json("HEAD", marketplace);
  catalog.plugins[0].displayName = "Superblocks AI";
  repo.write(marketplace, catalog);
  let source = repo.commit("main", "rename shared product display name");
  for (const name of ["next", "dev"]) {
    const branch = repo.forward(name);
    const candidate = branch.prepare(source);
    assert.equal(repo.json(candidate.commit, manifest).displayName, `Superblocks AI (${name})`);
    assert.equal(
      repo.json(candidate.commit, marketplace).plugins[0].displayName,
      `Superblocks AI (${name})`,
    );
    branch.publish(candidate.commit);
    source = candidate.commit;
  }
});

test("forward publication rejects unreviewed dependency additions", (t) => {
  const repo = new ChannelRepository(t);
  repo.write("README.md", "upstream documentation change\n");
  const source = repo.commit("main", "update documentation");
  process.env.FORWARD_FLOAT_DEPENDENCY = "1";
  const previous = repo.git("rev-parse", "origin/next");
  assert.throws(() => repo.forward("next").prepare(source), /unreviewed.*unrelated/i);
  assert.equal(repo.git("rev-parse", "origin/next"), previous);
});

test("forward preparation rejects an incompatible constrained lock before publication", (t) => {
  const repo = new ChannelRepository(t);
  repo.write("README.md", "upstream documentation change\n");
  const source = repo.commit("main", "update documentation");
  const previous = repo.git("rev-parse", "origin/next");
  process.env.FORWARD_INVALID_LOCK = "1";
  assert.throws(() => repo.forward("next").prepare(source), /Unreviewed dependency change/);
  assert.equal(repo.git("rev-parse", "origin/next"), previous);
  const calls = readFileSync(repo.npmCalls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.at(-1).args.slice(0, 2), ["ci", "--dry-run"]);
});

test("add/add metadata conflicts identify the file without a merge-base blob", (t) => {
  const repo = new ChannelRepository(t);
  repo.git("rm", "--quiet", manifest);
  const withoutManifest = repo.commit("main", "remove manifest before independent additions");
  repo.git("--git-dir", repo.origin, "update-ref", "refs/heads/next", withoutManifest);
  repo.git("switch", "--quiet", "--detach", withoutManifest);
  repo.brand("next");
  repo.pin("2.0.0-next.1");
  const previous = repo.commit("next", "add next metadata");
  repo.git("switch", "--quiet", "main");
  repo.brand("beta");
  const entry = JSON.parse(readFileSync(join(repo.checkout, manifest), "utf8"));
  entry.description = "independent upstream metadata";
  repo.write(manifest, entry);
  const source = repo.commit("main", "add beta metadata");
  assert.throws(
    () => repo.forward("next").prepare(source),
    /Shared metadata conflict: plugins\/superblocks-plugin\/\.claude-plugin\/plugin.json/,
  );
  assert.equal(repo.git("ls-remote", "origin", "refs/heads/next").split(/\s/)[0], previous);
});

test("conflicting shared code, failed npm resolution, and concurrent updates never overwrite the destination", (t) => {
  const repo = new ChannelRepository(t);
  repo.write("shared.txt", "main conflicts\n");
  const main = repo.commit("main", "main change");
  repo.git("switch", "--quiet", "--detach", "origin/next");
  repo.write("shared.txt", "next conflicts\n");
  const previous = repo.commit("next", "next change");
  const next = repo.forward("next");
  assert.throws(() => next.prepare(main), /conflict/i);
  assert.equal(repo.git("rev-parse", "origin/next"), previous);
  console.log("Shared conflict rejected; destination preserved:", previous);
  repo.git("switch", "--quiet", "--detach", previous);
  repo.write("shared.txt", "one\ntwo\nthree\n");
  const resolved = repo.commit("next", "resolve staging divergence");
  process.env.FORWARD_FAIL_INSTALL = "1";
  assert.throws(() => next.prepare(main), { status: 17, message: /npm install/ });
  assert.equal(repo.git("rev-parse", "origin/next"), resolved);
  delete process.env.FORWARD_FAIL_INSTALL;
  const candidate = next.prepare(main);
  repo.write("raced.txt", "new staging change\n");
  const advanced = repo.commit("next", "concurrent update");
  assert.throws(
    () => next.publish(candidate.commit),
    (error) => {
      const expected = repo.git("rev-parse", `${candidate.commit}^1`);
      assert.ok(error.message.includes(`next changed: expected ${expected}, found ${advanced}`));
      assert.match(error.message, /Re-run all jobs/);
      assert.match(error.message, /failed jobs.*stale bundle/);
      return true;
    },
  );
  assert.equal(repo.git("rev-parse", "origin/next"), advanced);
  console.log("Concurrent update rejected; destination preserved:", advanced);
});
