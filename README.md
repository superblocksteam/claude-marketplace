# claude-marketplace

Superblocks plugin marketplace for Claude.

## Cowork releases

Run **Actions > Release Cowork plugin > Run workflow** from `main` to build
with the CLI version pinned in `plugins/superblocks-plugin/package-lock.json`.
The workflow runs on the Namespace macOS profile and creates a draft
prerelease with two assets:

- A Cowork plugin ZIP containing the MCPB and configure skill.
- A standalone MCPB for Claude Desktop's local MCP extensions.

Publish the draft release when it is ready to share. Upload the ZIP under
Cowork **Customize > Plugins**, enable one Superblocks plugin at a time, then
start a new task and run `/configure`. Node.js 24 or newer is required;
npm and saved credentials are not needed at MCP startup. Server settings in
`~/.superblocks/plugin.json` still apply. CLI package overrides no longer
select the executable; install a different bundle release to change versions.

The filenames record the exact CLI version, operating system, and CPU
architecture. Each workflow run has a unique release tag and does not replace
existing assets. The runner's architecture determines the bundle architecture.
The workflow installs both lockfiles with `npm ci --ignore-scripts` from public
npm without package credentials; it never packages the private `@master`
channel. Tests, packaging, and the startup check run in a read-only job. Only
the final job, which runs nothing but SHA-pinned actions, can create the
release.

Before creating a release, the workflow extracts the actual MCPB and requires
MCP initialization and the Login tool to work with an empty home directory and
npm/npx blocked. It contacts no Superblocks account or production API.
The locked CLI must support startup before sign-in and expose Login;
otherwise the workflow stops before creating a release.

### Promote a newer beta CLI

Refresh the lock to the current public `beta` tag, then open a pull request
with the lockfile change and a matching plugin `version` bump in
`.claude-plugin/marketplace.json` and the plugin manifest:

```sh
npm update @superblocksteam/cli --prefix plugins/superblocks-plugin --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/
```

A moved `beta` tag changes nothing until that pull request merges; the
marketplace plugin and the next Cowork release both install the reviewed
lockfile.

## Local development

Install the packaging tools and the plugin's dependencies before launching it:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npm ci --prefix plugins/superblocks-plugin --ignore-scripts --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/
npm test
```

To package a plugin directory that already has its CLI installed:

```sh
node .github/scripts/build-mcpb.mjs /path/to/installed/plugin /tmp/superblocks-mcpb
python3 .github/scripts/smoke-mcpb.py /tmp/superblocks-mcpb/*.mcpb
```

Build on the operating system and CPU architecture that will run the artifact.
The published CLI already bundles its SDK code. The archive includes those
bundles, their external runtime dependencies, and the API SDK documentation
read by MCP tools. Both archives are checked against a 5,000-entry and 200 MB
budget. The MCPB packer is pinned by the root `package-lock.json`.
