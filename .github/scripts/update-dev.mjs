import { execFileSync } from "node:child_process";

execFileSync(
  "gh",
  [
    "workflow",
    "run",
    "update-dev.yml",
    "--repo",
    "superblocksteam/claude-marketplace",
    "--ref",
    "main",
  ],
  { stdio: "inherit" },
);
console.log(
  "Dev pin update requested. Follow https://github.com/superblocksteam/claude-marketplace/actions/workflows/update-dev.yml for verification and publication.",
);
