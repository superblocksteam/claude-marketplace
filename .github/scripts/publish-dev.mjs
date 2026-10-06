import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const baseRef = process.argv[2] ?? "main";
git("check-ref-format", "--branch", baseRef);
if (git("status", "--porcelain")) throw new Error("Publishing dev requires a clean checkout.");
git("fetch", "origin", baseRef);
const mainSha = git("rev-parse", "FETCH_HEAD");
const previousTip = git("ls-remote", "origin", "refs/heads/master").split(/\s/)[0];
git("switch", "--detach", mainSha);

const root = "plugins/superblocks-plugin";
const packagePath = `${root}/package.json`;
const manifestPath = `${root}/.claude-plugin/plugin.json`;
const marketplacePath = ".claude-plugin/marketplace.json";
const packageJson = readJson(packagePath);
packageJson.dependencies["@superblocksteam/cli"] = "master";
writeJson(packagePath, packageJson);
rmSync(`${root}/package-lock.json`);
execFileSync(
  "npm",
  [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefer-online",
    "--registry=https://registry.npmjs.org/",
    "--@superblocksteam:registry=https://npm.pkg.github.com/",
  ],
  { cwd: root, stdio: "inherit" },
);
const cliVersion = readJson(`${root}/package-lock.json`).packages[
  "node_modules/@superblocksteam/cli"
].version;
const manifest = readJson(manifestPath);
manifest.version = `0.0.0-dev.g${mainSha.slice(0, 12)}.cli-${cliVersion}`;
writeJson(manifestPath, manifest);
const marketplace = readJson(marketplacePath);
marketplace.name = "superblocks-dev";
marketplace.plugins.find((plugin) => plugin.name === "superblocks").version = manifest.version;
writeJson(marketplacePath, marketplace);

git("add", packagePath, `${root}/package-lock.json`, manifestPath, marketplacePath);
git(
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
  "commit",
  "-m",
  `chore(plugin): generate dev marketplace with CLI ${cliVersion}`,
);
git(
  "push",
  `--force-with-lease=refs/heads/master:${previousTip}`,
  "origin",
  "HEAD:refs/heads/master",
);
console.log(`Published superblocks-dev from ${baseRef} ${mainSha} with CLI ${cliVersion}.`);
