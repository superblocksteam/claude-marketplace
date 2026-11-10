import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class PluginVersion {
  constructor(root, channel, cliVersion) {
    Object.assign(this, { root, channel, cliVersion });
  }

  value() {
    const hash = createHash("sha256");
    for (const path of this.#trackedFiles()) {
      const file = join(this.root, path);
      const entry = lstatSync(file, { throwIfNoEntry: false });
      if (!entry) continue;
      if (!entry.isFile()) throw new Error(`Unsupported plugin entry: ${path}`);
      let content = readFileSync(file);
      if (path === "plugins/superblocks-plugin/.claude-plugin/plugin.json") {
        const metadata = JSON.parse(content);
        delete metadata.version;
        delete metadata.displayName;
        content = JSON.stringify(metadata);
      }
      hash.update(path).update("\0").update(content).update("\0");
    }
    const marketplace = JSON.parse(
      readFileSync(join(this.root, ".claude-plugin/marketplace.json")),
    );
    delete marketplace.name;
    for (const plugin of marketplace.plugins) {
      if (plugin.name !== "superblocks") continue;
      delete plugin.version;
      delete plugin.displayName;
    }
    hash.update(JSON.stringify(marketplace));
    return `0.0.0-${this.channel}.h${hash.digest("hex").slice(0, 12)}.cli-${this.cliVersion}`;
  }

  #trackedFiles() {
    const output = execFileSync("git", ["ls-files", "--stage", "-z", "--", "plugins/"], {
      cwd: this.root,
      encoding: "utf8",
    });
    const paths = new Set();
    for (const entry of output.split("\0").filter(Boolean)) {
      const path = entry.slice(entry.indexOf("\t") + 1);
      if (path.split("/").includes("node_modules")) continue;
      if (!/^100(644|755) /.test(entry)) throw new Error(`Unsupported plugin entry: ${path}`);
      paths.add(path);
    }
    return [...paths].sort();
  }
}
