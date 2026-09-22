import { spawn } from "node:child_process";
import { constants } from "node:os";

const packageSpec = process.env.NPM_CONFIG_PACKAGE?.trim();
if (!packageSpec) {
  console.error("NPM_CONFIG_PACKAGE must select the Superblocks CLI package.");
  process.exit(1);
}
const packageMatch = packageSpec.match(
  /^@superblocksteam\/cli(?:@(.+))?$/,
);
if (!packageMatch) {
  console.error("NPM_CONFIG_PACKAGE must select @superblocksteam/cli.");
  process.exit(1);
}
const selector = packageMatch[1];
if (
  selector &&
  !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(selector) &&
  !/^file:[A-Za-z0-9_./:+-]+$/.test(selector)
) {
  console.error(
    "NPM_CONFIG_PACKAGE must use an exact version, tag, or file URL.",
  );
  process.exit(1);
}

const npxArgs = [
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
];
const windows = process.platform === "win32";
const child = spawn(
  windows ? (process.env.ComSpec ?? "cmd.exe") : "npx",
  windows ? ["/D", "/S", "/C", "npx.cmd", ...npxArgs] : npxArgs,
  {
    detached: !windows,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => name.toUpperCase() !== "NPM_CONFIG_PACKAGE",
      ),
    ),
    stdio: "inherit",
    windowsHide: true,
  },
);

const signals = [
  ...(windows ? [] : ["SIGHUP"]),
  "SIGINT",
  "SIGTERM",
];
const forwardSignal = (signal) => {
  if (child.pid === undefined) return;
  if (windows) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
};
const signalHandlers = Object.fromEntries(
  signals.map((signal) => [signal, () => forwardSignal(signal)]),
);
for (const signal of signals) {
  process.on(signal, signalHandlers[signal]);
}
child.once("error", (error) => {
  console.error(`Could not start the Superblocks CLI: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  for (const handledSignal of signals) {
    process.off(handledSignal, signalHandlers[handledSignal]);
  }
  if (signal) console.error(`Superblocks CLI terminated by ${signal}.`);
  process.exitCode =
    code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
});
