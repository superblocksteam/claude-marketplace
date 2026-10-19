import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { Channel } from "./channels.mjs";

export class DevPinUpdate {
  static files = [
    ".claude-plugin/marketplace.json",
    "plugins/superblocks-plugin/.claude-plugin/plugin.json",
    "plugins/superblocks-plugin/package-lock.json",
    "plugins/superblocks-plugin/package.json",
  ];

  constructor(root) {
    this.root = root;
    this.channel = Channel.named("dev");
  }

  prepare(version, patch, env = process.env) {
    if (!Channel.isExactVersion(version))
      throw new Error(`Invalid CLI version: ${JSON.stringify(version)}`);
    if (Channel.current(this.root) !== this.channel) throw new Error("Dev pins belong on master.");
    if (this.#git("status", "--porcelain")) throw new Error("Dev pin checkout must be clean.");
    const sourceSha = this.#git("rev-parse", "HEAD");
    if (this.channel.latestVersion(env) !== version) {
      console.log(`Skipping CLI ${version}: @master has moved.`);
      return { changed: false, sourceSha };
    }
    const changed = this.channel.pinTo(this.root, version, env);
    if (changed)
      writeFileSync(patch, this.#git("diff", "--binary", "--", ...DevPinUpdate.files) + "\n");
    return { changed, sourceSha };
  }

  publish(patch) {
    if (this.#git("status", "--porcelain")) throw new Error("Dev pin checkout must be clean.");
    if (Channel.current(this.root) !== this.channel) throw new Error("Dev pins belong on master.");
    this.#git("apply", "--index", "--", patch);
    const files = this.#git("diff", "--cached", "--name-only").split("\n");
    if (
      files.some((file) => !DevPinUpdate.files.includes(file)) ||
      this.#git("diff", "--cached", "--summary")
    ) {
      throw new Error(`Unexpected dev pin change: ${files.join(", ")}`);
    }
    this.channel.validate(this.root);
    const version = this.channel.cliVersion(this.root);
    this.#git(
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "--quiet",
      "-m",
      `chore(plugin): pin dev CLI ${version}`,
    );
    this.#git("push", "origin", "HEAD:refs/heads/master");
    return { commit: this.#git("rev-parse", "HEAD"), version, files };
  }

  #git(...args) {
    return execFileSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
}
