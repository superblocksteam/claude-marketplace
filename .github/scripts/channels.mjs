import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const PUBLIC_NPM = "https://registry.npmjs.org/";
const GITHUB_PACKAGES = "https://npm.pkg.github.com/";
export const PLUGIN = "plugins/superblocks-plugin";
export const MARKETPLACE = ".claude-plugin/marketplace.json";
export const MANIFEST = `${PLUGIN}/.claude-plugin/plugin.json`;
export const PIN_FILES = ["package.json", "package-lock.json"];
export const BOT = {
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};
const EXACT_CLI_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export class Channel {
  static #channels = [
    new Channel("beta", "beta", "main", "superblocks", PUBLIC_NPM),
    new Channel("next", "next", "next", "superblocks-next", PUBLIC_NPM, "main"),
    new Channel("dev", "master", "master", "superblocks-dev", GITHUB_PACKAGES, "next"),
  ];

  static all() {
    return [...Channel.#channels];
  }

  static isExactVersion(version) {
    return typeof version === "string" && EXACT_CLI_VERSION.test(version);
  }

  static named(name) {
    const channel = Channel.#channels.find((candidate) => candidate.name === name);
    if (!channel) throw new Error(`Unknown channel "${name}"; expected beta, next, or dev.`);
    return channel;
  }

  static current(root) {
    const name = readJson(join(root, MARKETPLACE)).name;
    const channel = Channel.#channels.find((candidate) => candidate.marketplace === name);
    if (!channel) throw new Error(`Unknown marketplace "${name}".`);
    return channel;
  }

  constructor(name, distTag, branch, marketplace, registry, parent) {
    Object.assign(this, { name, distTag, branch, marketplace, registry, parent });
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

  assertCurrent(root) {
    if (Channel.current(root) !== this) {
      throw new Error(`Check out ${this.branch} before using the ${this.name} channel.`);
    }
  }

  displayName(base) {
    const name = base.replace(/ \((?:next|dev)\)$/, "");
    return this.isMain ? name : `${name} (${this.name})`;
  }

  pinDirectory(root) {
    return join(root, PLUGIN);
  }

  cliVersion(root) {
    const directory = this.pinDirectory(root);
    const spec = readJson(join(directory, "package.json")).dependencies["@superblocksteam/cli"];
    const lock = readJson(join(directory, "package-lock.json"));
    if (
      !Channel.isExactVersion(spec) ||
      lock.packages[""].dependencies["@superblocksteam/cli"] !== spec ||
      lock.packages["node_modules/@superblocksteam/cli"].version !== spec
    ) {
      throw new Error("The plugin package and lockfile must pin the same exact CLI version.");
    }
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue;
      const name = path.split("node_modules/").at(-1);
      const expected =
        !this.isPublic && name.startsWith("@superblocksteam/") ? GITHUB_PACKAGES : PUBLIC_NPM;
      if (
        entry.link ||
        (entry.resolved && new URL(entry.resolved).origin !== new URL(expected).origin)
      ) {
        throw new Error(
          `Unexpected package registry for ${path}; expected ${new URL(expected).origin}, got ${entry.resolved ? new URL(entry.resolved).origin : "link"}.`,
        );
      }
    }
    return spec;
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

  withNpm(callback, environment = process.env) {
    const directory = mkdtempSync(join(tmpdir(), "superblocks-npm-"));
    const env = { ...environment };
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ])
      delete env[name];
    for (const [name, value] of Object.entries({
      proxy: "null",
      https_proxy: "null",
      strict_ssl: "true",
    })) {
      env[`npm_config_${name}`] = value;
      env[`NPM_CONFIG_${name.toUpperCase()}`] = value;
    }
    if (this.isPublic) delete env.NODE_AUTH_TOKEN;
    const npmrc = join(directory, "npmrc");
    writeFileSync(
      npmrc,
      this.isPublic ? "" : "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n",
      { mode: 0o600 },
    );
    env.NPM_CONFIG_USERCONFIG = npmrc;
    env.npm_config_userconfig = npmrc;
    try {
      return callback(directory, env);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  latestVersion(environment = process.env) {
    return this.withNpm((cwd, env) => {
      const output = execFileSync(
        "npm",
        [
          "view",
          `@superblocksteam/cli@${this.distTag}`,
          "version",
          "--json",
          "--prefer-online",
          ...this.npmArgs(),
        ],
        { cwd, env, encoding: "utf8" },
      );
      let version;
      try {
        version = JSON.parse(output);
      } catch (cause) {
        throw new Error(`npm view @superblocksteam/cli@${this.distTag} returned invalid JSON.`, {
          cause,
        });
      }
      if (!Channel.isExactVersion(version))
        throw new Error(`Invalid CLI version: ${JSON.stringify(version)}`);
      return version;
    }, environment);
  }

  pinTo(root, spec = this.distTag, environment = process.env) {
    this.assertCurrent(root);
    if (spec !== this.distTag && !Channel.isExactVersion(spec))
      throw new Error(`Invalid CLI version: ${JSON.stringify(spec)}`);
    this.withNpm((directory, env) => {
      const pin = this.pinDirectory(directory);
      mkdirSync(pin, { recursive: true });
      for (const file of PIN_FILES) cpSync(join(this.pinDirectory(root), file), join(pin, file));
      execFileSync(
        "npm",
        [
          "install",
          `@superblocksteam/cli@${spec}`,
          "--save-exact",
          "--package-lock-only",
          ...this.npmArgs(),
        ],
        { cwd: pin, env, stdio: "inherit" },
      );
      execFileSync("npm", ["update", "--package-lock-only", ...this.npmArgs()], {
        cwd: pin,
        env,
        stdio: "inherit",
      });
      const version = this.cliVersion(directory);
      if (Channel.isExactVersion(spec) && version !== spec)
        throw new Error(`CLI pin does not match the requested version ${spec}.`);
      for (const file of PIN_FILES) cpSync(join(pin, file), join(this.pinDirectory(root), file));
    }, environment);
  }

  install(pluginDirectory) {
    this.withNpm((_, env) => {
      execFileSync("npm", ["ci", ...this.npmArgs()], {
        cwd: pluginDirectory,
        env,
        stdio: "inherit",
      });
    });
  }

  brand(root, sourceSha) {
    if (this.isMain) return;
    const manifest = readJson(join(root, MANIFEST));
    const version = `0.0.0-${this.name}.g${sourceSha.slice(0, 12)}.cli-${this.cliVersion(root)}`;
    const displayName = this.displayName(manifest.displayName);
    writeJson(join(root, MANIFEST), { ...manifest, displayName, version });
    const marketplace = readJson(join(root, MARKETPLACE));
    marketplace.name = this.marketplace;
    marketplace.plugins = marketplace.plugins.map((plugin) =>
      plugin.name === manifest.name ? { ...plugin, displayName, version } : plugin,
    );
    writeJson(join(root, MARKETPLACE), marketplace);
  }

  verify(root, destination) {
    this.assertCurrent(root);
    this.cliVersion(root);
    this.withNpm((_, env) => {
      const run = (command, args, extra = {}) =>
        execFileSync(command, args, { cwd: root, env, stdio: "inherit", ...extra });
      run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${PUBLIC_NPM}`]);
      run("npm", ["test"]);
      const tree = join(destination, "marketplace");
      new ChannelMarketplace(this, root).write(tree);
      run("npm", ["ci", ...this.npmArgs()], { cwd: join(tree, PLUGIN) });
      run(process.execPath, ["--test", "tests/installed/dependency-security.test.mjs"], {
        env: { ...env, TEST_PLUGIN_DIRECTORY: join(tree, PLUGIN) },
      });
      run(process.execPath, [
        ".github/scripts/build-mcpb.mjs",
        join(tree, PLUGIN),
        destination,
        this.name,
      ]);
      const bundles = readdirSync(destination).filter((name) => name.endsWith(".mcpb"));
      if (bundles.length !== 1) throw new Error("Expected exactly one MCPB to smoke test.");
      run("python3", [".github/scripts/smoke-mcpb.py", join(destination, bundles[0])]);
    });
  }
}

export class ChannelMarketplace {
  constructor(channel, root) {
    Object.assign(this, { channel, root });
  }

  write(destination) {
    this.channel.assertCurrent(this.root);
    this.channel.cliVersion(this.root);
    mkdirSync(destination, { recursive: true });
    for (const entry of [".claude-plugin", "plugins", "README.md"]) {
      cpSync(join(this.root, entry), join(destination, entry), {
        recursive: true,
        filter: (source) => basename(source) !== "node_modules",
      });
    }
  }
}
