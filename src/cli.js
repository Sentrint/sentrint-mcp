import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { TokenManager } from "./auth.js";
import { Bridge } from "./bridge.js";
import { homeDir, serverUrl } from "./config.js";
import { Store } from "./store.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const BIN = fileURLToPath(new URL("../bin/sentrint-mcp.js", import.meta.url));

const USAGE = `Usage: sentrint-mcp [command]

  (no command)  Run the bridge. Your coding agent starts this for you.
  login         Sign in to Sentrint in your browser. Do this once before first use.
  logout        Sign out and delete the saved sign-in.
  --version     Print the version.

Docs: https://sentrint.com/wiki/mcp`;

// stdout belongs to the agent. Everything a person should read goes to stderr.
const log = (message) => process.stderr.write(`sentrint-mcp: ${message}\n`);

function manager(interactive) {
  const server = serverUrl();
  const store = new Store(homeDir(), server);
  return new TokenManager({
    serverUrl: server,
    store,
    log,
    interactive,
    // Inside an agent, sign-in runs as its own process: if the agent gives up on the
    // first request and stops the bridge, the browser sign-in still finishes.
    startSignIn: () => {
      const child = spawn(process.execPath, [BIN, "login"], { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => {});
      child.unref();
    },
  });
}

async function serve() {
  const tokens = manager(false);
  const bridge = new Bridge({
    serverUrl: tokens.serverUrl,
    tokens,
    write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    log,
  });
  const pending = new Set();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const job = bridge.handleLine(line).finally(() => pending.delete(job));
    pending.add(job);
  });
  await once(lines, "close");
  await Promise.allSettled([...pending]);
  return 0;
}

async function login() {
  const tokens = manager(true);
  await tokens.getToken();
  log("Signed in. Your coding agent can use Sentrint now.");
  return 0;
}

async function logout() {
  await manager(true).logout();
  log("Signed out.");
  return 0;
}

export async function main(argv) {
  const [command = "serve", ...rest] = argv;
  if (rest.length) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  switch (command) {
    case "serve":
      return serve();
    case "login":
      return login();
    case "logout":
      return logout();
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "--help":
    case "-h":
      process.stderr.write(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}
