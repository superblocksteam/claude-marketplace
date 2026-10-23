import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ChannelPublication {
  constructor(repository, branch, remote = "origin") {
    Object.assign(this, { repository, branch, remote });
  }

  publish(commit, previous) {
    const hooks = mkdtempSync(join(tmpdir(), "superblocks-publish-"));
    try {
      writeFileSync(
        join(hooks, "pre-push"),
        `#!/usr/bin/env bash
set -euo pipefail
while read -r local_ref local_sha remote_ref remote_sha; do
  if [[ "$remote_ref" != "$CHANNEL_TARGET_REF" || "$remote_sha" != "$CHANNEL_EXPECTED_TIP" ]]; then
    echo "Channel changed; discard this stale candidate and retry." >&2
    exit 1
  fi
done
`,
        { mode: 0o700 },
      );
      execFileSync(
        "git",
        [
          "-c",
          `core.hooksPath=${hooks}`,
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          "--quiet",
          this.remote,
          `${commit}:refs/heads/${this.branch}`,
        ],
        {
          cwd: this.repository,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            CHANNEL_EXPECTED_TIP: previous,
            CHANNEL_TARGET_REF: `refs/heads/${this.branch}`,
          },
          stdio: "inherit",
        },
      );
    } finally {
      rmSync(hooks, { recursive: true, force: true });
    }
  }
}
