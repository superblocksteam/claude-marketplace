# claude-marketplace

Superblocks plugin marketplace for Claude.

## Anthropic directory submission

Submit the production plugin through [Anthropic's developer portal](https://claude.ai/directory/manage).
Use **Plugin bundle** with these source fields after the preparation PR is merged:

| Field         | Value                                                   |
| ------------- | ------------------------------------------------------- |
| Repository    | `https://github.com/superblocksteam/claude-marketplace` |
| Plugin path   | `plugins/superblocks-plugin`                            |
| Branch or tag | `main`                                                  |

The listing README lives [inside the plugin](plugins/superblocks-plugin/README.md).
Submit that folder, rather than the marketplace root or a Cowork ZIP. The plugin
uses a local MCP server: its tools run in Claude Code and desktop-local Cowork,
and are ignored in web and mobile chat.

Before submitting:

1. Run the checks below, then select **Validate** in the portal against the
   merged commit. Fix blocking findings and revalidate after any push.
2. Expect reviewer holds for the lockfile-installed CLI and the Node launcher
   inside a repository subfolder. These are documented in Anthropic's
   [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist).
3. Use the Superblocks Claude organization that should own the listing. The
   submitting account needs a paid plan, an eligible role, and a connected
   GitHub account with push access. A private repository also needs the Claude
   GitHub App and consent to upload its source for review. The repository must
   be public before the listing can go live.
4. Confirm the contact email and data handling answers using the plugin README
   and the applicable customer agreement. Confirm retention, external services,
   and the intended age group with the service owner; the plugin's local files
   do not establish service-side policies. Complete the compliance
   acknowledgements, choose update settings, and submit for review.

```sh
npm test
claude plugin validate ./plugins/superblocks-plugin --strict
claude plugin validate . --strict
```

Portal validation and Anthropic's security review remain separate from these
local checks. Follow [Submit your plugin](https://claude.com/docs/plugins/submit)
for review status and publishing. A directory listing does not submit to the
`claude-plugins-official` marketplace.

## Channels

Shared changes flow through long-lived branches:

```text
main (beta / production) -> next (staging) -> master (dev)
```

Each branch owns its exact CLI dependency and lockfile in
`plugins/superblocks-plugin`. It also owns its marketplace name and plugin
branding. Other channels' pins are not stored on that branch.

| Channel | Branch   | Claude Code marketplace                     |
| ------- | -------- | ------------------------------------------- |
| `beta`  | `main`   | `superblocksteam/claude-marketplace`        |
| `next`  | `next`   | `superblocksteam/claude-marketplace#next`   |
| `dev`   | `master` | `superblocksteam/claude-marketplace#master` |

Add one marketplace with `/plugin marketplace add <marketplace>` and enable one
Superblocks plugin at a time. Claude Code installs the CLI from that branch's
lockfile. Dev installs private GitHub Packages builds and requires package read
access: `npm login --registry=https://npm.pkg.github.com --auth-type=legacy`.

The **Channels** workflow checks pull requests and pushes to all three branches.
After a successful push to `main`, it prepares a merge into `next`, preserves
next's CLI pin and branding, refreshes its locked dependencies within their declared ranges, and runs the tests,
installed dependency checks, packaging, and credentialless MCP startup check.
Only then does it push that merge and repeat the process from `next` to `master`.
A successful push directly to `next` propagates to `master` the same way. Changes
on `master` stay there until explicitly promoted in the other direction.

The cascade runs within one workflow because pushes using `GITHUB_TOKEN` do not
trigger another push workflow. Shared-file conflicts stop propagation for manual
resolution on the destination branch. A concurrent destination update rejects
publication; rerun **Channels** from the parent branch to prepare and test a fresh
candidate. Publication appends merge commits and never force-pushes.

The first cascade migrates the existing package-only channel snapshots into full
repository branches, preserving their history, CLI pins, and branding. Run it
from `main` before relying on direct dev pin updates. Branch protection must
permit the automation's normal fast-forward pushes; this change does not modify
repository settings.

Security overrides are shared package settings, so fixes to them merge forward
while CLI versions stay on their own branches. npm does not inherit the CLI
monorepo's pnpm overrides. [AR-904](https://linear.app/superblocks/issue/AR-904)
tracks removing them once published dependencies contain the fixes.

### Pin a newer CLI

Check out the channel's branch, then run:

```sh
npm run pin -- <channel> [tag-or-version]
```

Without a version, this resolves the channel's npm tag (`beta`, `next`, or
`master`) to an exact version. The command refuses a different channel's tree.
Open a PR against that same branch. For beta, also bump the plugin version in
`.claude-plugin/marketplace.json` and the plugin manifest. Next and dev versions
include the source commit and CLI version automatically.

To update dev directly from the latest published `@master`:

```sh
npm run update:dev
```

This requires Node.js 24, Git, authenticated `gh` with repository write access,
and GitHub Packages read access. `NODE_AUTH_TOKEN` can supply the package read
token; GitHub authentication remains separate through `gh` or `GH_TOKEN`.
The command clones the latest `master` into a temporary directory, resolves the
exact CLI version, refreshes the pin, lockfile, and branding, and runs the same full
verification as CI before pushing to `master`. It leaves the caller's checkout
untouched and creates no pin PR. An unchanged version does nothing. Failed
verification or a concurrent branch update leaves the remote branch untouched.
Npm pin resolution uses only the package manifests in an isolated directory,
with proxying disabled, TLS verification enabled, and GitHub write credentials
removed from its environment.

Superblocks' master publish automation can keep invoking `npm run update:dev`;
successful updates now land directly on marketplace `master`. Existing pin PRs
against `main` belong to the old model and should be closed without merging.

## Cowork releases

Run **Actions > Release Cowork plugin > Run workflow** from `main` and choose
`next` or `beta`. The workflow runs on the Namespace macOS profile and creates
a draft prerelease with two assets from the selected channel's branch:

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

On `main` (beta), install the packaging tools and plugin dependencies before launching it:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
node .github/scripts/channel.mjs install beta "$PWD/plugins/superblocks-plugin"
npm test
TEST_PLUGIN_DIRECTORY="$PWD/plugins/superblocks-plugin" node --test tests/installed/dependency-security.test.mjs
```

To package a channel locally, check out its branch first (this example uses `next`):

```sh
node .github/scripts/channel.mjs marketplace next /tmp/superblocks-next
node .github/scripts/channel.mjs install next /tmp/superblocks-next/plugins/superblocks-plugin
node .github/scripts/build-mcpb.mjs /tmp/superblocks-next/plugins/superblocks-plugin /tmp/superblocks-mcpb next
python3 .github/scripts/smoke-mcpb.py /tmp/superblocks-mcpb/*.mcpb
```

Build on the operating system and CPU architecture that will run the artifact.
The published CLI already bundles its SDK code. The archive includes those
bundles, their external runtime dependencies, and the API SDK documentation
read by MCP tools. Both archives are checked against a 5,000-entry and 200 MB
budget. The MCPB packer is pinned by the root `package-lock.json`.
