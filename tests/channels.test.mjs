import assert from "node:assert/strict";
import test from "node:test";

import { Channel } from "../.github/scripts/channels.mjs";

test("channel identities select their branch, registry, and public release policy", () => {
  assert.deepEqual(
    Channel.all().map(({ name, branch, distTag, marketplace, registry }) => ({
      name,
      branch,
      distTag,
      marketplace,
      registry,
    })),
    [
      {
        name: "beta",
        branch: "main",
        distTag: "beta",
        marketplace: "superblocks",
        registry: "https://registry.npmjs.org/",
      },
      {
        name: "next",
        branch: "next",
        distTag: "next",
        marketplace: "superblocks-next",
        registry: "https://registry.npmjs.org/",
      },
      {
        name: "dev",
        branch: "master",
        distTag: "master",
        marketplace: "superblocks-dev",
        registry: "https://npm.pkg.github.com/",
      },
    ],
  );
  assert.throws(() => Channel.named("prod"), /Unknown channel/);
  assert.throws(() => Channel.named("dev").assertPublic(), /must not ship public artifacts/);
  assert.doesNotThrow(() => Channel.named("next").assertPublic());
  assert.equal(Channel.named("next").displayName("Superblocks (next)"), "Superblocks (next)");
});
