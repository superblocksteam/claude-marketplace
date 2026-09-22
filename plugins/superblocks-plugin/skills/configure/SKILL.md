---
name: configure
description: Configure and authenticate the Superblocks plugin for Claude Cowork.
---

# Configure Superblocks

Confirm that the computer running Claude Desktop has Node.js 24 or newer and npm
10 or newer.

Ask which Superblocks host the user connects to. Default to
`app.superblocks.com`; use another host only when their Superblocks administrator
provided it. Accept only a bare hostname containing letters, digits, hyphens,
and dots, with no credentials, port, path, query, or fragment.

Once the host passes that check, replace `YOUR_SUPERBLOCKS_HOST` with it in the
command below, so the user can run the command as given. If the answer fails the
check, do not insert it: ask again, and leave the literal
`YOUR_SUPERBLOCKS_HOST` in place for them to replace after opening a terminal on
the computer running Claude Desktop.

Read `NPM_CONFIG_PACKAGE` from the plugin's `.mcp.json` and replace every
`SELECTED_SUPERBLOCKS_CLI_PACKAGE` below with its value. For a
`${NPM_CONFIG_PACKAGE:-VALUE}` value, use `VALUE`. Accept only
`@superblocksteam/cli` with an optional exact version or tag containing letters,
digits, dots, underscores, plus signs, or hyphens. Leave the placeholder in
place and ask the user to fix `.mcp.json` if the value is invalid.

On macOS or Linux, give them this one-line command:

```bash
umask 077 && npx --yes --prefer-online --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/ --package=SELECTED_SUPERBLOCKS_CLI_PACKAGE -- superblocks config set domain YOUR_SUPERBLOCKS_HOST && npx --yes --prefer-online --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/ --package=SELECTED_SUPERBLOCKS_CLI_PACKAGE -- superblocks login
```

On Windows, give them this one-line command, which works from Windows PowerShell
5.1 and newer:

```powershell
cmd.exe /d /s /c "npx --yes --prefer-online --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/ --package=SELECTED_SUPERBLOCKS_CLI_PACKAGE -- superblocks config set domain YOUR_SUPERBLOCKS_HOST && npx --yes --prefer-online --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/ --package=SELECTED_SUPERBLOCKS_CLI_PACKAGE -- superblocks login"
```

Never ask the user to paste their Superblocks API key into Claude. The login
command prompts for it privately in their terminal.

After the command succeeds, ask the user to start a new Cowork task so the MCP
server reconnects with the saved CLI session.
