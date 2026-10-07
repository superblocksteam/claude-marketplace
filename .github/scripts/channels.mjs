import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const PUBLIC_NPM = "https://registry.npmjs.org/";
const GITHUB_PACKAGES = "https://npm.pkg.github.com/";
const PLUGIN = "plugins/superblocks-plugin";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const MANIFEST = `${PLUGIN}/.claude-plugin/plugin.json`;
const PIN_FILES = ["package.json", "package-lock.json"];
const BOT = {
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};
const MARKETPLACE_ENTRIES = [".claude-plugin", "plugins", "README.md"];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export class Channel {
  static #channels = [
    new Channel("beta", "beta", "main", "superblocks", PUBLIC_NPM, PLUGIN),
    new Channel("next", "next", "next", "superblocks-next", PUBLIC_NPM, "channels/next"),
    new Channel("dev", "master", "master", "superblocks-dev", GITHUB_PACKAGES, "channels/dev"),
  ];

  static all() {
    return [...Channel.#channels];
  }

  static named(name) {
    const channel = Channel.#channels.find((candidate) => candidate.name === name);
    if (!channel) {
      throw new Error(`Unknown channel "${name}"; expected beta, next, or dev.`);
    }
    return channel;
  }

  constructor(name, distTag, branch, marketplace, registry, pin) {
    this.name = name;
    this.distTag = distTag;
    this.branch = branch;
    this.marketplace = marketplace;
    this.registry = registry;
    this.pin = pin;
  }

  get isPublic() {
    return this.registry === PUBLIC_NPM;
  }

  get isMain() {
    return this.branch === "main";
  }

  assertPublic() {
    if (!this.isPublic) {
      throw new Error(
        `${this.name} installs private GitHub Packages builds and must not ship public artifacts.`,
      );
    }
  }

  displayName(base) {
    return this.isMain ? base : `${base} (${this.name})`;
  }

  pinDirectory(root) {
    return join(root, this.pin);
  }

  cliVersion(root) {
    const lockfile = readJson(join(this.pinDirectory(root), "package-lock.json"));
    return lockfile.packages["node_modules/@superblocksteam/cli"].version;
  }

  npmArgs() {
    return [
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${PUBLIC_NPM}`,
      `--@superblocksteam:registry=${this.registry}`,
    ];
  }

  pinTo(root, spec) {
    execFileSync(
      "npm",
      [
        "install",
        `@superblocksteam/cli@${spec}`,
        "--save-exact",
        "--package-lock-only",
        ...this.npmArgs(),
      ],
      { cwd: this.pinDirectory(root), stdio: "inherit" },
    );
  }

  install(pluginDirectory) {
    execFileSync("npm", ["ci", ...this.npmArgs()], { cwd: pluginDirectory, stdio: "inherit" });
  }
}

export class ChannelMarketplace {
  constructor(channel, root) {
    this.channel = channel;
    this.root = root;
  }

  write(destination, sourceSha) {
    this.#copySource(destination);
    if (this.channel.isMain) return;
    this.#copyPin(destination);
    this.#brand(destination, sourceSha);
  }

  #copySource(destination) {
    for (const entry of MARKETPLACE_ENTRIES) {
      cpSync(join(this.root, entry), join(destination, entry), {
        recursive: true,
        filter: (source) => basename(source) !== "node_modules",
      });
    }
  }

  #copyPin(destination) {
    for (const file of PIN_FILES) {
      cpSync(join(this.channel.pinDirectory(this.root), file), join(destination, PLUGIN, file));
    }
  }

  #brand(destination, sourceSha) {
    const version = `0.0.0-${this.channel.name}.g${sourceSha.slice(0, 12)}.cli-${this.channel.cliVersion(this.root)}`;
    const manifest = readJson(join(destination, MANIFEST));
    const displayName = this.channel.displayName(manifest.displayName);
    writeJson(join(destination, MANIFEST), { ...manifest, displayName, version });
    const marketplace = readJson(join(destination, MARKETPLACE));
    marketplace.name = this.channel.marketplace;
    marketplace.plugins = marketplace.plugins.map((plugin) =>
      plugin.name === manifest.name ? { ...plugin, displayName, version } : plugin,
    );
    writeJson(join(destination, MARKETPLACE), marketplace);
  }
}

export class ChannelBranch {
  #gitDirectory;

  constructor(channel, root, repository = root, remote = "origin") {
    this.channel = channel;
    this.root = root;
    this.repository = repository;
    this.remote = remote;
  }

  publish(sourceSha) {
    if (this.channel.isMain) {
      throw new Error(
        `${this.channel.name} is published by merging to main, not by a generated branch.`,
      );
    }
    const workspace = mkdtempSync(join(tmpdir(), `superblocks-${this.channel.name}-branch-`));
    try {
      const tree = join(workspace, "tree");
      new ChannelMarketplace(this.channel, this.root).write(tree, sourceSha);
      const parent = this.#tip();
      const treeSha = this.#writeTree(tree, join(workspace, "index"));
      if (parent && this.#git(["rev-parse", `${parent}^{tree}`]) === treeSha) {
        return { published: false, commit: parent };
      }
      const commit = this.#commit(treeSha, parent, sourceSha);
      this.#git(["push", "--quiet", this.remote, `${commit}:refs/heads/${this.channel.branch}`]);
      return { published: true, commit };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  #tip() {
    const ref = `refs/heads/${this.channel.branch}`;
    if (!this.#git(["ls-remote", "--heads", this.remote, ref])) return undefined;
    this.#git(["fetch", "--quiet", "--no-tags", this.remote, ref]);
    return this.#git(["rev-parse", "FETCH_HEAD"]);
  }

  #writeTree(tree, index) {
    const inTree = { cwd: tree, env: { GIT_INDEX_FILE: index } };
    this.#git(["--work-tree", tree, "add", "--all", "--force", "."], inTree);
    return this.#git(["write-tree"], inTree);
  }

  #commit(treeSha, parent, sourceSha) {
    const cliVersion = this.channel.cliVersion(this.root);
    const message = `chore(channel): publish ${this.channel.name} with CLI ${cliVersion} from ${sourceSha.slice(0, 12)}`;
    const parents = parent ? ["-p", parent] : [];
    return this.#git(["commit-tree", treeSha, ...parents, "-m", message], { env: BOT });
  }

  #git(args, { cwd = this.repository, env = {} } = {}) {
    this.#gitDirectory ??= execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: this.repository,
      encoding: "utf8",
    }).trim();
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: this.#gitDirectory, ...env },
    }).trim();
  }
}
