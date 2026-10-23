import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class PluginVersion {
  constructor(root, channel, cliVersion) {
    Object.assign(this, { root, channel, cliVersion });
  }

  value() {
    const hash = createHash("sha256");
    const visit = (path) => {
      for (const entry of readdirSync(join(this.root, path), { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name, "en"),
      )) {
        if (entry.name === "node_modules") continue;
        const child = `${path}/${entry.name}`;
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) {
          let content = readFileSync(join(this.root, child));
          if (child === "plugins/superblocks-plugin/.claude-plugin/plugin.json") {
            const metadata = JSON.parse(content);
            delete metadata.version;
            delete metadata.displayName;
            content = JSON.stringify(metadata);
          }
          hash.update(child).update("\0").update(content).update("\0");
        } else throw new Error(`Unsupported plugin entry: ${child}`);
      }
    };
    visit("plugins");
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
}
