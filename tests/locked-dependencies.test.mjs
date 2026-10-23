import assert from "node:assert/strict";
import test from "node:test";

import { LockedDependencies } from "../.github/scripts/locked-dependencies.mjs";

const original = {
  packages: {
    "node_modules/@superblocksteam/cli": {
      version: "1.0.0",
      resolved: "https://npm.pkg.github.com/cli/1.0.0",
      integrity: "old-cli",
    },
    "node_modules/qs": {
      version: "6.15.0",
      resolved: "https://registry.npmjs.org/qs/-/qs-6.15.0.tgz",
      integrity: "old-qs",
    },
    "node_modules/unrelated": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/unrelated/-/unrelated-1.0.0.tgz",
      integrity: "original",
    },
  },
};

test("security resolution keeps unrelated locked versions and admits only exact reviewed additions", () => {
  const reviewed = {
    version: "3.0.12",
    resolved: "https://registry.npmjs.org/provider/-/provider-3.0.12.tgz",
    integrity: "reviewed-provider",
  };
  const candidate = structuredClone(original);
  candidate.packages["node_modules/unrelated"].version = "1.0.1";
  candidate.packages["node_modules/fixed/node_modules/provider"] = reviewed;
  const policy = new LockedDependencies(
    original,
    {},
    { packages: { "node_modules/provider": reviewed } },
  );
  policy.constrain(candidate, "1.0.0");
  assert.equal(candidate.packages["node_modules/unrelated"].version, "1.0.0");
  assert.doesNotThrow(() => policy.assertUpdate(candidate, "1.0.0"));
  candidate.packages["node_modules/fixed/node_modules/provider"] = {
    ...reviewed,
    integrity: "unexpected",
  };
  assert.throws(() => policy.assertUpdate(candidate, "1.0.0"), /Unreviewed dependency addition/);
});

test("lock updates allow the intended CLI and explicit security fix", () => {
  const candidate = structuredClone(original);
  candidate.packages["node_modules/@superblocksteam/cli"] = {
    version: "1.0.1",
    resolved: "https://npm.pkg.github.com/cli/1.0.1",
    integrity: "new-cli",
  };
  candidate.packages["node_modules/qs"] = {
    version: "6.16.0",
    resolved: "https://registry.npmjs.org/qs/-/qs-6.16.0.tgz",
    integrity: "fixed-qs",
  };
  assert.doesNotThrow(() =>
    new LockedDependencies(original, { "qs@>=6 <6.16.0": "6.16.0" }).assertUpdate(
      candidate,
      "1.0.1",
    ),
  );
});

test("scoped override selectors cannot authorize a different package or changed same-version integrity", () => {
  const entry = {
    version: "4.0.15",
    resolved: "https://registry.npmjs.org/@ai-sdk/provider-utils/-/provider-utils-4.0.15.tgz",
    integrity: "old-utils",
  };
  const originalLock = {
    packages: { "node_modules/ai/node_modules/@ai-sdk/provider-utils": entry },
  };
  const policy = new LockedDependencies(originalLock, {
    "@ai-sdk/provider-utils@>=4.0.0-beta.10 <4.0.33": "4.0.33",
  });
  const candidate = {
    packages: {
      "node_modules/ai/node_modules/@ai-sdk/provider-utils": {
        ...entry,
        version: "4.0.33",
        resolved: "https://registry.npmjs.org/@ai-sdk/provider-utils/-/provider-utils-4.0.33.tgz",
        integrity: "fixed-utils",
      },
    },
  };
  assert.doesNotThrow(() => policy.assertUpdate(candidate, "1.0.0"));
  candidate.packages["node_modules/ai/node_modules/@ai-sdk/provider-utils"] = {
    ...entry,
    integrity: "changed-same-version",
  };
  assert.throws(() => policy.assertUpdate(candidate, "1.0.0"), /Unreviewed dependency change/);
  const moved = { packages: { "node_modules/unrelated": { ...entry, version: "4.0.33" } } };
  assert.throws(() => policy.assertUpdate(moved, "1.0.0"), /Unreviewed dependency addition/);
});

test("lock updates reject unrelated versions, new packages, registry changes, and same-version integrity changes", () => {
  for (const [description, path, patch] of [
    ["unrelated version", "node_modules/unrelated", { version: "1.0.1" }],
    ["new package", "node_modules/new", { version: "1.0.0" }],
    [
      "registry change",
      "node_modules/@superblocksteam/cli",
      { version: "1.0.1", resolved: "https://registry.npmjs.org/cli" },
    ],
    ["integrity change", "node_modules/unrelated", { integrity: "replaced" }],
  ]) {
    const candidate = structuredClone(original);
    candidate.packages[path] = { ...candidate.packages[path], ...patch };
    assert.throws(
      () => new LockedDependencies(original).assertUpdate(candidate, "1.0.1"),
      /Unreviewed dependency/,
      description,
    );
  }
});
