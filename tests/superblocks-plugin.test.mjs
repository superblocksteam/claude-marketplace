import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoFile = (path) => new URL(`../${path}`, import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(repoFile(path), "utf8"));

async function installedPlugin(directory, script) {
  const plugin = join(directory, "plugin with spaces");
  await cp(repoFile("plugins/superblocks-plugin"), plugin, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules",
  });
  const cli = join(plugin, "node_modules", "@superblocksteam", "cli", "bin");
  await mkdir(cli, { recursive: true });
  await writeFile(join(cli, "run.js"), script);
  return join(plugin, "scripts", "launch-mcp.mjs");
}

test("Superblocks starts browser login without terminal API-key setup", async () => {
  const [marketplace, manifest, mcp, setup] = await Promise.all([
    readJson(".claude-plugin/marketplace.json"),
    readJson("plugins/superblocks-plugin/.claude-plugin/plugin.json"),
    readJson("plugins/superblocks-plugin/.mcp.json"),
    readFile(repoFile("plugins/superblocks-plugin/skills/configure/SKILL.md"), "utf8"),
  ]);
  const server = mcp.mcpServers.superblocks;

  assert.equal(marketplace.plugins[0].version, manifest.version);
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/launch-mcp.mjs"]);
  for (const name of [
    "SUPERBLOCKS_CLI_PACKAGE",
    "SUPERBLOCKS_MCP_BROWSER_LOGIN",
    "SUPERBLOCKS_SERVER_URL",
    "NPM_CONFIG_PACKAGE",
  ]) {
    assert.equal(name in server.env, false, `.mcp.json must not set ${name}`);
  }
  assert.equal("userConfig" in manifest, false);
  assert.match(setup, /Node\.js 24.*npm\s+10/is);
  assert.match(setup, /Which Superblocks server should the\s+plugin use\?/i);
  assert.match(
    setup,
    /https:\/\/app\.superblocks\.com[\s\S]*free.text option for another\s+server URL/i,
  );
  assert.match(setup, /do not describe\s+`https:\/\/app\.superblocks\.com` as the current server/i);
  assert.doesNotMatch(setup, /Is https:\/\/app\.superblocks\.com the correct/i);
  assert.match(setup, /not a valid server origin[\s\S]*ignores it/i);
  assert.match(setup, /set_server[\s\S]*current Cowork task/i);
  assert.match(setup, /custom HTTPS or loopback server[\s\S]*confirmation form/i);
  assert.match(setup, /set_server.*sign-in status[\s\S]*whoami/i);
  assert.match(setup, /opens.*browser/i);
  assert.match(setup, /call.*Login.*before.*first account-dependent tool/i);
  assert.doesNotMatch(setup, /first account-dependent (tool )?call.*opens browser sign-in/i);
  assert.match(setup, /Saved Superblocks login changed[\s\S]*call.*Login[\s\S]*current\s+task/i);
  assert.doesNotMatch(setup, /Restart (your )?MCP host/i);
  assert.match(setup, /Customize MCP settings[\s\S]*set_server/);
  assert.match(setup, /installed CLI[\s\S]*lockfile/i);
  assert.match(
    setup,
    /set_server[\s\S]*saves[\s\S]*`serverUrl` in\s+`~\/\.superblocks\/plugin\.json`/,
  );
  assert.match(setup, /edit\s+`serverUrl`[\s\S]*new Cowork task/);
  assert.doesNotMatch(setup, /cannot switch\s+servers|with the browser login\s+outside the plugin/);
  assert.doesNotMatch(setup, /@master|cli-ephemeral|npm\.pkg\.github\.com/);
  assert.doesNotMatch(setup, /edit `SUPERBLOCKS_CLI_PACKAGE` in the plugin's/);
  assert.doesNotMatch(setup, /npx|`superblocks login`|config set domain/i);
});

test("default launch runs the installed CLI without npm or npx", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-installed-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const launcher = await installedPlugin(
    directory,
    "console.log(JSON.stringify({ args: process.argv.slice(2), browserLogin: process.env.SUPERBLOCKS_MCP_BROWSER_LOGIN }));\n",
  );
  for (const command of ["npm", "npx"]) {
    const executable = join(directory, command);
    await writeFile(
      executable,
      '#!/usr/bin/env node\nthrow new Error("package manager must not run");\n',
    );
    await chmod(executable, 0o755);
  }
  const env = { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` };
  delete env.SUPERBLOCKS_CLI_PACKAGE;
  delete env.SUPERBLOCKS_MCP_BROWSER_LOGIN;
  delete env.SUPERBLOCKS_SERVER_URL;
  const { stdout } = await execFile(process.execPath, [launcher], { cwd: tmpdir(), env });
  assert.deepEqual(JSON.parse(stdout), { args: ["mcp", "serve"], browserLogin: "true" });
  const manifest = await readJson("plugins/superblocks-plugin/package.json");
  assert.equal(manifest.dependencies["@superblocksteam/cli"], "beta");
});

test("marketplace dependency takes precedence over legacy package overrides", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-legacy-pin-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const launcher = await installedPlugin(
    directory,
    "console.log(JSON.stringify(process.argv.slice(2)));\n",
  );
  await mkdir(join(directory, ".superblocks"));
  await writeFile(
    join(directory, ".superblocks", "plugin.json"),
    JSON.stringify({
      cliPackage: "@superblocksteam/cli@master",
      serverUrl: "https://acme.superblocks.com",
    }),
  );
  const npx = join(directory, "npx");
  await writeFile(npx, '#!/usr/bin/env node\nthrow new Error("package manager must not run");\n');
  await chmod(npx, 0o755);
  const { stdout } = await execFile(process.execPath, [launcher], {
    env: {
      ...process.env,
      HOME: directory,
      PATH: `${directory}:${process.env.PATH}`,
      SUPERBLOCKS_CLI_PACKAGE: "@superblocksteam/cli@master",
    },
  });
  assert.deepEqual(JSON.parse(stdout), ["mcp", "serve"]);
});

test(
  "launcher becomes the installed CLI so signal delivery needs no supervisor",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-signal-"));
    const signalFile = join(directory, "signal");
    const launcher = await installedPlugin(
      directory,
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
    const child = spawn(process.execPath, [launcher], {
      env: {
        ...process.env,
        SUPERBLOCKS_CLI_PACKAGE: "",
        HOME: directory,
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
        throw new Error(`Launcher exited before the CLI started: code=${code} signal=${signal}`);
      }),
    ]);
    const cliPid = Number(output.toString().trim());
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit");

    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(await readFile(signalFile, "utf8"), "SIGTERM");
    assert.equal(cliPid, child.pid);
  },
);

test(
  "launcher normalizes SUPERBLOCKS_MCP_BROWSER_LOGIN like the CLI",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-login-"));
    t.after(() => rm(directory, { force: true, recursive: true }));
    const launcher = await installedPlugin(
      directory,
      "console.log(process.env.SUPERBLOCKS_MCP_BROWSER_LOGIN);\n",
    );
    const launch = (settings) =>
      execFile(process.execPath, [launcher], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          SUPERBLOCKS_CLI_PACKAGE: "@superblocksteam/cli@beta",
          ...settings,
        },
      });

    for (const [value, forwarded] of [
      ["1", "true"],
      [" YES ", "true"],
      ["0", "false"],
      ["No", "false"],
      ["", "true"],
    ]) {
      const { stdout } = await launch({ SUPERBLOCKS_MCP_BROWSER_LOGIN: value });
      assert.equal(
        stdout.trim(),
        forwarded,
        `${JSON.stringify(value)} should forward ${forwarded}`,
      );
    }
    await assert.rejects(
      launch({ SUPERBLOCKS_MCP_BROWSER_LOGIN: "maybe" }),
      /SUPERBLOCKS_MCP_BROWSER_LOGIN must be true or false/,
    );
    for (const value of ["0", "FALSE", "no"]) {
      await assert.rejects(
        launch({
          SUPERBLOCKS_MCP_BROWSER_LOGIN: value,
          SUPERBLOCKS_SERVER_URL: "https://app.superblocks.com",
        }),
        /Remove SUPERBLOCKS_SERVER_URL/,
      );
    }
  },
);

test(
  "MCP launch rejects invalid server settings before starting the CLI",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-env-"));
    t.after(() => rm(directory, { force: true, recursive: true }));
    const launcher = await installedPlugin(directory, 'console.log("CLI started");\n');
    for (const settings of [
      { SUPERBLOCKS_SERVER_URL: "https://app.superblocks.com/path" },
      {
        SUPERBLOCKS_MCP_BROWSER_LOGIN: "false",
        SUPERBLOCKS_SERVER_URL: "https://app.superblocks.com",
      },
    ]) {
      await assert.rejects(
        execFile(process.execPath, [launcher], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            SUPERBLOCKS_CLI_PACKAGE: "@superblocksteam/cli@beta",
            ...settings,
          },
        }),
        /SUPERBLOCKS_SERVER_URL/,
      );
    }
  },
);

test("MCP launch explains the Node.js 24 requirement", async () => {
  const launcher = pathToFileURL(
    fileURLToPath(repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs")),
  ).href;
  await assert.rejects(
    execFile(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `Object.defineProperty(process.versions, "node", { value: "18.0.0" }); process.execve = undefined; await import(${JSON.stringify(launcher)})`,
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

test(
  "MCP launch falls back when execve is unavailable or fails",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-fallback-"));
    t.after(() => rm(directory, { force: true, recursive: true }));
    const launcher = pathToFileURL(
      await installedPlugin(directory, 'console.log("fallback started");\n'),
    ).href;
    for (const platformSetup of [
      "process.execve = undefined",
      "process.execve = () => { throw new Error('execve blocked') }",
      "Object.defineProperty(process, 'platform', { value: 'win32' })",
    ]) {
      const { stdout } = await execFile(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `${platformSetup}; await import(${JSON.stringify(launcher)})`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            SUPERBLOCKS_CLI_PACKAGE: "",
            HOME: directory,
          },
        },
      );
      assert.equal(stdout.trim(), "fallback started");
    }
  },
);
