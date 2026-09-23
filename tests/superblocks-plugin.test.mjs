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
  assert.equal("SUPERBLOCKS_SERVER_URL" in server.env, false);
  assert.equal(
    server.env.SUPERBLOCKS_CLI_PACKAGE,
    "@superblocksteam/cli@beta",
  );
  assert.equal("NPM_CONFIG_PACKAGE" in server.env, false);
  assert.equal("userConfig" in manifest, false);
  assert.match(setup, /Node\.js 24.*npm\s+10/is);
  assert.match(setup, /Is https:\/\/app\.superblocks\.com the correct\s+server\?/i);
  assert.match(setup, /yes[\s\S]*free.text option for another\s+server URL/i);
  assert.match(setup, /set_server[\s\S]*current Cowork task/i);
  assert.match(setup, /custom HTTPS server[\s\S]*confirmation form/i);
  assert.match(setup, /set_server.*sign-in status[\s\S]*whoami/i);
  assert.match(setup, /opens.*browser/i);
  assert.match(setup, /call.*Login.*before.*first account-dependent tool/i);
  assert.doesNotMatch(setup, /first account-dependent (tool )?call.*opens browser sign-in/i);
  assert.match(setup, /Saved Superblocks login changed[\s\S]*call.*Login[\s\S]*current\s+task/i);
  assert.doesNotMatch(setup, /Restart (your )?MCP host/i);
  assert.match(setup, /Customize MCP settings[\s\S]*set_server/);
  assert.match(
    setup,
    /SUPERBLOCKS_CLI_PACKAGE[\s\S]*exact version or tag[\s\S]*file:/,
  );
  assert.doesNotMatch(setup, /npx|`superblocks login`|config set domain/i);
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
  const launcher = fileURLToPath(
    repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
  );
  for (const name of ["@superblocksteam/cli", "@superblocksteam/cli-ephemeral"]) {
    const packageDirectory = join(directory, name.split("/").at(-1));
    await mkdir(packageDirectory);
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        bin: { superblocks: "superblocks.js" },
        name,
        version: "1.0.0",
      }),
    );
    const executable = join(packageDirectory, "superblocks.js");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stdout.write("configured package\\n");\n',
    );
    await chmod(executable, 0o755);

    const { stdout } = await execFile(process.execPath, [launcher], {
      cwd: directory,
      env: {
        ...process.env,
        [packageEnvName]: `${name}@${pathToFileURL(packageDirectory).href}`,
        NPM_CONFIG_CACHE: join(directory, `${name.split("/").at(-1)}-cache`),
        NPM_CONFIG_OFFLINE: "true",
        npm_config_package: "package-that-must-not-run",
      },
    });
    assert.equal(stdout, "configured package\n");
  }
});

test("launcher selects the package registry", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-registry-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const npx = join(directory, "npx");
  await writeFile(npx, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  await chmod(npx, 0o755);
  const launcher = fileURLToPath(
    repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
  );

  for (const [name, registry] of [
    ["cli", "https://registry.npmjs.org/"],
    ["cli-ephemeral", "https://npm.pkg.github.com/"],
  ]) {
    const { stdout } = await execFile(process.execPath, [launcher], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        SUPERBLOCKS_CLI_PACKAGE: `@superblocksteam/${name}@2.0.0`,
      },
    });
    assert.ok(JSON.parse(stdout).includes(`--@superblocksteam:registry=${registry}`));
  }
});

test(
  "MCP launch rejects invalid server settings before starting npx",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-env-"));
    t.after(() => rm(directory, { force: true, recursive: true }));
    const npx = join(directory, "npx");
    await writeFile(npx, '#!/usr/bin/env node\nconsole.log("npx started");\n');
    await chmod(npx, 0o755);
    const launcher = fileURLToPath(
      repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs"),
    );
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
    const npx = join(directory, "npx");
    await writeFile(npx, '#!/usr/bin/env node\nconsole.log("fallback started");\n');
    await chmod(npx, 0o755);
    const launcher = pathToFileURL(
      fileURLToPath(repoFile("plugins/superblocks-plugin/scripts/launch-mcp.mjs")),
    ).href;
    for (const execve of [
      "undefined",
      "() => { throw new Error('execve blocked') }",
    ]) {
      const { stdout } = await execFile(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `process.execve = ${execve}; await import(${JSON.stringify(launcher)})`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            SUPERBLOCKS_CLI_PACKAGE: "@superblocksteam/cli@beta",
          },
        },
      );
      assert.equal(stdout.trim(), "fallback started");
    }
  },
);
