---
name: configure
description: Configure browser sign-in and MCP settings for the Superblocks plugin in Claude Cowork.
---

# Configure Superblocks

Confirm that the computer running Claude Desktop has Node.js 24 or newer and npm
10 or newer.

The plugin connects to `https://app.superblocks.com` and opens browser sign-in
automatically. No terminal or API-key setup is required.

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
  automatically when authentication is needed. Set it to `"false"` to prevent
  an automatic browser launch. When it is `"false"`, remove
  `SUPERBLOCKS_SERVER_URL` so the server URL comes from the existing CLI session.

After changing any value, ask the user to start a new Cowork task so Claude
restarts the MCP server with the updated environment.

Ask the user to finish signing in in the browser, then return to Cowork. If the
browser did not open, verify the runtime versions, then ask them to reconnect
the plugin. If it still fails, ask for the MCP launch error shown by Claude.
