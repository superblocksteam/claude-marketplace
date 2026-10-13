import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const PUBLIC_NPM = "https://registry.npmjs.org/";
const GITHUB_PACKAGES = "https://npm.pkg.github.com/";
const PLUGIN = "plugins/superblocks-plugin";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const MANIFEST = `${PLUGIN}/.claude-plugin/plugin.json`;
const PIN_FILES = ["package.json", "package-lock.json"];
const EXACT_CLI_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
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

  static isExactVersion(version) {
    return typeof version === "string" && EXACT_CLI_VERSION.test(version);
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

  pinTo(root, spec, env = process.env) {
    execFileSync(
      "npm",
      [
        "install",
        `@superblocksteam/cli@${spec}`,
        "--save-exact",
        "--package-lock-only",
        ...this.npmArgs(),
      ],
      { cwd: this.pinDirectory(root), stdio: "inherit", env },
    );
  }

  install(pluginDirectory) {
    execFileSync("npm", ["ci", ...this.npmArgs()], { cwd: pluginDirectory, stdio: "inherit" });
  }
}

export class DevPinUpdate {
  open() {
    const repository = "superblocksteam/claude-marketplace";
    const channel = Channel.named("dev");
    const workspace = mkdtempSync(join(tmpdir(), "superblocks-dev-pin-"));
    const checkout = join(workspace, "checkout");
    const npmRoot = join(workspace, "npm");
    const npmDirectory = channel.pinDirectory(npmRoot);
    const files = PIN_FILES.map((file) => join(channel.pin, file));
    const git = (...args) =>
      execFileSync(
        "git",
        ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args],
        {
          cwd: checkout,
          encoding: "utf8",
          env: { ...process.env, ...BOT, GIT_TERMINAL_PROMPT: "0" },
        },
      ).trim();
    const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
    const npmEnv = { ...process.env };
    for (const [name, value] of Object.entries({
      proxy: "null",
      https_proxy: "null",
      strict_ssl: "true",
    })) {
      npmEnv[`npm_config_${name}`] = value;
      npmEnv[`NPM_CONFIG_${name.toUpperCase()}`] = value;
    }
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]) {
      delete npmEnv[name];
    }
    try {
      mkdirSync(npmDirectory, { recursive: true });
      if (npmEnv.NODE_AUTH_TOKEN) {
        const npmrc = join(workspace, "npmrc");
        writeFileSync(npmrc, "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n", {
          mode: 0o600,
        });
        npmEnv.NPM_CONFIG_USERCONFIG = npmrc;
        npmEnv.npm_config_userconfig = npmrc;
      }
      const metadata = execFileSync(
        "npm",
        [
          "view",
          "@superblocksteam/cli@master",
          "version",
          "--json",
          "--prefer-online",
          ...channel.npmArgs(),
        ],
        { cwd: npmDirectory, encoding: "utf8", env: npmEnv },
      );
      let version;
      try {
        version = JSON.parse(metadata);
      } catch (cause) {
        throw new Error("npm view @superblocksteam/cli@master returned invalid JSON.", { cause });
      }
      if (!Channel.isExactVersion(version)) {
        throw new Error(`Invalid CLI version: ${JSON.stringify(version)}`);
      }
      console.log(`CLI @master resolved to ${version}.`);
      execFileSync(
        "git",
        [
          "clone",
          "--quiet",
          "--no-checkout",
          "--depth=1",
          "--single-branch",
          "--branch=main",
          `https://github.com/${repository}.git`,
          checkout,
        ],
        { stdio: "inherit" },
      );
      git("read-tree", "HEAD");
      for (const file of files) {
        writeJson(join(npmRoot, file), JSON.parse(git("show", `HEAD:${file}`)));
      }
      const previous = channel.cliVersion(npmRoot);
      if (previous === version) return `dev already pins ${version}; no PR needed.`;
      const branch = `automation/dev-cli-${version}-pin`;
      git("check-ref-format", "--branch", branch);
      console.log(`Checking PR history for ${branch}; main currently pins ${previous}.`);
      const prs = JSON.parse(
        gh(
          "pr",
          "list",
          "--repo",
          repository,
          "--base",
          "main",
          "--head",
          branch,
          "--state",
          "all",
          "--json",
          "url,state,isCrossRepository,headRepository",
        ),
      ).filter(
        (pr) => pr.isCrossRepository === false && pr.headRepository?.nameWithOwner === repository,
      );
      if (prs.length) {
        const open = prs.find((pr) => pr.state === "OPEN");
        if (!open) return `PR ${prs[0].url} is closed for CLI ${version}; not reopened.`;
        console.log(`Reusing open PR for CLI ${version}: ${open.url}.`);
        return open.url;
      }
      channel.pinTo(npmRoot, version, npmEnv);
      const manifest = readJson(join(npmDirectory, "package.json"));
      const lockfile = readJson(join(npmDirectory, "package-lock.json"));
      if (
        channel.cliVersion(npmRoot) !== version ||
        manifest.dependencies["@superblocksteam/cli"] !== version ||
        lockfile.packages[""].dependencies["@superblocksteam/cli"] !== version
      ) {
        throw new Error(`Dev pin does not match the requested CLI ${version}.`);
      }
      for (const file of files) {
        const blob = git("hash-object", "-w", "--no-filters", join(npmRoot, file));
        git("update-index", "--add", "--cacheinfo", `100644,${blob},${file}`);
      }
      let commit;
      if (git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)) {
        console.log(`Validating ${branch} against freshly resolved dev pins.`);
        git("fetch", "--quiet", "origin", `refs/heads/${branch}`);
        const changes = git("diff", "--name-only", "origin/main", "FETCH_HEAD").split("\n");
        if (
          changes.some((file) => !files.includes(file)) ||
          files.some(
            (file) =>
              git("show", `FETCH_HEAD:${file}`) !==
              readFileSync(join(npmRoot, file), "utf8").trim(),
          )
        ) {
          commit = git(
            "commit-tree",
            git("write-tree"),
            "-p",
            git("rev-parse", "HEAD"),
            "-p",
            git("rev-parse", "FETCH_HEAD"),
            "-m",
            `chore(plugin): refresh dev CLI ${version}`,
          );
          git("push", "--quiet", "origin", `${commit}:refs/heads/${branch}`);
          console.log(`Refreshed ${branch} at ${commit} from latest main and registry pins.`);
        } else {
          commit = git("rev-parse", "FETCH_HEAD");
        }
      } else {
        git("commit", "--quiet", "-m", `chore(plugin): pin dev CLI ${version}`);
        git("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
        commit = git("rev-parse", "HEAD");
        console.log(`Pushed ${branch} at ${commit}.`);
      }
      const body = join(workspace, "pr.md");
      const account = gh("api", "user", "--jq", ".login");
      writeFileSync(
        body,
        `## What\n\nPin the dev plugin CLI from ${previous} to ${version}, resolved from \`@master\`. Merging regenerates the \`#master\` marketplace branch.\n\n## Validation\n\nThe generated dev package and lockfile both pin \`${version}\`, resolved with \`npm view @superblocksteam/cli@master version --prefer-online\`.\n\n**Artifact:** [generated pin commit](https://github.com/${repository}/commit/${commit}). MCP startup is checked by the Channels workflow; it was not run by this command.\n\nAgent-authored by dev pin automation (@${account}).\n`,
      );
      console.log(`Opening draft PR for CLI ${version} from ${branch} (${commit}).`);
      return gh(
        "pr",
        "create",
        "--repo",
        repository,
        "--base",
        "main",
        "--head",
        branch,
        "--draft",
        "--title",
        `chore(plugin): pin dev CLI ${version}`,
        "--body-file",
        body,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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
