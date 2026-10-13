# claude-marketplace

Superblocks plugin marketplace for Claude.

## Channels

`main` is the only branch to edit. Each channel pins one exact CLI version:

| Channel | Environment | Pinned in                    | Claude Code marketplace                     |
| ------- | ----------- | ---------------------------- | ------------------------------------------- |
| `beta`  | prod        | `plugins/superblocks-plugin` | `superblocksteam/claude-marketplace`        |
| `next`  | staging     | `channels/next`              | `superblocksteam/claude-marketplace#next`   |
| `dev`   | master      | `channels/dev`               | `superblocksteam/claude-marketplace#master` |

Add one marketplace with `/plugin marketplace add <marketplace>` and enable one
Superblocks plugin at a time. Claude Code installs the pinned CLI from the
channel's lockfile. The `dev` channel installs private GitHub Packages builds;
it works only for users who can read them, after
`npm login --registry=https://npm.pkg.github.com --auth-type=legacy`.

The **Channels** workflow tests every channel on each pull request and push,
installs its locked CLI, builds its MCPB, and runs the startup check below.
After a push to `main`, it regenerates the `next` and `master` branches from
`main` and the channel pins as a new commit on each branch; it never
force-pushes. Their plugin version records the source commit and CLI version.
Do not edit those branches directly.

### Pin a newer CLI

```sh
npm run pin -- <channel> [tag-or-version]
```

Without a version, the command pins the channel's npm tag: `beta`, `next`, or
`master`. Pinning `dev` needs GitHub Packages read access. Open a pull request
with the change; for `beta`, also bump the plugin `version` in
`.claude-plugin/marketplace.json` and the plugin manifest. The `next` and `dev`
branches derive their versions from the source commit and CLI version.

To open a draft PR for the latest `@master` automatically:

```sh
npm run update:dev
```

The command requires Node.js 24, Git, authenticated `gh` with repository write
access, and GitHub Packages read access. It pins from the latest `main` in a
temporary clone, leaves your checkout untouched, and reuses an open PR for the
same CLI version. If a PR for that version was closed or merged, it does not
reopen it; use `npm run pin -- dev <version>` for an intentional retry.
If `main` already pins that version, it does nothing.
PR history must come from this repository. Recovery regenerates registry
pins and accepts an existing branch only when its tree contains exactly the
dev pin changes and those files match; otherwise, pin manually.
`NODE_AUTH_TOKEN` can supply the package read token; GitHub authentication
remains separate through `gh` or `GH_TOKEN`.

Superblocks' master workflow runs this command after publishing the master
CLI, so each successful master publish can open its dev pin PR. Review and
merge the PR to update `#master`; users then update their dev plugin. New CLI
versions get separate PRs so newer builds do not replace a version under
review. Sort pending PRs by creation time rather than snapshot version, merge
the newest acceptable update, and close superseded PRs. Automation leaves
review decisions and existing PRs intact.

## Cowork releases

Run **Actions > Release Cowork plugin > Run workflow** from `main` and choose
`next` or `beta`. The workflow runs on the Namespace macOS profile and creates
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

To package a channel locally:

```sh
node .github/scripts/channel.mjs marketplace next /tmp/superblocks-next "$(git rev-parse HEAD)"
node .github/scripts/channel.mjs install next /tmp/superblocks-next/plugins/superblocks-plugin
node .github/scripts/build-mcpb.mjs /tmp/superblocks-next/plugins/superblocks-plugin /tmp/superblocks-mcpb next
python3 .github/scripts/smoke-mcpb.py /tmp/superblocks-mcpb/*.mcpb
```

Build on the operating system and CPU architecture that will run the artifact.
The published CLI already bundles its SDK code. The archive includes those
bundles, their external runtime dependencies, and the API SDK documentation
read by MCP tools. Both archives are checked against a 5,000-entry and 200 MB
budget. The MCPB packer is pinned by the root `package-lock.json`.
