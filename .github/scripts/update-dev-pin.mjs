import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelPublication } from "./channel-publication.mjs";
import { BOT, Channel, MANIFEST, MARKETPLACE, PIN_FILES, PLUGIN } from "./channels.mjs";

export class DevPinUpdate {
  constructor(repository, remote = "origin") {
    Object.assign(this, { repository, remote });
  }

  prepare() {
    const channel = Channel.named("dev");
    const version = this.#latestVersion(channel);
    const previous = this.#tip();
    const directory = mkdtempSync(join(tmpdir(), "superblocks-dev-pin-"));
    const checkout = join(directory, "checkout");
    this.#git(["worktree", "add", "--quiet", "--detach", checkout, previous]);
    try {
      channel.assertCurrent(checkout);
      if (channel.cliVersion(checkout) === version)
        return { changed: false, commit: previous, version };
      channel.pinTo(checkout, version);
      channel.brand(checkout);
      this.#git(["add", ...this.#files()], checkout);
      const tree = this.#git(["write-tree"], checkout);
      const commit = this.#git([
        "commit-tree",
        tree,
        "-p",
        previous,
        "-m",
        `chore(plugin): pin dev CLI ${version}`,
      ]);
      return { changed: true, commit, version };
    } finally {
      this.#git(["worktree", "remove", "--force", checkout]);
      rmSync(directory, { recursive: true, force: true });
    }
  }

  verify(commit, destination) {
    this.#assertCommit(commit);
    if (this.#git(["rev-parse", "HEAD"]) !== commit)
      throw new Error("Check out the prepared dev pin before verification.");
    Channel.named("dev").verify(this.repository, destination);
    this.#git(["diff", "--exit-code", commit, "--"]);
  }

  publish(commit) {
    this.#assertCommit(commit);
    const previous = this.#tip();
    const parents = this.#git(["rev-list", "--parents", "-n", "1", commit]).split(" ").slice(1);
    if (parents.length !== 1) throw new Error("Expected a prepared single-parent dev pin.");
    const publication = new ChannelPublication(this.repository, "master", this.remote);
    publication.assertTip(parents[0], previous);
    const changed = this.#git(["diff", "--name-only", previous, commit]).split("\n");
    if (changed.some((file) => !this.#files().includes(file)))
      throw new Error("The dev pin candidate changes files outside its pin and branding.");
    const pkg = JSON.parse(this.#git(["show", `${commit}:${PLUGIN}/package.json`]));
    const version = pkg.dependencies["@superblocksteam/cli"];
    const channel = Channel.named("dev");
    const latest = this.#latestVersion(channel);
    if (latest !== version)
      throw new Error(
        `The master CLI tag changed: expected ${version}, found ${latest}. ${ChannelPublication.retryInstructions}`,
      );
    this.#assertArtifact(commit, channel, version);
    publication.publish(commit, previous);
    return `master now pins ${version} at ${commit}.`;
  }

  #files() {
    return [...PIN_FILES.map((file) => `${PLUGIN}/${file}`), MANIFEST, MARKETPLACE];
  }

  #assertCommit(commit) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Expected a full Git commit SHA.");
    this.#git(["cat-file", "-e", `${commit}^{commit}`]);
  }

  #tip() {
    this.#git(["fetch", "--quiet", "--no-tags", this.remote, "refs/heads/master"]);
    return this.#git(["rev-parse", "FETCH_HEAD"]);
  }

  #git(args, cwd = this.repository) {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...BOT, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }

  #latestVersion(channel) {
    const value = this.#registryValue(channel, "master", "version");
    if (!Channel.isExactVersion(value))
      throw new Error(`Invalid CLI version: ${JSON.stringify(value)}`);
    return value;
  }

  #assertArtifact(commit, channel, version) {
    const lock = JSON.parse(this.#git(["show", `${commit}:${PLUGIN}/package-lock.json`]));
    const pinned = lock.packages["node_modules/@superblocksteam/cli"];
    if (pinned?.version !== version || !pinned.resolved || !pinned.integrity)
      throw new Error("The prepared CLI pin is missing its exact artifact integrity.");
    const dist = this.#registryValue(channel, version, "dist");
    if (dist?.tarball !== pinned.resolved || dist?.integrity !== pinned.integrity)
      throw new Error(
        "The CLI artifact changed after preparation; discard this candidate and investigate the registry integrity.",
      );
  }

  #registryValue(channel, spec, field) {
    return channel.withNpm((cwd, env) => {
      const output = execFileSync(
        "npm",
        [
          "view",
          `@superblocksteam/cli@${spec}`,
          field,
          "--json",
          "--prefer-online",
          ...channel.npmArgs(),
        ],
        { cwd, env, encoding: "utf8" },
      );
      try {
        return JSON.parse(output);
      } catch (cause) {
        throw new Error(`npm view @superblocksteam/cli@${spec} returned invalid JSON.`, { cause });
      }
    });
  }
}
