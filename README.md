# claude-marketplace

Superblocks plugin marketplace for Claude

The default marketplace uses the CLI's public `@beta` channel. The generated
`master` branch uses `@master` from GitHub Packages and is refreshed from the
latest `main` on every push. Run the **Publish dev marketplace** workflow manually to pick up a new
CLI build between changes to `main`. Do not commit changes directly to `master`;
the workflow replaces that branch. Before enabling it, grant this repository
read access to the CLI package under the package's **Manage Actions access**
settings so its `GITHUB_TOKEN` can resolve `@master`.

The dev CLI requires GitHub Packages access. Authenticate npm with your GitHub
username and a classic personal access token with `read:packages` access to the
Superblocks CLI package (authorize organization SSO if required):

```sh
npm login --scope=@superblocksteam --auth-type=legacy --registry=https://npm.pkg.github.com
```

Claude uses your npm user configuration for dependency installation; a plugin's
`.npmrc` is not used.

In Claude Code, add the dev marketplace and install its plugin:

```sh
claude plugin marketplace add 'https://github.com/superblocksteam/claude-marketplace.git#master'
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
