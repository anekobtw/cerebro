import { spawn, spawnSync } from "node:child_process";

const metroPort = "8081";
const loopbackHost = "127.0.0.1";

const reverse = spawnSync(
  "adb",
  ["reverse", `tcp:${metroPort}`, `tcp:${metroPort}`],
  { stdio: "inherit" },
);

if (reverse.error) {
  console.error(`Failed to run adb: ${reverse.error.message}`);
  process.exit(1);
}

if (reverse.status !== 0) {
  process.exit(reverse.status ?? 1);
}

const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("npm_execpath is unavailable; run this launcher through npm run dev.");
  process.exit(1);
}

const expo = spawn(
  process.execPath,
  [
    npmCli,
    "run",
    "android",
    "--workspace",
    "@blind-maps/mobile",
    "--",
    "--lan",
    "--port",
    metroPort,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      REACT_NATIVE_PACKAGER_HOSTNAME: loopbackHost,
    },
  },
);

expo.on("error", (error) => {
  console.error(`Failed to start Expo: ${error.message}`);
  process.exit(1);
});

expo.on("exit", (code) => {
  process.exit(code ?? 1);
});
