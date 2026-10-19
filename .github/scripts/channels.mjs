import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PUBLIC_NPM = "https://registry.npmjs.org/";
const GITHUB_PACKAGES = "https://npm.pkg.github.com/";
const PLUGIN = "plugins/superblocks-plugin";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const MANIFEST = `${PLUGIN}/.claude-plugin/plugin.json`;
const PIN_FILES = ["package.json", "package-lock.json"];
const EXACT_CLI_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export class Channel {
  static #channels = [
    new Channel("beta", "beta", "main", "superblocks", PUBLIC_NPM),
    new Channel("next", "next", "next", "superblocks-next", PUBLIC_NPM),
    new Channel("dev", "master", "master", "superblocks-dev", GITHUB_PACKAGES),
  ];

  static all() {
    return [...Channel.#channels];
  }

  static current(root) {
    const marketplace = readJson(join(root, MARKETPLACE));
    const channel = Channel.#channels.find(
      (candidate) => candidate.marketplace === marketplace.name,
    );
    if (!channel) throw new Error(`Unknown marketplace: ${marketplace.name}`);
    return channel;
  }

  static isExactVersion(version) {
    return (
      typeof version === "string" && version.trim() === version && EXACT_CLI_VERSION.test(version)
    );
  }

  static named(name) {
    const channel = Channel.#channels.find((candidate) => candidate.name === name);
    if (!channel) {
      throw new Error(`Unknown channel "${name}"; expected beta, next, or dev.`);
    }
    return channel;
  }

  constructor(name, distTag, branch, marketplace, registry) {
    this.name = name;
    this.distTag = distTag;
    this.branch = branch;
    this.marketplace = marketplace;
    this.registry = registry;
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
    return this.isMain ? base : `${base.replace(/ \(next\)| \(dev\)/g, "")} (${this.name})`;
  }

  pinDirectory(root) {
    return join(root, PLUGIN);
  }

  cliVersion(root) {
    const directory = this.pinDirectory(root);
    const pin = readJson(join(directory, "package.json"));
    const lock = readJson(join(directory, "package-lock.json"));
    const version = lock.packages["node_modules/@superblocksteam/cli"].version;
    if (
      !Channel.isExactVersion(version) ||
      pin.dependencies["@superblocksteam/cli"] !== version ||
      lock.packages[""].dependencies["@superblocksteam/cli"] !== version
    ) {
      throw new Error("CLI pin does not match its lockfile.");
    }
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!entry.resolved) continue;
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      const registry = name.startsWith("@superblocksteam/") ? this.registry : PUBLIC_NPM;
      if (new URL(entry.resolved).origin !== new URL(registry).origin) {
        throw new Error(`Unexpected package registry for ${path}.`);
      }
    }
    return version;
  }

  validate(root) {
    if (Channel.current(root) !== this)
      throw new Error(`Checkout does not belong to ${this.name}.`);
    this.cliVersion(root);
    const manifest = readJson(join(root, MANIFEST));
    const marketplace = readJson(join(root, MARKETPLACE));
    if (
      marketplace.plugins.find((plugin) => plugin.name === manifest.name)?.version !==
      manifest.version
    ) {
      throw new Error("Marketplace and plugin versions do not match.");
    }
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

  latestVersion(env = process.env) {
    const workspace = mkdtempSync(join(tmpdir(), "superblocks-tag-"));
    try {
      return this.#resolveTag(workspace, this.#npmEnvironment(workspace, env));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  #resolveTag(directory, env) {
    const version = JSON.parse(
      execFileSync(
        "npm",
        [
          "view",
          `@superblocksteam/cli@${this.distTag}`,
          "version",
          "--json",
          "--prefer-online",
          ...this.npmArgs(),
        ],
        { cwd: directory, encoding: "utf8", env },
      ),
    );
    if (!Channel.isExactVersion(version))
      throw new Error(`Invalid CLI version: ${JSON.stringify(version)}`);
    return version;
  }

  pinTo(root, spec = this.distTag, env = process.env) {
    if (spec !== this.distTag && !Channel.isExactVersion(spec)) {
      throw new Error(`Invalid CLI version or tag: ${JSON.stringify(spec)}`);
    }
    if (Channel.current(root) !== this)
      throw new Error(`Checkout does not belong to ${this.name}.`);
    const workspace = mkdtempSync(join(tmpdir(), "superblocks-pin-"));
    try {
      const directory = this.pinDirectory(workspace);
      mkdirSync(directory, { recursive: true });
      for (const file of PIN_FILES)
        cpSync(join(this.pinDirectory(root), file), join(directory, file));
      const npmEnv = this.#npmEnvironment(workspace, env);
      const version = spec === this.distTag ? this.#resolveTag(directory, npmEnv) : spec;
      if (!Channel.isExactVersion(version))
        throw new Error(`Invalid CLI version: ${JSON.stringify(version)}`);
      if (
        readJson(join(this.pinDirectory(root), "package.json")).dependencies[
          "@superblocksteam/cli"
        ] === version
      ) {
        this.validate(root);
        return false;
      }
      execFileSync(
        "npm",
        [
          "install",
          `@superblocksteam/cli@${version}`,
          "--save-exact",
          "--package-lock-only",
          ...this.npmArgs(),
        ],
        { cwd: directory, stdio: "inherit", env: npmEnv },
      );
      if (this.cliVersion(workspace) !== version)
        throw new Error("CLI pin does not match the requested version.");
      const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      for (const file of PIN_FILES)
        cpSync(join(directory, file), join(this.pinDirectory(root), file));
      this.#version(root, sourceSha, version);
      return true;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  #npmEnvironment(workspace, env) {
    const result = { ...env };
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ])
      delete result[name];
    for (const [name, value] of Object.entries({
      proxy: "null",
      https_proxy: "null",
      strict_ssl: "true",
    })) {
      result[`npm_config_${name}`] = value;
      result[`NPM_CONFIG_${name.toUpperCase()}`] = value;
    }
    if (result.NODE_AUTH_TOKEN) {
      const npmrc = join(workspace, "npmrc");
      writeFileSync(npmrc, "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n", {
        mode: 0o600,
      });
      result.NPM_CONFIG_USERCONFIG = npmrc;
      result.npm_config_userconfig = npmrc;
    }
    return result;
  }

  #version(root, sourceSha, cliVersion) {
    const version = `0.0.0-${this.name}.g${sourceSha.slice(0, 12)}.cli-${cliVersion}`;
    const manifest = readJson(join(root, MANIFEST));
    const marketplace = readJson(join(root, MARKETPLACE));
    const displayName = this.displayName(manifest.displayName);
    writeJson(join(root, MANIFEST), { ...manifest, displayName, version });
    marketplace.plugins = marketplace.plugins.map((plugin) =>
      plugin.name === manifest.name ? { ...plugin, displayName, version } : plugin,
    );
    writeJson(join(root, MARKETPLACE), marketplace);
  }

  install(pluginDirectory) {
    const workspace = mkdtempSync(join(tmpdir(), "superblocks-install-"));
    try {
      execFileSync("npm", ["ci", ...this.npmArgs()], {
        cwd: pluginDirectory,
        stdio: "inherit",
        env: this.#npmEnvironment(workspace, process.env),
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}
