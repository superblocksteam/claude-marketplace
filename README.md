# claude-marketplace

Superblocks plugin marketplace for Claude

The default marketplace uses the CLI's public `@beta` channel. The generated
`dev` branch uses public `@next` and is refreshed from the latest `main` on every
push. Run the **Publish dev marketplace** workflow manually to pick up a new
CLI build between changes to `main`. Do not commit changes directly to `dev`;
the workflow replaces that branch.

In Claude Code, add the dev marketplace and install its plugin:

```sh
claude plugin marketplace add 'https://github.com/superblocksteam/claude-marketplace.git#dev'
claude plugin install superblocks@superblocks-dev
claude plugin disable superblocks@superblocks
```

The marketplaces have distinct names so both can be registered. Enable one
Superblocks plugin at a time. Re-enable `superblocks@superblocks` and disable
`superblocks@superblocks-dev` to switch back to beta. Start a new session after
switching. Cowork accepts repository URLs, but its `#ref` handling has not been
verified yet.

CLI versions come from each plugin's dependency and lockfile.
`SUPERBLOCKS_CLI_PACKAGE` and `cliPackage` in `~/.superblocks/plugin.json` no
longer select a CLI. Server settings in that file still apply.

For local development, install the plugin's dependencies before launching it:

```sh
npm ci --prefix plugins/superblocks-plugin --ignore-scripts
node --test tests/*.test.mjs
```
