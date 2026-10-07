import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the Cowork archive starts its bundled MCP dependency without a package manager", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "superblocks-mcpb-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const plugin = join(directory, "installed plugin");
  cpSync(new URL("../plugins/superblocks-plugin", import.meta.url), plugin, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules",
  });
  const cli = join(plugin, "node_modules/@superblocksteam/cli");
  mkdirSync(join(cli, "bin"), { recursive: true });
  const cliPackage = {
    version: "1.2.3",
    dependencies: { "runtime-dep": "1.0.0", "@superblocksteam/sdk-api": "1.0.0" },
  };
  writeFileSync(join(cli, "package.json"), JSON.stringify(cliPackage));
  writeFileSync(
    join(cli, "bin/run.js"),
    `const record = { args: process.argv.slice(2), browserLogin: process.env.SUPERBLOCKS_MCP_BROWSER_LOGIN, dependency: require("runtime-dep"), sdkVersion: require("@superblocksteam/sdk-api/package.json").version };
let requests = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  requests++;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "superblocks", version: "1.2.3" } }
    : { tools: [{ name: "login", inputSchema: { type: "object" } }] };
  const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n";
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "ready" } }) + "\\n";
  process.stdout.write(message.method === "tools/list" ? notification + response : response);
}).on("close", () => {
  if (!requests) console.log(JSON.stringify(record));
  process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
  const dependency = join(plugin, "node_modules/runtime-dep");
  mkdirSync(dependency);
  writeFileSync(
    join(dependency, "package.json"),
    JSON.stringify({ name: "runtime-dep", version: "1.0.0" }),
  );
  writeFileSync(join(dependency, "index.js"), 'module.exports = "bundled";\n');
  writeFileSync(join(dependency, ".npmrc"), "//registry.npmjs.org/:_authToken=must-not-ship\n");
  const sdk = join(plugin, "node_modules/@superblocksteam/sdk-api");
  mkdirSync(join(sdk, "src/integrations/example"), { recursive: true });
  writeFileSync(
    join(sdk, "package.json"),
    JSON.stringify({ name: "@superblocksteam/sdk-api", version: "1.0.0" }),
  );
  writeFileSync(join(sdk, "README.md"), "# API SDK\n");
  writeFileSync(join(sdk, "src/integrations/example/README.md"), "# Example integration\n");
  const unused = join(plugin, "node_modules/unused-package");
  mkdirSync(unused);
  for (let index = 0; index < 5001; index++) {
    writeFileSync(join(unused, `${index}.js`), "");
  }
  const output = join(directory, "artifacts");
  const script = fileURLToPath(new URL("../.github/scripts/build-mcpb.mjs", import.meta.url));
  const build = spawnSync(process.execPath, [script, plugin, output], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);

  const extracted = join(directory, "extracted");
  const archive = join(output, `superblocks-1.2.3-${process.platform}-${process.arch}.zip`);
  const { files, bundleFiles } = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import json,pathlib,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); b=zipfile.ZipFile(pathlib.Path(sys.argv[2])/'superblocks.mcpb'); b.extractall(pathlib.Path(sys.argv[2])/'runtime'); print(json.dumps({'files':z.namelist(),'bundleFiles':b.namelist()}))",
        archive,
        extracted,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.ok(files.includes(".claude-plugin/plugin.json"));
  assert.ok(files.includes("skills/configure/SKILL.md"));
  assert.ok(!files.includes(".mcp.json"));
  assert.ok(!bundleFiles.some((file) => file.endsWith(".npmrc")));
  assert.ok(bundleFiles.length <= 5000, `MCPB has ${bundleFiles.length} entries`);
  assert.ok(!bundleFiles.some((file) => file.includes("unused-package")));
  assert.ok(
    bundleFiles.includes(
      "node_modules/@superblocksteam/sdk-api/src/integrations/example/README.md",
    ),
  );
  const configure = readFileSync(join(extracted, "skills/configure/SKILL.md"), "utf8");
  assert.match(configure, /MCP bundle/);
  assert.doesNotMatch(configure, /different marketplace\s+branch/i);
  assert.doesNotMatch(configure, /npm\s+\d/);
  const manifest = JSON.parse(readFileSync(join(extracted, ".claude-plugin/plugin.json")));
  assert.equal(manifest.mcpServers, "./superblocks.mcpb");
  assert.equal(manifest.version, "1.2.3");
  const runtime = join(extracted, "runtime");
  const bundle = JSON.parse(readFileSync(join(runtime, "manifest.json")));
  assert.equal(bundle.compatibility.runtimes.node, ">=24");
  assert.deepEqual(bundle.compatibility.platforms, [process.platform]);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  for (const name of ["npm", "npx"]) {
    writeFileSync(
      join(bin, name),
      '#!/usr/bin/env node\nthrow new Error("startup must not install");\n',
    );
    chmodSync(join(bin, name), 0o755);
  }
  const home = join(directory, "empty home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.SUPERBLOCKS_MCP_BROWSER_LOGIN;
  delete env.SUPERBLOCKS_SERVER_URL;
  const args = bundle.server.mcp_config.args.map((arg) => arg.replaceAll("${__dirname}", runtime));
  const stdout = execFileSync(process.execPath, args, { encoding: "utf8", cwd: home, env });
  assert.deepEqual(JSON.parse(stdout), {
    args: ["mcp", "serve"],
    browserLogin: "true",
    dependency: "bundled",
    sdkVersion: "1.0.0",
  });

  const smokeScript = fileURLToPath(new URL("../.github/scripts/smoke-mcpb.py", import.meta.url));
  const bundlePath = join(output, `superblocks-1.2.3-${process.platform}-${process.arch}.mcpb`);
  const smoke = spawnSync("python3", [smokeScript, bundlePath], { encoding: "utf8" });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.equal(JSON.parse(smoke.stdout).loginAvailable, true);
  assert.equal(JSON.parse(smoke.stdout).toolCount, 1);
  console.log(`MCPB smoke accepted: ${smoke.stdout.trim()}`);

  const entryPoint = join(runtime, "node_modules/@superblocksteam/cli/bin/run.js");
  writeFileSync(
    entryPoint,
    readFileSync(entryPoint, "utf8").replace('name: "login"', 'name: "unavailable"'),
  );
  const brokenBundle = join(directory, "broken.mcpb");
  execFileSync(
    "npx",
    [
      "--yes",
      "--registry=https://registry.npmjs.org/",
      "@anthropic-ai/mcpb@2.1.2",
      "pack",
      runtime,
      brokenBundle,
    ],
    { stdio: "ignore" },
  );
  const brokenSmoke = spawnSync("python3", [smokeScript, brokenBundle], { encoding: "utf8" });
  assert.notEqual(brokenSmoke.status, 0);
  assert.match(brokenSmoke.stderr, /Login tool is missing/);
  console.log(`MCPB smoke rejected: ${brokenSmoke.stderr.trim().split("\n").at(-1)}`);

  rmSync(join(runtime, "node_modules/@superblocksteam/cli/bin/run.js"));
  const missing = spawnSync(process.execPath, args, { encoding: "utf8", cwd: home, env });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MODULE_NOT_FOUND/);

  writeFileSync(join(cli, "package.json"), JSON.stringify({ version: "../../escape" }));
  const invalid = spawnSync(process.execPath, [script, plugin, join(directory, "invalid")], {
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /CLI version contains unsafe filename characters/);

  writeFileSync(join(cli, "package.json"), JSON.stringify(cliPackage));
  const outside = join(directory, "unrelated-private-file");
  writeFileSync(outside, "must-not-ship");
  symlinkSync(outside, join(dependency, "outside-link"));
  const linked = spawnSync(process.execPath, [script, plugin, join(directory, "linked")], {
    encoding: "utf8",
  });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /Dependency symlink escapes node_modules/);

  rmSync(join(dependency, "outside-link"));
  symlinkSync(outside, join(plugin, "skills/configure/outside-link.md"));
  const linkedSkill = spawnSync(
    process.execPath,
    [script, plugin, join(directory, "linked-skill")],
    {
      encoding: "utf8",
    },
  );
  assert.notEqual(linkedSkill.status, 0);
  assert.match(linkedSkill.stderr, /Cowork archive cannot contain symlinks/);
});
