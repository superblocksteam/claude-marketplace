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

Never insert the user's response into shell code. Tell them to replace the
literal `YOUR_SUPERBLOCKS_HOST` themselves after opening a terminal on the
computer running Claude Desktop.

On macOS or Linux, give them this one-line command:

```bash
umask 077 && npx --yes --prefer-online --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/ --package=@superblocksteam/cli@beta -- superblocks config set domain YOUR_SUPERBLOCKS_HOST && npx --yes --prefer-online --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/ --package=@superblocksteam/cli@beta -- superblocks login
```

On Windows, give them this one-line command, which works from Windows PowerShell
5.1 and newer:

```powershell
cmd.exe /d /s /c "npx --yes --prefer-online --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/ --package=@superblocksteam/cli@beta -- superblocks config set domain YOUR_SUPERBLOCKS_HOST && npx --yes --prefer-online --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/ --package=@superblocksteam/cli@beta -- superblocks login"
```

Never ask the user to paste their Superblocks API key into Claude. The login
command prompts for it privately in their terminal.

After the command succeeds, ask the user to start a new Cowork task so the MCP
server reconnects with the saved CLI session.
