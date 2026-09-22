import { spawn } from "node:child_process";

const packageSpec = process.env.NPM_CONFIG_PACKAGE?.trim();
if (!packageSpec) {
  console.error("NPM_CONFIG_PACKAGE must select the Superblocks CLI package.");
  process.exit(1);
}
if (/[\s"'`$&|<>^()%!;]/.test(packageSpec)) {
  console.error("NPM_CONFIG_PACKAGE contains unsupported characters.");
  process.exit(1);
}

const child = spawn(
  "npx",
  [
    "--yes",
    "--prefer-online",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org/",
    "--@superblocksteam:registry=https://registry.npmjs.org/",
    `--package=${packageSpec}`,
    "--",
    "superblocks",
    "mcp",
    "serve",
  ],
  {
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => name.toUpperCase() !== "NPM_CONFIG_PACKAGE",
      ),
    ),
    shell: process.platform === "win32",
    stdio: "inherit",
    windowsHide: true,
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(`Could not start the Superblocks CLI: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode =
    code ?? { SIGINT: 130, SIGTERM: 143 }[signal ?? ""] ?? 1;
});
