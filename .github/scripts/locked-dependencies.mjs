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
        throw this.#rejection(
          path,
          `expected an exact reviewed entry, found version ${entry.version}`,
          "addition",
        );
      if (isDeepStrictEqual(previous, entry)) continue;
      const intended = name === "@superblocksteam/cli" ? cliVersion : this.overrides.get(name);
      if (previous.resolved) {
        const expected = new URL(previous.resolved).origin;
        const found = entry.resolved ? new URL(entry.resolved).origin : "<missing>";
        if (expected !== found)
          throw this.#rejection(path, `registry expected ${expected}, found ${found}`);
      }
      if (entry.version === previous.version) {
        const fields = [...new Set([...Object.keys(previous), ...Object.keys(entry)])].filter(
          (key) => !isDeepStrictEqual(previous[key], entry[key]),
        );
        const integrity =
          previous.integrity === entry.integrity
            ? ""
            : `; integrity expected ${previous.integrity ?? "<absent>"}, found ${entry.integrity ?? "<absent>"}`;
        throw this.#rejection(
          path,
          `same-version metadata changed at ${entry.version}: ${fields.join(", ")}${integrity}`,
        );
      }
      if (entry.version !== intended)
        throw this.#rejection(
          path,
          `version expected ${intended ?? previous.version} (previous ${previous.version}), found ${entry.version}`,
        );
    }
  }

  #rejection(path, reason, kind = "change") {
    return new Error(
      `Unreviewed dependency ${kind}: ${path}; ${reason}. Update the lockfile in a reviewed PR.`,
    );
  }
}
