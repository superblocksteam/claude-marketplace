---
name: configure
description: Complete browser sign-in for the Superblocks plugin in Claude Cowork.
---

# Configure Superblocks

Confirm that the computer running Claude Desktop has Node.js 24 or newer and npm
10 or newer.

The plugin connects to `https://app.superblocks.com` and opens browser sign-in
automatically. No terminal or API-key setup is required.

Ask the user to finish signing in in the browser, then return to Cowork. If the
browser did not open, verify the runtime versions, then ask them to reconnect
the plugin. If it still fails, ask for the MCP launch error shown by Claude.
