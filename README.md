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
branding. Product display-name changes merge forward; each channel keeps its
own suffix. Other channels' pins are not stored on that branch.

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
next's CLI pin and branding, applies explicit security overrides, and runs the tests,
installed dependency checks, packaging, and credentialless MCP startup check.
Only then does a separate job push that merge. Its push starts the same process from `next` to `master`.
A successful push directly to `next` propagates to `master` the same way. Changes
on `master` stay there until explicitly promoted in the other direction.

Before enabling publication, create the `channel-publication` GitHub Environment:

1. Select **Selected branches and tags** and add exact **Branch** rules for `main`,
   `next`, and `master`; allow no tags or other branches. Protect these branches
   against unreviewed workflow changes.
2. Configure required reviewers, enable **Prevent self-review**, and disable
   administrator bypass of the environment's protection rules.
3. Store `CHANNEL_PUBLISH_TOKEN` **only as an environment secret**, with repository
   contents and workflows write permissions (a fine-grained PAT or GitHub App
   installation token). Remove any repository or organization secret of the same
   name that is available to this repository.

A repository secret would also be available to workflows added on unprotected
branches. Declaring an environment in YAML does not configure its protection rules;
complete this setup before adding the credential. See GitHub's
[environment setup instructions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

The default
`GITHUB_TOKEN` cannot publish workflow-file changes. The preflight waits for
environment approval first. After approval, it rejects missing credentials and failed
authenticated repository requests; preparation and verification cannot start until
that check succeeds. This read-only check does not prove contents or workflows
write access; configure both permissions on the token for this repository.
Only that check and the final publication job use the environment and receive its
credential; preparation and validation run with read-only permissions. Both privileged
jobs wait for environment approval, so channel propagation and dev promotion require
reviewer approval even when upstream automation starts the workflow. Review the
workflow ref and candidate before approving each privileged job. Candidate bundles
expire after one day. Approval after expiry fails at artifact download before any
publish command runs. **Re-run failed jobs** cannot restore an expired bundle; choose
**Re-run all jobs** to prepare and verify a fresh candidate, then approve again.
This token's pushes trigger the next channel's workflow. Shared-file conflicts stop propagation for manual
resolution on the destination branch. A concurrent destination update rejects
publication. Choose **Re-run all jobs**, or start **Channels** from the parent branch,
to prepare and test a fresh candidate. **Re-run failed jobs** reuses the original
bundle and cannot recover from a stale candidate. Bundles have unique names per
run attempt; downstream jobs use the name recorded by the producer.
Publication appends merge commits and never force-pushes.

The first cascade migrates the existing package-only channel snapshots into full
repository branches, preserving their history, CLI pins, and branding. Migration
compares legacy content with its stamped source and rejects independent edits
or missing provenance for manual resolution. Run it
from `main` before relying on direct dev pin updates. Branch protection must
permit the automation's normal fast-forward pushes; this change does not modify
repository settings.

Security overrides are shared package settings, so fixes to them merge forward
while CLI versions stay on their own branches. npm does not inherit the CLI
monorepo's pnpm overrides. A follow-up will remove them once published
dependencies contain the fixes. Forward merges preserve unrelated locked versions
and reject registry or integrity changes. Before saving a constrained lockfile,
npm validates its dependency ranges with a dry-run install and reports required
unreviewed changes for a lockfile PR. Forward merges accept new
dependencies only when their exact entries already exist in the incoming branch's
reviewed lockfile. Their changes to existing versions are limited to explicit
overrides; the destination CLI version stays unchanged.
Updating only the lockfile on one branch does not update existing transitive
versions on other channels. To ship a security fix across channels, add an
explicit shared override or open a lockfile PR against each affected channel.
If a forward merge requires additional dependency changes, refresh that channel's
lockfile with `npm run pin` and review it in a PR before retrying the merge.

### Pin a newer CLI

Check out the channel's branch, then run:

```sh
npm run pin -- <channel> [tag-or-version]
```

Without a version, this resolves the channel's npm tag (`beta`, `next`, or
`master`) to an exact version. The command refuses a different channel's tree.
CLI pin updates resolve the full dependency graph, including exact-pinned internal
packages and new or changed transitive dependencies. Registry, tarball identity,
alias, and installability checks still apply. Review both package files in the PR.
Open a PR against that same branch. For beta, also bump the plugin version in
`.claude-plugin/marketplace.json` and the plugin manifest. Next and dev versions
include a plugin-content hash and CLI version automatically. After direct plugin
edits on next or dev, stage any new plugin files, then run
`node .github/scripts/channel.mjs version <channel>`
and commit both manifests. The hash covers current contents of Git-tracked plugin
files; untracked local files are ignored. Adding a new file after computing the
version requires recomputing it. Verification rejects stale versions before forwarding
or release packaging; require the Channels check on channel PRs to enforce this
before merge. Direct pushes also fail validation if the version is stale.

To update dev directly from the latest published `@master`:

```sh
npm run update:dev
```

This requires Node.js 24 and authenticated `gh` with permission to dispatch Actions.
The command requests **Actions > Update dev pin** on `main` and returns after GitHub
accepts the request. Follow that workflow for the final result; the local command
does not install or execute the new CLI.
Exit zero means the dispatch was accepted, not that publication succeeded.
Automation calling this command must observe the requested workflow's final result.

The workflow prepares an immutable commit from the latest `master`, resolving the
exact CLI version and refreshing its full dependency graph, pin, and branding without running
package scripts. A separate runner verifies that commit, builds and smoke-tests
the bundle, and rejects changes to tracked files during verification. A third
runner publishes the original prepared commit only after verification passes.
The CLI verification runner has no repository write credential. An unchanged
version does nothing; failed verification, a moved npm tag, or a concurrent branch
update leaves the remote branch untouched. The caller's checkout stays unchanged,
and no pin PR is created.

Dev promotion trusts the CLI master publishing pipeline. Before pushing, the
workflow also requires the exact version's registry tarball URL and integrity to
match the prepared lockfile. A mismatch stops publication for investigation.

Configure `GH_PACKAGES_READ_TOKEN` for private package access and
`CHANNEL_PUBLISH_TOKEN` only in the protected `channel-publication` environment
configured above. Pin resolution uses isolated package
manifests, disabled proxying, verified TLS, and no GitHub write token in the npm
environment. Superblocks' master publish automation can keep invoking
`npm run update:dev` with workflow-dispatch permission; publication status now lives
in the requested workflow. Missing or expired publication credentials fail its preflight;
package preparation, verification, and publication have separate job results.
If publication reports a moved tag or branch, choose **Re-run all jobs** or start a
new **Update dev pin** run to prepare and verify a fresh candidate.
Existing pin PRs against `main` belong to the old model
and should be closed without merging.

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
