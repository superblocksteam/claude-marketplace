---
name: configure
description: Configure browser sign-in and MCP settings for the Superblocks plugin in Claude Cowork.
---

# Configure Superblocks

Confirm that the computer running Claude Desktop has Node.js 24 or newer and npm
10 or newer.

The plugin defaults to `https://app.superblocks.com`. It does not open a browser
at startup. Call **Login** before the first account-dependent tool when no
session is saved. Account-dependent tools never open browser sign-in on their
own. No terminal or API-key setup is required.

If a tool reports `MCP browser login required` or
`Saved Superblocks login changed outside this task`, explicitly call **Login**. It updates the current
task; then retry the user's original tool call. Also call **Login** when the
user asks to sign in or switch accounts. Do not ask them to restart Claude for
a saved login changed outside this task.

## Customize MCP settings

When the user asks to configure the Superblocks server, use Claude's native
question form if available to ask: "Is https://app.superblocks.com the correct
server?" Offer "Yes, use this server" and a free-text option for another
server URL. If the form cannot collect free text, ask in chat. Wait for the
answer, then call `set_server` with the chosen origin. Use HTTPS with no
credentials, path, query, or fragment; HTTP is allowed only for loopback such
as `http://localhost:8080`. The tool saves the server with the browser login
outside the plugin and applies it to the current Cowork task. If sign-in opens,
ask the user to finish it in the browser and return to Cowork. Do not edit the
plugin's `.mcp.json` to change the server.
For a custom HTTPS or loopback server, `set_server` requests its own confirmation form
showing the exact origin before sign-in. If the host cannot show that form,
the tool will not switch servers; a chat reply cannot replace this confirmation.
Report `set_server`'s sign-in status from its result. A successful `whoami`
does not show whether browser sign-in happened during the server change.

For advanced package testing, edit `SUPERBLOCKS_CLI_PACKAGE` in the plugin's
`.mcp.json`. Accept an exact version or tag, such as
`@superblocksteam/cli@beta`, or a local `file:` URL. Use
`@superblocksteam/cli` or `@superblocksteam/cli-ephemeral` and do not use
version ranges. The ephemeral package is fetched from GitHub Packages and
requires npm authentication for `npm.pkg.github.com`. This plugin file may be
replaced by an update; start a new Cowork task after changing the package.

After **Login** or `set_server` opens the browser, ask the user to finish signing in
and return to Cowork. If the browser does not open, check the runtime versions,
the server URL, and the MCP launch error shown by Claude. Retry **Login** only
after the reported problem is corrected.
