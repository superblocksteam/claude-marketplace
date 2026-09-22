import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoFile = (path) => new URL(`../${path}`, import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(repoFile(path), "utf8"));

test("Superblocks starts browser login without terminal API-key setup", async () => {
  const [marketplace, manifest, mcp, setup] = await Promise.all([
    readJson(".claude-plugin/marketplace.json"),
    readJson("plugins/superblocks-plugin/.claude-plugin/plugin.json"),
    readJson("plugins/superblocks-plugin/.mcp.json"),
    readFile(
      repoFile("plugins/superblocks-plugin/skills/configure/SKILL.md"),
      "utf8",
    ),
  ]);
  const server = mcp.mcpServers.superblocks;

  assert.equal(marketplace.plugins[0].version, manifest.version);
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, [
    "${CLAUDE_PLUGIN_ROOT}/scripts/launch-mcp.mjs",
  ]);
  assert.equal(server.env.SUPERBLOCKS_MCP_BROWSER_LOGIN, "true");
  assert.equal(
    server.env.SUPERBLOCKS_SERVER_URL,
    "https://app.superblocks.com",
  );
  assert.equal(
    server.env.SUPERBLOCKS_CLI_PACKAGE,
    "@superblocksteam/cli@beta",
  );
  assert.equal("NPM_CONFIG_PACKAGE" in server.env, false);
  assert.equal("userConfig" in manifest, false);
  assert.match(setup, /Node\.js 24.*npm\s+10/is);
  assert.match(setup, /https:\/\/app\.superblocks\.com/);
  assert.match(setup, /opens.*browser/i);
  assert.match(
    setup,
    /Customize MCP settings[\s\S]*SUPERBLOCKS_SERVER_URL[\s\S]*SUPERBLOCKS_MCP_BROWSER_LOGIN/,
  );
  assert.match(
    setup,
    /SUPERBLOCKS_CLI_PACKAGE[\s\S]*exact version or tag[\s\S]*file:/,
  );
  assert.match(setup, /SUPERBLOCKS_MCP_BROWSER_LOGIN[\s\S]*"false"/);
  assert.match(
    setup,
    /"false"[\s\S]*remove\s+`SUPERBLOCKS_SERVER_URL`[\s\S]*existing CLI session/,
  );
  assert.doesNotMatch(setup, /API key|superblocks login|config set domain/i);
});

test(
  "launcher becomes npx so signal delivery needs no supervisor",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-signal-"));
    const signalFile = join(directory, "signal");
    const npx = join(directory, "npx");
    await writeFile(
      npx,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  writeFileSync(process.env.TEST_SIGNAL_FILE, "SIGTERM");
  process.exit(0);
});
console.log(process.pid);
setInterval(() => {}, 1_000);
`,
    );
    await chmod(npx, 0o755);

    const launcher = fileURLToPath(
      repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
    );
    const child = spawn(process.execPath, [launcher], {
      env: {
        ...process.env,
        SUPERBLOCKS_CLI_PACKAGE: "@superblocksteam/cli@beta",
        PATH: `${directory}:${process.env.PATH}`,
        TEST_SIGNAL_FILE: signalFile,
      },
    });
    t.after(async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(directory, { force: true, recursive: true });
    });

    const [output] = await Promise.race([
      once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) }),
      once(child, "exit").then(([code, signal]) => {
        throw new Error(
          `Launcher exited before npx started: code=${code} signal=${signal}`,
        );
      }),
    ]);
    const npxPid = Number(output.toString().trim());
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");

    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(await readFile(signalFile, "utf8"), "SIGTERM");
    assert.equal(npxPid, child.pid);
  },
);

test("npx installs selected SUPERBLOCKS_CLI_PACKAGE", async (t) => {
  const mcp = await readJson("plugins/superblocks-plugin/.mcp.json");
  const server = mcp.mcpServers.superblocks;
  const packageEnvName = "SUPERBLOCKS_CLI_PACKAGE";

  const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-npx-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const packageDirectory = join(directory, "package");
  await mkdir(packageDirectory);
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      bin: { superblocks: "superblocks.js" },
      name: "@superblocksteam/cli",
      version: "1.0.0",
    }),
  );
  const executable = join(packageDirectory, "superblocks.js");
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdout.write("configured package\\n");\n',
  );
  await chmod(executable, 0o755);

  const launcher = fileURLToPath(
    repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
  );
  const { stdout } = await execFile(
    process.execPath,
    [launcher],
    {
      cwd: directory,
      env: {
        ...process.env,
        [packageEnvName]: `@superblocksteam/cli@${pathToFileURL(packageDirectory).href}`,
        NPM_CONFIG_CACHE: join(directory, "cache"),
        NPM_CONFIG_OFFLINE: "true",
        npm_config_package: "package-that-must-not-run",
      },
    },
  );
  assert.equal(stdout, "configured package\n");
});

test("MCP launch fails closed without a valid package", async () => {
  const launcher = fileURLToPath(
    repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
  );
  await assert.rejects(
    execFile(process.execPath, [launcher], {
      env: { ...process.env, SUPERBLOCKS_CLI_PACKAGE: "" },
    }),
    /SUPERBLOCKS_CLI_PACKAGE must select the Superblocks CLI package/,
  );
  await assert.rejects(
    execFile(process.execPath, [launcher], {
      env: {
        ...process.env,
        NPM_CONFIG_OFFLINE: "true",
        SUPERBLOCKS_CLI_PACKAGE: "superblocks",
      },
    }),
    /SUPERBLOCKS_CLI_PACKAGE must select @superblocksteam\/cli/,
  );
  await assert.rejects(
    execFile(process.execPath, [launcher], {
      env: {
        ...process.env,
        SUPERBLOCKS_CLI_PACKAGE: "@superblocksteam/cli@^2.0.0",
      },
    }),
    /SUPERBLOCKS_CLI_PACKAGE must use an exact version, tag, or file URL/,
  );
});

test("MCP launch explains the Node.js 24 requirement", async () => {
  const launcher = pathToFileURL(
    fileURLToPath(
      repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
    ),
  ).href;
  await assert.rejects(
    execFile(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `process.execve = undefined; await import(${JSON.stringify(launcher)})`,
      ],
      {
        env: {
          ...process.env,
          SUPERBLOCKS_CLI_PACKAGE: "@superblocksteam/cli@beta",
        },
      },
    ),
    /Node\.js 24 or newer is required/,
  );
});
