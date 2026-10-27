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
import { basename, join, posix } from "node:path";

import { LockedDependencies } from "./locked-dependencies.mjs";
import { PluginVersion } from "./plugin-version.mjs";

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
      this.#assertPackageSource(path, entry, lock);
    }
    return spec;
  }

  #assertPackageSource(path, entry, lock) {
    if (!path) return;
    const installedName = path.split("node_modules/").at(-1);
    const name = entry.name ?? installedName;
    if (
      name !== installedName &&
      (installedName.startsWith("@superblocksteam/") || !this.#hasAlias(lock, path, name))
    )
      throw new Error(
        `Unexpected package alias for ${path}: expected ${installedName}, found ${name}; no permitted matching alias declarations.`,
      );
    if (!entry.resolved) return;
    const registry = name.startsWith("@superblocksteam/") ? this.registry : PUBLIC_NPM;
    const url = new URL(entry.resolved);
    if (url.origin !== new URL(registry).origin || url.username || url.password)
      throw new Error(
        `Unexpected package registry for ${path}: expected ${new URL(registry).origin}, found ${url.origin}; URL userinfo ${url.username || url.password ? "present (forbidden)" : "absent"}.`,
      );
    const pathname = decodeURIComponent(url.pathname);
    const publicPath = `/${name}/-/${name.split("/").at(-1)}-${entry.version}.tgz`;
    const privatePrefix = `/download/${name}/${entry.version}/`;
    const matches =
      registry === PUBLIC_NPM
        ? pathname === publicPath
        : pathname.startsWith(privatePrefix) &&
          /^[0-9a-f]{40}$/.test(pathname.slice(privatePrefix.length));
    if (!matches || url.search || url.hash)
      throw new Error(
        `Unexpected package tarball for ${path}: expected ${registry === PUBLIC_NPM ? publicPath : `${privatePrefix}<40 lowercase hex characters>`}; found path match ${matches} (actual path redacted), query ${url.search ? "present (forbidden)" : "absent"}, fragment ${url.hash ? "present (forbidden)" : "absent"}.`,
      );
  }

  #hasAlias(lock, path, name) {
    const installedName = path.split("node_modules/").at(-1);
    const references = [];
    for (const [parent, entry] of Object.entries(lock.packages)) {
      const specs = [entry.dependencies, entry.optionalDependencies, entry.devDependencies]
        .map((dependencies) => dependencies?.[installedName])
        .filter((spec) => spec !== undefined);
      if (!specs.length || this.#dependencyPath(lock, parent, installedName) !== path) continue;
      if (new Set(specs).size !== 1) return false;
      references.push(specs[0]);
    }
    const prefix = `npm:${name}@`;
    return (
      references.length > 0 &&
      references.every(
        (spec) =>
          typeof spec === "string" && spec.startsWith(prefix) && spec.length > prefix.length,
      )
    );
  }

  #dependencyPath(lock, parent, name) {
    let directory = parent;
    while (true) {
      const path = posix.join(directory, "node_modules", name);
      if (Object.hasOwn(lock.packages, path)) return path;
      if (!directory || directory === ".") return undefined;
      directory = posix.dirname(directory);
      if (posix.basename(directory) === "node_modules") directory = posix.dirname(directory);
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
    if (this.isPublic || env.NODE_AUTH_TOKEN) {
      const npmrc = join(directory, "npmrc");
      writeFileSync(
        npmrc,
        this.isPublic ? "" : "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n",
        { mode: 0o600 },
      );
      env.NPM_CONFIG_USERCONFIG = npmrc;
      env.npm_config_userconfig = npmrc;
    }
    try {
      return callback(directory, env);
    } catch (error) {
      if (!this.isPublic)
        console.error(
          "Private package operation failed. For npm 401/403/404 errors, check GH_PACKAGES_READ_TOKEN (NODE_AUTH_TOKEN), token expiration, read:packages/SSO access, and package/version availability. Local runs can use npm login --registry=https://npm.pkg.github.com --auth-type=legacy.",
        );
      throw error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  pinTo(root, spec = this.distTag, reviewedLock) {
    this.assertCurrent(root);
    if (spec !== this.distTag && !Channel.isExactVersion(spec))
      throw new Error(`Invalid CLI version: ${JSON.stringify(spec)}`);
    this.withNpm((directory, env) => {
      const pin = this.pinDirectory(directory);
      mkdirSync(pin, { recursive: true });
      for (const file of PIN_FILES) cpSync(join(this.pinDirectory(root), file), join(pin, file));
      const original = new LockedDependencies(
        readJson(join(pin, "package-lock.json")),
        readJson(join(pin, "package.json")).overrides,
        reviewedLock,
      );
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
      const overrides = [...original.overrides.keys()];
      if (overrides.length)
        execFileSync("npm", ["update", ...overrides, "--package-lock-only", ...this.npmArgs()], {
          cwd: pin,
          env,
          stdio: "inherit",
        });
      const version = this.cliVersion(directory);
      if (Channel.isExactVersion(spec) && version !== spec)
        throw new Error(`CLI pin does not match the requested version ${spec}.`);
      if (reviewedLock) {
        const updatedLock = readJson(join(pin, "package-lock.json"));
        original.constrain(updatedLock, version);
        original.assertUpdate(updatedLock, version);
        writeJson(join(pin, "package-lock.json"), updatedLock);
      }
      this.#assertInstallable(pin, env, Boolean(reviewedLock));
      for (const file of PIN_FILES) cpSync(join(pin, file), join(this.pinDirectory(root), file));
    });
  }

  #assertInstallable(directory, env, constrained) {
    try {
      execFileSync("npm", ["ci", "--dry-run", ...this.npmArgs()], {
        cwd: directory,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (constrained && /\bEUSAGE\b/.test(error.stderr ?? ""))
        throw new Error(
          "Unreviewed dependency change required by this CLI pin. Update the lockfile in a reviewed PR.",
          { cause: error },
        );
      throw error;
    }
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

  assertVersion(root) {
    if (this.isMain) return;
    const version = new PluginVersion(root, this.name, this.cliVersion(root)).value();
    const entry = readJson(join(root, MARKETPLACE)).plugins.find(
      (plugin) => plugin.name === "superblocks",
    );
    if (readJson(join(root, MANIFEST)).version !== version || entry?.version !== version)
      throw new Error(
        `Plugin version is stale; run node .github/scripts/channel.mjs version ${this.name} and commit both manifests.`,
      );
  }

  brand(root) {
    if (this.isMain) return;
    const manifest = readJson(join(root, MANIFEST));
    const version = new PluginVersion(root, this.name, this.cliVersion(root)).value();
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
    this.assertVersion(root);
    Channel.named("beta").withNpm((_, env) => {
      const run = (command, args, extra = {}) =>
        execFileSync(command, args, { cwd: root, env, stdio: "inherit", ...extra });
      run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${PUBLIC_NPM}`]);
      run("npm", ["test"]);
      const tree = join(destination, "marketplace");
      new ChannelMarketplace(this, root).write(tree);
      this.install(join(tree, PLUGIN));
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
