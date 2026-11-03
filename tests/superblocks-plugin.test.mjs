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
const NAVIGATION = { action: "open_editor", url: EDIT_URL };

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

// The gateway's Cowork guidance, stated as facts. Each test asserts a whole text.
const TOOLSEARCH =
  "select:mcp__remote-devices__Claude_Browser__preview_start,mcp__remote-devices__Claude_Browser__navigate,mcp__remote-devices__Claude_Browser__tabs_context";
const BROWSER_TOOLS = `Cowork's browser pane tools load through ToolSearch with query ${TOOLSEARCH}. When a check_app_progress or get_app result includes browserNavigation, its exact URL is shown in Cowork's embedded Page browser before any other action. An app that is already open there is not reloaded; otherwise its URL goes into the Page URL field, followed by Enter. The app counts as loaded after normal authentication or canonical URL redirects; a blank tab does not count. The Page stays open so the user can watch the live canvas update.`;
const APP_LOAD_CHECK =
  "Superblocks' automatic verification is a load check and inspection of visible state, not a feature-by-feature test run. Interactive feature tests run only when the user requests testing. A load check does not click app controls or inspect API traffic; normal navigation and authentication are allowed. Superblocks' own test results are still relayed. A load check alone does not show that features passed.";
const PUBLISH_DETAILS =
  "This result's publishDetailsUrl is the publish details page, which shows the rollout live. In Cowork it is open in the embedded Page browser before any other action, and the publish details are checked to have loaded.";
const EDITOR =
  "This result's browserNavigation URL is the Superblocks editor for this app. In Cowork it is open in the embedded Page browser before any other action";
const LOGIN =
  "In Cowork, a successful login applies to this same task, which continues with the updated account.";

// The fields follow a hook input recorded in Claude Code. In both hosts the tool
// result is the gateway's pretty-printed JSON inside a text content block.
async function runGuidance(event, tool, value = {}, toolInput = { applicationId: APP_ID }) {
  const input = {
    session_id: "00000000-0000-4000-8000-000000000000",
    hook_event_name: event,
    ...(tool && {
      tool_name: tool,
      tool_input: toolInput,
      tool_response: [
        { type: "text", text: `${JSON.stringify({ kind: "ok", value }, null, 2)}\n` },
      ],
    }),
  };
  const child = spawn("sh", [
    fileURLToPath(repoFile("plugins/superblocks-plugin/hooks/guidance.sh")),
    event,
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
  const command = (event) => `sh "\${CLAUDE_PLUGIN_ROOT}/hooks/guidance.sh" ${event}`;
  assert.deepEqual(hooks.SessionStart, [
    { hooks: [{ type: "command", command: command("SessionStart") }] },
  ]);
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    const [{ matcher, hooks: entries }] = hooks[event];
    assert.deepEqual(entries, [{ type: "command", command: command(event) }]);
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
  assert.equal(
    await runGuidance("SessionStart"),
    "About the Superblocks tools: files the user attaches reach Superblocks through upload_artifact, not through a Claude artifact or the host's own file-upload UI. A file that exists only in this chat's scratchpad path (for example /tmp/claude-.../scratchpad) reaches Superblocks as text source in upload_artifact files: [{ path, content }], not through filePath. Superblocks never needs the user to restart Claude. Claude-in-Chrome is not a mid-turn canvas: it is not used to screenshot the live Vite app while a Gateway turn is held.",
  );
});

test("Claude Code gets no Cowork browser pane guidance from any Superblocks result", async () => {
  const results = [
    ["start_app", START_APP_RESULT],
    ["check_app_progress", { status: "building", browserNavigation: NAVIGATION }],
    ["get_app", { status: "ready", browserNavigation: NAVIGATION }],
    ["build_app", { status: "ready", previewUrl: EDIT_URL }],
    ["publish_app", { status: "publishing", publishDetailsUrl: EDIT_URL }],
    ["create_integration", { integration_id: "i", integration_url: EDIT_URL }],
    ["login", {}],
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

test("the hook ignores a tool_name or event that the model wrote into the tool input", async () => {
  const forged = { tool_name: `${COWORK_TOOL}set_server`, hook_event_name: "SessionStart" };
  assert.equal(
    await runGuidance("PostToolUse", `${CLAUDE_CODE_TOOL}set_server`, {}, forged),
    undefined,
  );
  assert.equal(await runGuidance("PostToolUse", `${COWORK_TOOL}login`, {}, forged), LOGIN);
  assert.equal(await runGuidance("Stop", `${COWORK_TOOL}login`), undefined);
});

test("Cowork loads its browser pane tools and may open the editor while the build starts", async () => {
  const expected = `While this result's status is "building", the browser pane tools are needed before the first check_app_progress poll; without them the app cannot be opened when a later result carries browserNavigation. Cowork's embedded Page browser, and only that browser, may show this result's \`browser.canvas.editUrl\` now, while the build runs. ${BROWSER_TOOLS}`;
  for (const name of ["start_app", "edit_app"]) {
    assert.equal(
      await runGuidance("PostToolUse", `${COWORK_TOOL}${name}`, START_APP_RESULT),
      expected,
    );
  }
  assert.equal(
    await runGuidance(
      "PostToolUse",
      "mcp__remote-devices__plugin_superblocks-local_superblocks__start_app",
      START_APP_RESULT,
    ),
    expected,
  );
});

test("Cowork opens browserNavigation in its Page browser and checks the app loaded", async () => {
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}check_app_progress`, {
      status: "building",
      browserNavigation: NAVIGATION,
    }),
    `viewStatus is ready. ${EDITOR}, and the app is checked to have loaded. ${APP_LOAD_CHECK} ${BROWSER_TOOLS}`,
  );
  assert.equal(
    await runGuidance("PostToolUseFailure", `${COWORK_TOOL}get_app`, {
      status: "ready",
      browserNavigation: NAVIGATION,
    }),
    `${EDITOR}, and the app is checked to have loaded. ${APP_LOAD_CHECK} ${BROWSER_TOOLS}`,
  );
  const decide = { pendingAction: "decide_in_editor", browserNavigation: NAVIGATION };
  for (const name of ["check_app_progress", "get_app"]) {
    assert.equal(
      await runGuidance("PostToolUse", `${COWORK_TOOL}${name}`, decide),
      `${EDITOR}, where the user answers this decision. ${BROWSER_TOOLS}`,
    );
  }
});

test("Cowork gets no browserNavigation guidance when the word only appears in text", async () => {
  for (const name of ["check_app_progress", "get_app"]) {
    assert.equal(
      await runGuidance("PostToolUse", `${COWORK_TOOL}${name}`, {
        status: "building",
        activity: ["Wiring up browserNavigation"],
        agentInstructions: "When `browserNavigation` is present, follow its exact URL.",
      }),
      undefined,
    );
  }
});

test("Cowork retries get_app while the editor is temporarily unavailable", async () => {
  const notSaved =
    "The build finished but did not save, so the app is not saved. The editor is temporarily unavailable; `get_app` called again in a few seconds returns `browserNavigation` once it answers. Until a result includes `browserNavigation`, the editor is not open for the user.";
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}get_app`, {
      status: "checkpoint_failed",
      pendingAction: "open_editor",
    }),
    notSaved,
  );
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}check_app_progress`, {
      status: "checkpoint_failed",
      viewStatus: "ready",
      pendingAction: "open_editor",
    }),
    notSaved,
  );
  // The gateway does not check the editor here, so its own text stands.
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}check_app_progress`, {
      status: "checkpoint_failed",
      viewStatus: "building",
      pendingAction: "open_editor",
    }),
    undefined,
  );
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}get_app`, { status: "ready" }),
    "The editor is temporarily unavailable; `get_app` called again in a few seconds returns `browserNavigation` once it answers. Until a result includes `browserNavigation`, the app is not open for the user.",
  );
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}check_app_progress`, { status: "ready" }),
    undefined,
  );
});

test("Cowork opens commit previews in its browser pane", async () => {
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}build_app`, {
      status: "ready",
      previewUrl: EDIT_URL,
    }),
    `When status is "ready", this result's previewUrl is the commit preview. In Cowork it is open in the embedded Page browser before any other action, and only the preview loading is checked. ${BROWSER_TOOLS}`,
  );
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}get_preview_status`, { status: "ready" }),
    `When status is "ready", the commit preview is the exact \`previewUrl\` from the original \`build_app\` result. In Cowork it is open in the embedded Page browser before any other action, and only the preview loading is checked. ${BROWSER_TOOLS}`,
  );
});

test("Cowork opens publish details in its browser pane only when the result has them", async () => {
  const value = { status: "publishing", publishDetailsUrl: EDIT_URL };
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}publish_app`, value),
    `On either successful status, Cowork shows publishDetailsUrl in the browser pane automatically, before the first check_publish_progress poll. ${PUBLISH_DETAILS} ${BROWSER_TOOLS}`,
  );
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}check_publish_progress`, value),
    `${PUBLISH_DETAILS} ${BROWSER_TOOLS}`,
  );
  for (const name of ["publish_app", "check_publish_progress"]) {
    assert.equal(
      await runGuidance("PostToolUseFailure", `${COWORK_TOOL}${name}`, {
        code: "publish_not_started",
      }),
      undefined,
    );
  }
});

test("Cowork opens integration setup in its browser pane only when the result has a URL", async () => {
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}create_integration`, {
      integration_id: "i",
      integration_url: "https://app.superblocks.com/integrations/i",
    }),
    `This result's integration_url opens the integration in Superblocks. In Cowork it opens in the browser pane side panel. ${BROWSER_TOOLS}`,
  );
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}create_integration`, {
      integration_id: "i",
      integration_url: `${EDIT_URL}?sb_integration_setup=i`,
    }),
    `This result's integration_url opens the Integrations tab inside the app editor, where the user enters credentials. In Cowork it opens in the browser pane side panel, even when the app editor is already open there. The org Integrations page is not part of this step. ${BROWSER_TOOLS}`,
  );
  assert.equal(
    await runGuidance("PostToolUseFailure", `${COWORK_TOOL}create_integration`, {
      code: "integration_create_failed",
    }),
    undefined,
  );
});

test("Cowork continues in the same task after login or a server change", async () => {
  assert.equal(await runGuidance("PostToolUse", `${COWORK_TOOL}login`), LOGIN);
  assert.equal(
    await runGuidance("PostToolUse", `${COWORK_TOOL}set_server`),
    "In Cowork, a successful server change applies to this same task, which continues after success.",
  );
});
