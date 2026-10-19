import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Channel } from "./channels.mjs";

export class DevPinUpdate {
  static files = [
    "plugins/superblocks-plugin/package-lock.json",
    "plugins/superblocks-plugin/package.json",
  ];

  constructor(root) {
    this.root = root;
    this.channel = Channel.named("dev");
  }

  prepare(version, env = process.env) {
    if (!Channel.isExactVersion(version))
      throw new Error(`Invalid CLI version: ${JSON.stringify(version)}`);
    if (this.#git("status", "--porcelain")) throw new Error("Dev pin checkout must be clean.");
    this.channel.validate(this.root, "master");
    const sourceSha = this.#git("rev-parse", "HEAD");
    if (this.channel.latestVersion(env) !== version) {
      console.log(`Skipping CLI ${version}: @master has moved.`);
      return { changed: false, sourceSha };
    }
    const changed = this.channel.pinTo(this.root, version, env);
    const digest = createHash("sha256");
    for (const file of DevPinUpdate.files)
      digest.update(readFileSync(join(this.root, file))).update("\0");
    return { changed, sourceSha, pinDigest: digest.digest("hex") };
  }

  publish(version, pinDigest, env = process.env) {
    if (!/^[a-f0-9]{64}$/.test(pinDigest)) throw new Error("Invalid validated pin digest.");
    const prepared = this.prepare(version, env);
    if (!prepared.changed) return prepared;
    if (prepared.pinDigest !== pinDigest)
      throw new Error("Reconstructed pin does not match the validated pin.");
    if (this.channel.latestVersion(env) !== version) {
      console.log(`Skipping CLI ${version}: @master has moved.`);
      return { changed: false, sourceSha: prepared.sourceSha };
    }
    this.#git("add", "--", ...DevPinUpdate.files);
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
    this.#git(
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "origin",
      "HEAD:refs/heads/master",
    );
    return { commit: this.#git("rev-parse", "HEAD"), version, files: DevPinUpdate.files };
  }

  #git(...args) {
    return execFileSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
}
