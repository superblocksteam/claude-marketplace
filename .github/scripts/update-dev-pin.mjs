import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOT, Channel, PIN_FILES, PLUGIN } from "./channels.mjs";

export class DevPinUpdate {
  publish() {
    const channel = Channel.named("dev");
    const directory = mkdtempSync(join(tmpdir(), "superblocks-dev-pin-"));
    const checkout = join(directory, "checkout");
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: checkout,
        encoding: "utf8",
        env: { ...process.env, ...BOT, GIT_TERMINAL_PROMPT: "0" },
      }).trim();
    try {
      const version = this.#latestVersion(channel);
      execFileSync(
        "git",
        [
          "clone",
          "--quiet",
          "--single-branch",
          "--branch=master",
          "https://github.com/superblocksteam/claude-marketplace.git",
          checkout,
        ],
        { stdio: "inherit" },
      );
      channel.assertCurrent(checkout);
      if (channel.cliVersion(checkout) === version)
        return `master already pins ${version}; no update needed.`;
      const previous = git("rev-parse", "HEAD");
      channel.pinTo(checkout, version);
      channel.brand(checkout, previous);
      channel.verify(checkout, join(directory, "dist"));
      if (this.#latestVersion(channel) !== version)
        throw new Error("The master CLI tag changed during verification; retry this stale update.");
      git(
        "add",
        ...PIN_FILES.map((file) => `${PLUGIN}/${file}`),
        `${PLUGIN}/.claude-plugin/plugin.json`,
        ".claude-plugin/marketplace.json",
      );
      git("commit", "--quiet", "-m", `chore(plugin): pin dev CLI ${version}`);
      git(
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "--quiet",
        "origin",
        "HEAD:refs/heads/master",
      );
      return `master now pins ${version} at ${git("rev-parse", "HEAD")}.`;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  #latestVersion(channel) {
    return channel.withNpm((cwd, env) => {
      const output = execFileSync(
        "npm",
        [
          "view",
          "@superblocksteam/cli@master",
          "version",
          "--json",
          "--prefer-online",
          ...channel.npmArgs(),
        ],
        { cwd, env, encoding: "utf8" },
      );
      let value;
      try {
        value = JSON.parse(output);
      } catch (cause) {
        throw new Error("npm view @superblocksteam/cli@master returned invalid JSON.", { cause });
      }
      if (!Channel.isExactVersion(value))
        throw new Error(`Invalid CLI version: ${JSON.stringify(value)}`);
      return value;
    });
  }
}
