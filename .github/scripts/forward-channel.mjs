import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ChannelPublication } from "./channel-publication.mjs";
import { BOT, MANIFEST, MARKETPLACE, PLUGIN, readJson, writeJson } from "./channels.mjs";
import { GitWorktree } from "./git-worktree.mjs";

export class ChannelBranch {
  constructor(channel, repository, remote = "origin") {
    Object.assign(this, { channel, repository, remote });
  }

  prepare(sourceSha) {
    if (!this.channel.parent) throw new Error("beta is published by merging to main.");
    this.#sha(sourceSha);
    const sourceTip = this.#tip(this.channel.parent);
    if (!this.#ancestor(sourceSha, sourceTip))
      throw new Error(
        `Source commit ${sourceSha} is no longer on ${this.channel.parent} (current tip ${sourceTip}). ${ChannelPublication.retryInstructions}`,
      );
    const previous = this.#tip(this.channel.branch);
    if (this.#ancestor(sourceSha, previous)) return { changed: false, commit: previous };
    return new GitWorktree(this.repository, "superblocks-forward-").use(
      previous,
      (checkout, directory) => {
        this.channel.assertCurrent(checkout);
        const version = this.channel.cliVersion(checkout);
        const lock = readFileSync(join(checkout, PLUGIN, "package-lock.json"), "utf8");
        const owned = new Map([
          [`${PLUGIN}/package.json`, { cli: version }],
          [MANIFEST, readJson(join(checkout, MANIFEST))],
          [MARKETPLACE, readJson(join(checkout, MARKETPLACE))],
        ]);
        if (!existsSync(join(checkout, "package.json"))) {
          this.#migrate(checkout, sourceSha, owned);
        } else {
          const merge = this.#run(["merge", "--no-commit", "--no-ff", sourceSha], checkout);
          if (merge.status !== 0 && merge.status !== 1)
            throw new Error(`Git merge failed: ${merge.stderr}`);
          const conflicts = this.#git(["diff", "--name-only", "--diff-filter=U"], checkout)
            .split("\n")
            .filter(Boolean);
          for (const file of conflicts) {
            if (file === `${PLUGIN}/package-lock.json`) continue;
            if (!owned.has(file))
              throw new Error(
                `Shared file conflict: ${file}. Resolve it on ${this.channel.branch} before retrying.`,
              );
            this.#resolve(checkout, file, owned.get(file), directory);
          }
        }
        for (const [file, settings] of owned) {
          const value = readJson(join(checkout, file));
          this.#preserve(file, value, settings);
          writeJson(join(checkout, file), value);
        }
        writeFileSync(join(checkout, PLUGIN, "package-lock.json"), lock);
        const reviewedLock = JSON.parse(
          this.#git(["show", `${sourceSha}:${PLUGIN}/package-lock.json`], checkout),
        );
        this.channel.pinTo(checkout, version, reviewedLock);
        this.channel.brand(checkout);
        this.#git(["add", "--all"], checkout);
        const tree = this.#git(["write-tree"], checkout);
        const commit = this.#git([
          "commit-tree",
          tree,
          "-p",
          previous,
          "-p",
          sourceSha,
          "-m",
          `chore(channel): merge ${this.channel.parent} into ${this.channel.branch}`,
        ]);
        return { changed: true, commit };
      },
    );
  }

  publish(commit) {
    if (!this.channel.parent) throw new Error("beta is published by merging to main.");
    this.#sha(commit);
    const previous = this.#tip(this.channel.branch);
    if (previous === commit) return { published: false, commit };
    const parents = this.#git(["rev-list", "--parents", "-n", "1", commit]).split(" ").slice(1);
    if (parents.length !== 2) throw new Error("Expected a prepared two-parent channel merge.");
    const publication = new ChannelPublication(this.repository, this.channel.branch, this.remote);
    publication.assertTip(parents[0], previous);
    publication.publish(commit, previous);
    return { published: true, commit };
  }

  #migrate(checkout, sourceSha, owned) {
    const files = this.#git(["ls-tree", "-r", "--name-only", "HEAD"], checkout)
      .split("\n")
      .filter(Boolean);
    const stamp = owned.get(MANIFEST).version.match(/\.g([0-9a-f]{12})\.cli-/)?.[1];
    if (!stamp) throw this.#migrationError("Legacy channel has no source stamp");
    const resolved = this.#run(["rev-parse", "--verify", `${stamp}^{commit}`], checkout);
    if (resolved.status !== 0)
      throw this.#migrationError(`Legacy source commit ${stamp} is unavailable or ambiguous`);
    const baseline = resolved.stdout.trim();
    if (!this.#ancestor(baseline, sourceSha))
      throw this.#migrationError("Legacy source is not an ancestor of the incoming source");
    const expectedFiles = this.#git(
      ["ls-tree", "-r", "--name-only", baseline, "--", "README.md", ".claude-plugin", "plugins"],
      checkout,
    )
      .split("\n")
      .filter(Boolean);
    const unexpected = files.filter((file) => !expectedFiles.includes(file));
    if (unexpected.length)
      throw this.#migrationError(
        `Legacy channel contains unexpected files: ${JSON.stringify(unexpected)}`,
      );
    for (const file of expectedFiles) {
      if (!files.includes(file))
        throw this.#migrationError(`Legacy channel independently deleted ${file}`);
    }
    for (const file of files) {
      let sourcePath = file;
      if (file === `${PLUGIN}/package.json` || file === `${PLUGIN}/package-lock.json`)
        sourcePath = `channels/${this.channel.name}/${file.slice(PLUGIN.length + 1)}`;
      const original = this.#run(["show", `${baseline}:${sourcePath}`], checkout);
      if (original.status !== 0)
        throw this.#migrationError(`Legacy channel contains an independent file: ${file}`);
      let matches;
      if (owned.has(file)) {
        const expected = JSON.parse(original.stdout);
        this.#preserve(file, expected, owned.get(file));
        matches = isDeepStrictEqual(expected, readJson(join(checkout, file)));
      } else {
        matches =
          this.#git(["rev-parse", `HEAD:${file}`], checkout) ===
          this.#git(["rev-parse", `${baseline}:${sourcePath}`], checkout);
      }
      const mode = (ref, path) => this.#git(["ls-tree", ref, "--", path], checkout).split(" ")[0];
      if (!matches || mode("HEAD", file) !== mode(baseline, sourcePath))
        throw this.#migrationError(`Legacy channel independently changed ${file}`);
    }
    this.#git(["read-tree", "--reset", "-u", sourceSha], checkout);
  }

  #migrationError(reason) {
    return new Error(
      `${reason}. Create a manual migration PR on ${this.channel.branch}: combine the full ${this.channel.parent} repository tree with this channel's CLI pin and reviewed local changes, regenerate channel branding, and run channel verification before retrying.`,
    );
  }

  #resolve(checkout, file, owned, directory) {
    const paths = [2, 1, 3].map((stage) => {
      const original = this.#run(["show", `:${stage}:${file}`], checkout);
      if (original.status !== 0)
        throw new Error(
          `Shared metadata conflict: ${file}. No common file exists; resolve it on ${this.channel.branch} before retrying.`,
        );
      const value = JSON.parse(original.stdout);
      this.#preserve(file, value, owned);
      const path = join(directory, `merge-${stage}.json`);
      writeJson(path, value);
      return path;
    });
    const result = this.#run(["merge-file", "-p", ...paths], checkout);
    if (result.status !== 0)
      throw new Error(
        `Shared metadata conflict: ${file}. Resolve it on ${this.channel.branch} before retrying.`,
      );
    writeFileSync(join(checkout, file), result.stdout);
  }

  #preserve(file, value, owned) {
    if (file === `${PLUGIN}/package.json`) value.dependencies["@superblocksteam/cli"] = owned.cli;
    else if (file === MANIFEST) {
      value.displayName = this.channel.displayName(value.displayName);
      value.version = owned.version;
    } else {
      value.name = owned.name;
      const target = owned.plugins.find((entry) => entry.name === "superblocks");
      const entry = value.plugins.find((entry) => entry.name === "superblocks");
      if (!entry || !target) throw new Error("The Superblocks marketplace entry is missing.");
      entry.displayName = this.channel.displayName(entry.displayName);
      entry.version = target.version;
    }
  }

  #sha(value) {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Expected a full Git commit SHA.");
    if (this.#run(["cat-file", "-e", `${value}^{commit}`]).status !== 0)
      throw new Error(
        `Commit ${value} is unavailable. Fetch the commit and retry with its full SHA.`,
      );
  }

  #ancestor(ancestor, descendant) {
    const result = this.#run(["merge-base", "--is-ancestor", ancestor, descendant]);
    if (result.status > 1 || result.status === null)
      throw new Error(`Cannot compare Git commits: ${result.stderr}`);
    return result.status === 0;
  }

  #tip(branch) {
    this.#git(["fetch", "--quiet", "--no-tags", this.remote, `refs/heads/${branch}`]);
    return this.#git(["rev-parse", "FETCH_HEAD"]);
  }

  #run(args, cwd = this.repository) {
    return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...BOT } });
  }

  #git(args, cwd = this.repository) {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...BOT },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }
}
