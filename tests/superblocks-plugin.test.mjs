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

test("the directory listing includes a README in the installed plugin folder", async () => {
  const readme = await readFile(repoFile("plugins/superblocks-plugin/README.md"), "utf8");
  const prose = readme.replace(/```[^]*?```/g, "").trim();
  assert.ok(prose.split(/\s+/).length >= 40, "The directory requires at least 40 prose words");
});

test("the directory listing uses a square PNG icon from the installed plugin folder", async () => {
  const icon = await readFile(repoFile("plugins/superblocks-plugin/.claude-plugin/icon.png"));
  assert.ok(
    icon.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    "Icon must be a PNG",
  );
  assert.equal(icon.toString("ascii", 12, 16), "IHDR");
  const [width, height] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
  assert.equal(width, height, "The directory requires a square icon");
  assert.ok(width >= 512 && width <= 2048, `The directory requires 512 to 2048 px, got ${width}`);
  assert.ok(icon.length < 2 * 1024 * 1024, "The directory requires an icon under 2 MB");
});

test("the installed plugin includes the Superblocks Community License Agreement", async () => {
  const license = await readFile(repoFile("plugins/superblocks-plugin/LICENSE"), "utf8");
  assert.match(license, /^Superblocks Community License Agreement\n/);
});

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
  assert.match(setup, /Node\.js 24 or newer/i);
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
  const { stdout, stderr } = await execFile(process.execPath, [launcher], { cwd: tmpdir(), env });
  assert.deepEqual(JSON.parse(stdout), { args: ["mcp", "serve"], browserLogin: "true" });
  assert.doesNotMatch(stderr, /Ignoring/);
});

test("marketplace dependency takes precedence over legacy package overrides", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-legacy-pin-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const launcher = await installedPlugin(
    directory,
    "console.log(JSON.stringify(process.argv.slice(2)));\n",
  );
  const npx = join(directory, "npx");
  await writeFile(npx, '#!/usr/bin/env node\nthrow new Error("package manager must not run");\n');
  await chmod(npx, 0o755);
  const launch = (settings) =>
    execFile(process.execPath, [launcher], {
      env: {
        ...process.env,
        HOME: directory,
        PATH: `${directory}:${process.env.PATH}`,
        ...settings,
      },
    });
  const legacyWarning = /Ignoring SUPERBLOCKS_CLI_PACKAGE and cliPackage[\s\S]*installed CLI/;

  const fromEnvironment = await launch({ SUPERBLOCKS_CLI_PACKAGE: "@superblocksteam/cli@master" });
  assert.deepEqual(JSON.parse(fromEnvironment.stdout), ["mcp", "serve"]);
  assert.match(fromEnvironment.stderr, legacyWarning);

  await mkdir(join(directory, ".superblocks"));
  await writeFile(
    join(directory, ".superblocks", "plugin.json"),
    JSON.stringify({
      cliPackage: "@superblocksteam/cli@master",
      serverUrl: "https://acme.superblocks.com",
    }),
  );
  const fromSettings = await launch({ SUPERBLOCKS_CLI_PACKAGE: "" });
  assert.deepEqual(JSON.parse(fromSettings.stdout), ["mcp", "serve"]);
  assert.match(fromSettings.stderr, legacyWarning);

  await writeFile(join(directory, ".superblocks", "plugin.json"), "not json");
  const unreadableSettings = await launch({ SUPERBLOCKS_CLI_PACKAGE: "" });
  assert.deepEqual(JSON.parse(unreadableSettings.stdout), ["mcp", "serve"]);
  assert.doesNotMatch(unreadableSettings.stderr, legacyWarning);
});

test("MCP launch explains a missing CLI install instead of a module error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superblocks-plugin-missing-cli-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const launcher = await installedPlugin(directory, 'console.log("CLI started");\n');
  await rm(join(directory, "plugin with spaces", "node_modules"), { recursive: true });
  const launch = execFile(process.execPath, [launcher], {
    env: { ...process.env, HOME: directory, SUPERBLOCKS_CLI_PACKAGE: "" },
  });
  await assert.rejects(launch, (error) => {
    assert.match(
      error.stderr,
      /Superblocks CLI is not installed[\s\S]*Reinstall the Superblocks plugin/,
    );
    assert.doesNotMatch(error.stderr, /MODULE_NOT_FOUND/);
    return true;
  });
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
console.log(String(process.pid));
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

const APP_ID = "00000000-0000-4000-8000-000000000001";
const EDIT_URL = `https://app.superblocks.com/code-mode/applications/edit/${APP_ID}`;
const COWORK_TOOL = "mcp__remote-devices__plugin_superblocks_superblocks__";
const CLAUDE_CODE_TOOL = "mcp__plugin_superblocks_superblocks__";

// A start_app result logged from a Cowork session, with its ids replaced.
const START_APP_RESULT = {
  applicationId: APP_ID,
  editUrl: EDIT_URL,
  mode: "BUILD",
  name: "Build a small app for tracking team lunch orders.",
  status: "building",
  browser: {
    captureMode: "gateway_chromium",
    canvas: { editUrl: EDIT_URL, openWhileBuilding: "claude_cowork_side_panel_only" },
    driver: {
      mustNotCloseUntil:
        "the Superblocks task is done (status ready, or the user no longer needs the browser session)",
    },
    hostBrowserTools: "cowork_embedded",
    uiOrigin: { navigate: "https://app.superblocks.com" },
  },
  agentInstructions:
    "Call `check_app_progress` with this `applicationId` to follow the turn. Relay each new activity line to the user as it arrives.",
};

// The fields follow a hook input recorded in Claude Code. In both hosts the tool
// result is the gateway's pretty-printed JSON inside a text content block.
async function runGuidance(event, tool, value = {}) {
  const input = {
    session_id: "00000000-0000-4000-8000-000000000000",
    hook_event_name: event,
    ...(tool && {
      tool_name: tool,
      tool_input: { applicationId: APP_ID },
      tool_response: [
        { type: "text", text: `${JSON.stringify({ kind: "ok", value }, null, 2)}\n` },
      ],
    }),
  };
  const child = spawn("sh", [
    fileURLToPath(repoFile("plugins/superblocks-plugin/hooks/guidance.sh")),
  ]);
  child.stdin.end(JSON.stringify(input));
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  if (!stdout) return undefined;
  const { hookSpecificOutput } = JSON.parse(stdout);
  assert.equal(hookSpecificOutput.hookEventName, event);
  return hookSpecificOutput.additionalContext;
}

test("plugin hooks run the guidance script at session start and after Cowork Superblocks calls", async () => {
  const { hooks } = await readJson("plugins/superblocks-plugin/hooks/hooks.json");
  const command = 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/guidance.sh"';
  assert.deepEqual(hooks.SessionStart, [{ hooks: [{ type: "command", command }] }]);
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    const [{ matcher, hooks: entries }] = hooks[event];
    assert.deepEqual(entries, [{ type: "command", command }]);
    assert.match(`${COWORK_TOOL}get_app`, new RegExp(matcher));
    assert.match(
      "mcp__remote-devices__plugin_superblocks-local_superblocks__get_app",
      new RegExp(matcher),
    );
    assert.doesNotMatch(`${CLAUDE_CODE_TOOL}get_app`, new RegExp(matcher));
    assert.doesNotMatch(
      "mcp__remote-devices__plugin_other_notsuperblocks__get_app",
      new RegExp(matcher),
    );
  }
});

test("session start tells every Claude host how to send files and keep the build canvas", async () => {
  const context = await runGuidance("SessionStart");
  assert.match(context, /Do not create a Claude artifact or use the host's own file-upload UI/);
  assert.match(
    context,
    /scratchpad path \(for example \/tmp\/claude-\.\.\.\/scratchpad\)[\s\S]*files: \[\{ path, content \}\] instead of filePath/,
  );
  assert.match(context, /Do not ask the user to restart Claude/);
  assert.match(context, /Claude-in-Chrome is not a mid-turn canvas/);
  assert.doesNotMatch(context, /browser pane|Page browser/);
});

test("Claude Code gets no Cowork browser pane guidance from any Superblocks result", async () => {
  const results = [
    ["start_app", { status: "building", browser: { canvas: { editUrl: EDIT_URL } } }],
    [
      "check_app_progress",
      { status: "building", browserNavigation: { action: "open_editor", url: EDIT_URL } },
    ],
    ["get_app", { status: "ready", browserNavigation: { action: "open_editor", url: EDIT_URL } }],
    ["build_app", { status: "ready", previewUrl: EDIT_URL }],
    ["publish_app", { status: "publishing", publishDetailsUrl: EDIT_URL }],
    ["create_integration", { integration_id: "i", integration_url: EDIT_URL }],
    ["set_server", {}],
  ];
  for (const [name, value] of results) {
    for (const event of ["PostToolUse", "PostToolUseFailure"]) {
      assert.equal(await runGuidance(event, `${CLAUDE_CODE_TOOL}${name}`, value), undefined, name);
      assert.equal(await runGuidance(event, `mcp__superblocks__${name}`, value), undefined, name);
    }
  }
  assert.equal(
    await runGuidance("PostToolUse", "mcp__remote-devices__Claude_Browser__navigate"),
    undefined,
  );
});

test("Cowork loads its browser pane tools and may open the editor while the build starts", async () => {
  for (const name of ["start_app", "edit_app"]) {
    const context = await runGuidance("PostToolUse", `${COWORK_TOOL}${name}`, START_APP_RESULT);
    assert.match(
      context,
      /CRITICAL: load your browser pane tools now, before the first poll - call ToolSearch with query select:mcp__remote-devices__Claude_Browser__preview_start,mcp__remote-devices__Claude_Browser__navigate,mcp__remote-devices__Claude_Browser__tabs_context\./,
    );
    assert.match(
      context,
      /In Cowork's embedded Page browser, and only there, you may open this result's `browser\.canvas\.editUrl` now\./,
    );
    assert.match(context, /If that app is already open, do not reload it/);
  }
  const plugin = "mcp__remote-devices__plugin_superblocks-local_superblocks__start_app";
  assert.match(
    await runGuidance("PostToolUse", plugin, { status: "building" }),
    /browser\.canvas\.editUrl/,
  );
});

test("Cowork opens browserNavigation in its Page browser and checks the app loaded", async () => {
  const navigation = { action: "open_editor", url: EDIT_URL };
  const progress = await runGuidance("PostToolUse", `${COWORK_TOOL}check_app_progress`, {
    status: "building",
    browserNavigation: navigation,
  });
  assert.match(
    progress,
    /^CRITICAL DO NOT IGNORE: viewStatus is ready, before any other action, ensure the browserNavigation URL from this result is open in Cowork's embedded Page browser and verify the app loaded\./,
  );
  assert.match(progress, /Your automatic verification is a load check/);
  const app = await runGuidance("PostToolUseFailure", `${COWORK_TOOL}get_app`, {
    status: "ready",
    browserNavigation: navigation,
  });
  assert.match(
    app,
    /^Before any other action, ensure the browserNavigation URL[\s\S]*verify the app loaded/,
  );

  const decide = await runGuidance("PostToolUse", `${COWORK_TOOL}check_app_progress`, {
    pendingAction: "decide_in_editor",
    browserNavigation: navigation,
  });
  assert.match(
    decide,
    /^CRITICAL DO NOT IGNORE: Before any other action, ensure the browserNavigation URL from this result is open in Cowork's embedded Page browser\./,
  );
  assert.doesNotMatch(decide, /verify the app loaded\. Your automatic/);

  const withoutNavigation = await runGuidance("PostToolUse", `${COWORK_TOOL}check_app_progress`, {
    status: "building",
    agentInstructions: "When `browserNavigation` is present, follow its exact URL.",
  });
  assert.equal(withoutNavigation, undefined);
});

test("Cowork opens commit previews, publish details and integration setup in its browser pane", async () => {
  assert.match(
    await runGuidance("PostToolUse", `${COWORK_TOOL}build_app`, {
      status: "ready",
      previewUrl: EDIT_URL,
    }),
    /ensure the previewUrl from this result is open in Cowork's embedded Page browser and verify only that the commit preview loaded/,
  );
  assert.match(
    await runGuidance("PostToolUse", `${COWORK_TOOL}get_preview_status`, { status: "ready" }),
    /open the exact `previewUrl` from the original `build_app` result in Cowork's embedded Page browser/,
  );
  const publish = await runGuidance("PostToolUse", `${COWORK_TOOL}publish_app`, {
    status: "publishing",
    publishDetailsUrl: EDIT_URL,
  });
  assert.match(
    publish,
    /^On either successful status, open publishDetailsUrl automatically in the browser pane before the first check_publish_progress poll\./,
  );
  assert.match(
    publish,
    /ensure the publishDetailsUrl from this result is open in Cowork's embedded Page browser and verify the publish details loaded/,
  );
  assert.match(
    await runGuidance("PostToolUse", `${COWORK_TOOL}check_publish_progress`, {
      status: "deployed",
      publishDetailsUrl: EDIT_URL,
    }),
    /^Before any other action, ensure the publishDetailsUrl/,
  );

  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}create_integration`, {
      integration_id: "i",
      integration_url: "https://app.superblocks.com/integrations/i",
    }),
    "Open the exact returned integration_url in Cowork's browser pane side panel.",
  );
  assert.match(
    await runGuidance("PostToolUse", `${COWORK_TOOL}create_integration`, {
      integration_id: "i",
      integration_url: `${EDIT_URL}?sb_integration_setup=i`,
    }),
    /side panel even if the app editor is already open\. That URL opens the Integrations tab inside the editor/,
  );
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}set_server`, {}),
    "Continue in this Cowork task after success.",
  );
});
