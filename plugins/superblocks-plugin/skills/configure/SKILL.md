---
name: configure
description: Configure browser sign-in and MCP settings for the Superblocks plugin in Claude Cowork.
---

# Configure Superblocks

Confirm that the computer running Claude Desktop has Node.js 24 or newer and npm
10 or newer.

The plugin connects to `https://app.superblocks.com`. It does not open a browser
at startup. The first account-dependent tool call opens browser sign-in when no
session is saved. No terminal or API-key setup is required for browser sign-in.

If a tool reports `MCP browser login changed`, explicitly call **Login**. It
updates the current task; then retry the user's original tool call. Also call
**Login** when the user asks to sign in or switch accounts. Do not ask them to
restart Claude for a changed login.

## Customize MCP settings

When the user asks to customize the plugin, edit the `env` object under
`mcpServers.superblocks` in the plugin's `.mcp.json`. Preserve unrelated
settings and keep environment values as JSON strings.

- Set `SUPERBLOCKS_CLI_PACKAGE` to an exact version or tag, such as
  `@superblocksteam/cli@beta`, or a local `file:` URL. Use
  `@superblocksteam/cli` or `@superblocksteam/cli-ephemeral` and do not use
  version ranges. The ephemeral package is fetched from GitHub Packages and
  requires npm authentication for `npm.pkg.github.com`.
- Set `SUPERBLOCKS_SERVER_URL` to the Superblocks server origin. Use HTTPS with
  no credentials, path, query, or fragment. HTTP is allowed only for a loopback
  address such as `http://localhost:8080`.
- Keep `SUPERBLOCKS_MCP_BROWSER_LOGIN` set to `"true"` to open browser sign-in
  on the first account-dependent call if no session is saved. Set it to
  `"false"` to prevent browser sign-in. When it is `"false"`, remove
  `SUPERBLOCKS_SERVER_URL` so the server URL comes from the existing CLI session.
  This manual mode requires a CLI session created on the same computer with
  `superblocks login`. For the default package, run
  `npx --yes --package=@superblocksteam/cli@beta -- superblocks login` in a
  terminal on that computer. Use the configured CLI package if it differs.
  For a non-default host, run `superblocks config set domain <hostname>` with
  that package before running the CLI login command.
  The CLI asks for credentials privately in the terminal.

After changing any value, ask the user to start a new Cowork task so Claude
restarts the MCP server with the updated environment.

After a tool or **Login** opens the browser, ask the user to finish signing in
and return to Cowork. If the browser does not open, check the runtime versions,
the server URL, and the MCP launch error shown by Claude. Retry **Login** only
after the reported problem is corrected.
