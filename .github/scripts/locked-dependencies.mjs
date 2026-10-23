import { isDeepStrictEqual } from "node:util";

export class LockedDependencies {
  constructor(lock, overrides = {}, reviewed = { packages: {} }) {
    this.packages = lock.packages;
    this.reviewed = Object.entries(reviewed.packages);
    this.overrides = new Map(
      Object.entries(overrides).map(([selector, version]) => [
        selector.slice(
          0,
          selector.lastIndexOf("@") > 0 ? selector.lastIndexOf("@") : selector.length,
        ),
        version,
      ]),
    );
  }

  constrain(lock, cliVersion) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      const previous = this.packages[path];
      if (!path || !previous || entry.version === previous.version) continue;
      const name = path.split("node_modules/").at(-1);
      const intended = name === "@superblocksteam/cli" ? cliVersion : this.overrides.get(name);
      if (entry.version !== intended) lock.packages[path] = structuredClone(previous);
    }
  }

  assertUpdate(lock, cliVersion) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue;
      const previous = this.packages[path];
      const name = path.split("node_modules/").at(-1);
      if (
        !previous &&
        this.reviewed.some(
          ([reviewedPath, reviewedEntry]) =>
            reviewedPath.split("node_modules/").at(-1) === name &&
            isDeepStrictEqual(reviewedEntry, entry),
        )
      )
        continue;
      if (!previous)
        throw new Error(
          `Unreviewed dependency addition: ${path}. Update the lockfile in a reviewed PR.`,
        );
      if (isDeepStrictEqual(previous, entry)) continue;
      const intended = name === "@superblocksteam/cli" ? cliVersion : this.overrides.get(name);
      if (
        entry.version !== intended ||
        entry.version === previous.version ||
        (previous.resolved && new URL(previous.resolved).origin !== new URL(entry.resolved).origin)
      )
        throw new Error(
          `Unreviewed dependency change: ${path}. Update the lockfile in a reviewed PR.`,
        );
    }
  }
}
