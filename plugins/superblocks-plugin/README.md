# Superblocks

Build, import, and manage Superblocks applications from Claude. Connect to your
Superblocks account to create apps, edit them with Clark, work with integrations,
and publish apps using the permissions of your signed-in account.

## Requirements and supported apps

- A Superblocks account with access to the applications you want to manage.
- Node.js 24 or newer on the computer running the MCP server.
- Claude Code, or a Cowork session running on your computer. This plugin uses a
  local MCP server; its tools do not run in claude.ai web or mobile chat.

## Install and sign in

In Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add superblocksteam/claude-marketplace
/plugin install superblocks@superblocks
```

Enable one Superblocks plugin at a time. Ask Claude to sign in to Superblocks;
the **Login** tool opens your browser. Finish signing in, return to Claude, and
ask it to perform your task. Startup does not open a browser, and no API key is
required for browser sign-in. Claude Code installs the CLI from the plugin's
lockfile during installation.

For Cowork, install the plugin ZIP from a Superblocks Cowork release, enable it,
start a new task, and run `/configure`. The release includes the CLI runtime.

Try requests such as:

- "Create a customer support dashboard in Superblocks."
- "Import this app into Superblocks."
- "List the Superblocks applications I can access."

To choose a different Superblocks server, ask Claude to configure the server.
The `set_server` tool confirms the destination and saves it for future tasks.
The default is `https://app.superblocks.com`. Custom servers must use HTTPS;
HTTP is supported only for loopback development servers.

## What runs and what data is used

The plugin starts `scripts/launch-mcp.mjs` with Node.js. It runs the installed
`@superblocksteam/cli` as `mcp serve`, communicating with Claude over standard
input and output. The exact CLI version and its dependencies are recorded in
`package.json` and `package-lock.json`; startup does not install packages.

Tool calls send the inputs needed for the requested operation to your selected
Superblocks deployment and its services. These can include prompts, application
source files, integration configuration, and application or query data. Tool
results, including account and organization information, return to Claude.
Importing an app uploads its selected source files. Editing and publishing tools
can change applications in your account. Review the requested operation before
approving it.

Browser sign-in uses your deployment's authentication service and a local
callback. The CLI saves browser access and refresh tokens locally, by default in
`~/.superblocks/auth.json.mcp-oauth`. It saves the chosen server in
`~/.superblocks/plugin.json`. Saved login state is reused across tasks. Removing
the plugin does not remove these files; revoke the session and remove saved
credentials when you no longer want access.

The CLI sends operational metrics and traces to the selected deployment's
telemetry endpoint. In cloud deployments, traces can include tool inputs and
outputs. App preview and development tools can start local processes, use a
browser, fetch app dependencies, and connect to the deployment's app services.
Package installation downloads dependencies from npm; Cowork release archives
include the MCP runtime dependencies.

Service-side retention and handling of customer data follow your organization's
Superblocks agreement. See the [privacy policy](https://www.superblocks.com/legal/privacy),
[subprocessor list](https://www.superblocks.com/legal/subprocessors), and
[terms of service](https://www.superblocks.com/legal/terms).

## Troubleshooting and help

If Claude reports `MCP browser login required` or
`Saved Superblocks login changed outside this task`, ask it to call **Login**
and retry the operation. For startup errors, check Node.js 24 or newer is on
Claude's PATH. If the CLI is missing, reinstall the plugin.

For server and sign-in instructions, see the
[configure skill](https://github.com/superblocksteam/claude-marketplace/blob/main/plugins/superblocks-plugin/skills/configure/SKILL.md).
Learn more in the
[Superblocks documentation](https://docs.superblocks.com/).

## License

This plugin uses the [Superblocks Community Software License](LICENSE), matching
the license distributed with the Superblocks CLI.
