import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class GitWorktree {
  constructor(repository, prefix) {
    Object.assign(this, { repository, prefix });
  }

  use(commit, callback) {
    const directory = mkdtempSync(join(tmpdir(), this.prefix));
    const checkout = join(directory, "checkout");
    try {
      this.#git(["worktree", "add", "--quiet", "--detach", checkout, commit]);
      return callback(checkout, directory);
    } finally {
      try {
        this.#git(["worktree", "remove", "--force", "--force", checkout]);
      } catch {
        console.error(
          `Could not unregister temporary worktree ${checkout}; run git worktree prune after cleanup.`,
        );
      }
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        console.error(`Could not remove temporary directory ${directory}; remove it manually.`);
      }
    }
  }

  #git(args) {
    return execFileSync("git", args, {
      cwd: this.repository,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
