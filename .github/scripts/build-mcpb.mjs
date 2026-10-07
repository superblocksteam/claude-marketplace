import { execFileSync } from "node:child_process";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { packExtension } from "@anthropic-ai/mcpb/cli";

function copyRuntimeDependencies(dependencies, destination) {
  const cli = join(dependencies, "@superblocksteam/cli");
  const pending = [cli];
  const copied = new Set();
  while (pending.length) {
    const source = realpathSync(pending.pop());
    if (copied.has(source)) continue;
    if (!source.startsWith(`${dependencies}${sep}`)) {
      throw new Error("Dependency symlink escapes node_modules.");
    }
    const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const documentationOnly = source === join(dependencies, "@superblocksteam/sdk-api");
    cpSync(source, join(destination, relative(dependencies, source)), {
      recursive: true,
      dereference: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => {
        const resolved = realpathSync(path);
        if (!resolved.startsWith(`${dependencies}${sep}`)) {
          throw new Error("Dependency symlink escapes node_modules.");
        }
        if (relative(source, path).split(sep)[0] === "node_modules") return false;
        return !documentationOnly || statSync(path).isDirectory() || /\.(json|md|txt)$/.test(path);
      },
    });
    copied.add(source);
    if (documentationOnly) continue;
    const required = { ...metadata.dependencies };
    if (source === cli) {
      delete required["@superblocksteam/sdk"];
      for (const name of metadata.oclif?.plugins ?? []) required[name] = "*";
    }
    for (const name of new Set([
      ...Object.keys(required),
      ...Object.keys(metadata.optionalDependencies ?? {}),
    ])) {
      let parent = source;
      let dependency;
      while (parent.startsWith(dependencies) || parent === dirname(dependencies)) {
        const candidate = join(parent, "node_modules", name);
        if (existsSync(join(candidate, "package.json"))) {
          dependency = candidate;
          break;
        }
        parent = dirname(parent);
      }
      if (dependency) pending.push(dependency);
      else if (name in required) throw new Error(`Missing runtime dependency: ${name}`);
    }
  }
}

if (process.argv.length !== 4) {
  throw new Error("Usage: node build-mcpb.mjs <installed-plugin-directory> <output-directory>");
}
const plugin = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const cliRoot = join(plugin, "node_modules/@superblocksteam/cli");
if (!existsSync(join(cliRoot, "bin/run.js"))) {
  throw new Error("Install the plugin's CLI dependency before building its MCPB.");
}
const cli = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
if (typeof cli.version !== "string" || !/^[0-9][0-9A-Za-z.+-]*$/.test(cli.version)) {
  throw new Error("CLI version contains unsafe filename characters.");
}
const pluginManifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
const stem = `superblocks-${cli.version}-${process.platform}-${process.arch}`;
const bundlePath = join(output, `${stem}.mcpb`);
const zipPath = join(output, `${stem}.zip`);
if (existsSync(bundlePath) || existsSync(zipPath))
  throw new Error("Release artifacts already exist.");
const directory = mkdtempSync(join(tmpdir(), "superblocks-mcpb-build-"));
const bundle = join(directory, "bundle");
const cowork = join(directory, "cowork");
mkdirSync(output, { recursive: true });
mkdirSync(join(bundle, "scripts"), { recursive: true });
try {
  cpSync(join(plugin, "scripts/launch-mcp.mjs"), join(bundle, "scripts/launch-mcp.mjs"));
  const dependencies = realpathSync(join(plugin, "node_modules"));
  copyRuntimeDependencies(dependencies, join(bundle, "node_modules"));
  const manifest = {
    manifest_version: "0.3",
    name: pluginManifest.name,
    display_name: pluginManifest.displayName,
    version: cli.version,
    description: "Build, import, and manage Superblocks applications with browser sign-in.",
    author: pluginManifest.author,
    homepage: pluginManifest.homepage,
    tools_generated: true,
    compatibility: { platforms: [process.platform], runtimes: { node: ">=24" } },
    server: {
      type: "node",
      entry_point: "scripts/launch-mcp.mjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/scripts/launch-mcp.mjs"],
        env: { NODE_DEBUG: "gateway" },
      },
    },
  };
  writeFileSync(join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!(await packExtension({ extensionPath: bundle, outputPath: bundlePath, silent: false }))) {
    throw new Error("MCPB packing failed; see the packer output above.");
  }
  mkdirSync(join(cowork, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(cowork, ".claude-plugin/plugin.json"),
    `${JSON.stringify({ ...pluginManifest, version: cli.version, description: manifest.description, mcpServers: "./superblocks.mcpb" }, null, 2)}\n`,
  );
  cpSync(join(plugin, "skills"), join(cowork, "skills"), { recursive: true });
  cpSync(bundlePath, join(cowork, "superblocks.mcpb"), { mode: constants.COPYFILE_FICLONE });
  execFileSync(
    "python3",
    [
      "-c",
      `import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(root / 'superblocks.mcpb') as bundle:
    if len(bundle.infolist()) > 5000:
        raise SystemExit('MCPB bundle exceeds 5000 entry budget')
    if sum(entry.file_size for entry in bundle.infolist()) > 200_000_000:
        raise SystemExit('MCPB bundle exceeds 200 MB size budget')
files = []
for path in sorted(root.rglob('*')):
    if path.is_symlink():
        raise SystemExit('Cowork archive cannot contain symlinks')
    if path.is_file():
        files.append(path)
if sum(path.stat().st_size for path in files) > 200_000_000 or len(files) > 5000:
    raise SystemExit('Cowork plugin exceeds upload limits')
with zipfile.ZipFile(sys.argv[2], 'x', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, path.relative_to(root))
`,
      cowork,
      zipPath,
    ],
    { stdio: "inherit" },
  );
  console.log(bundlePath);
  console.log(zipPath);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
