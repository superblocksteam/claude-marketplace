# claude-marketplace

Superblocks plugin marketplace for Claude.

## Channels

Each branch owns one complete plugin, with its exact CLI dependency and lockfile
in `plugins/superblocks-plugin`. No branch stores another channel's pin.

| Branch   | Channel | CLI tag  | Claude Code marketplace                     |
| -------- | ------- | -------- | ------------------------------------------- |
| `main`   | `beta`  | `beta`   | `superblocksteam/claude-marketplace`        |
| `next`   | `next`  | `next`   | `superblocksteam/claude-marketplace#next`   |
| `master` | `dev`   | `master` | `superblocksteam/claude-marketplace#master` |

Add one marketplace with `/plugin marketplace add <marketplace>` and enable one
Superblocks plugin at a time. Claude Code installs the pinned CLI from that
branch's lockfile. The `dev` channel installs private GitHub Packages builds;
it works only for users who can read them, after
`npm login --registry=https://npm.pkg.github.com --auth-type=legacy`.

The **Channel checks** workflow validates the checked-out branch's pin, tests
its plugin, installs the locked CLI, builds its MCPB, and checks startup.
A push to `main` never regenerates or updates `next` or `master`.
Shared plugin changes must be applied to each branch where they are needed,
while preserving that branch's pin and marketplace identity.

### Pin a newer CLI

Check out the branch you want to update, then run:

```sh
npm run pin -- [tag-or-exact-version]
```

Without a version, the command resolves that branch's CLI tag. It updates the
plugin's package and lockfile, then updates the plugin and marketplace versions
together. Other branches are untouched. Pinning `dev` needs GitHub Packages read
access; `NODE_AUTH_TOKEN` can supply it. npm resolves pins in an isolated directory
with lifecycle scripts disabled and GitHub write credentials removed.
Open pin PRs against the branch being updated.

After Superblocks publishes a master CLI, it sends a `cli-master-published`
repository event containing the exact published version. The **Update dev CLI
pin** workflow checks out `master`, updates its pin, and validates the plugin and
MCP startup in a read-only job. A separate job commits only the validated pin and
version metadata directly to `master`. It never opens a pin PR or writes another
branch. Outdated events are skipped when the registry's `master` tag has moved;
repeated versions do nothing. Concurrent branch changes reject the push rather
than being overwritten. Retry the workflow to validate against the new branch tip.
The workflow can also be run manually with an exact published CLI version.

## Cowork releases

Run **Actions > Release Cowork plugin > Run workflow** from `main` and choose
`next` or `beta`. The build checks out the selected channel branch and packages
its own plugin and lockfile. The workflow runs on the Namespace macOS profile and creates
a draft prerelease with two assets:

- A Cowork plugin ZIP containing the MCPB and configure skill.
- A standalone MCPB for Claude Desktop's local MCP extensions.

`dev` has no Cowork release: the archives preinstall the CLI, so a public
release would publish private builds.

Publish the draft release when it is ready to share. Upload the ZIP under
Cowork **Customize > Plugins**, enable one Superblocks plugin at a time, then
start a new task and run `/configure`. Node.js 24 or newer is required;
npm and saved credentials are not needed at MCP startup. Server settings in
`~/.superblocks/plugin.json` still apply. CLI package overrides no longer
select the executable; install a different bundle release to change versions.

The filenames record the channel, exact CLI version, operating system, and CPU
architecture. Each workflow run has a unique release tag and does not replace
existing assets. The runner's architecture determines the bundle architecture.
Builds install both lockfiles with `npm ci --ignore-scripts` from public npm
without package credentials. Tests, packaging, and the startup check run in a
read-only job. Only the final job, which runs nothing but SHA-pinned actions,
can create the release.

Before creating a release, the workflow extracts the actual MCPB and requires
MCP initialization and the Login tool to work with an empty home directory and
npm/npx blocked. It contacts no Superblocks account or production API. The
pinned CLI must support startup before sign-in and expose Login; otherwise the
workflow stops before creating a release.

## Local development

Install the packaging tools and the `beta` plugin's dependencies before launching it:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npm ci --prefix plugins/superblocks-plugin --ignore-scripts --registry=https://registry.npmjs.org/ --@superblocksteam:registry=https://registry.npmjs.org/
npm test
```

To package the `next` branch locally, check out `next` and run:

```sh
node .github/scripts/channel.mjs install
node .github/scripts/build-mcpb.mjs plugins/superblocks-plugin /tmp/superblocks-mcpb next
python3 .github/scripts/smoke-mcpb.py /tmp/superblocks-mcpb/*.mcpb
```

Build on the operating system and CPU architecture that will run the artifact.
The published CLI already bundles its SDK code. The archive includes those
bundles, their external runtime dependencies, and the API SDK documentation
read by MCP tools. Both archives are checked against a 5,000-entry and 200 MB
budget. The MCPB packer is pinned by the root `package-lock.json`.
