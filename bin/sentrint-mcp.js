#!/usr/bin/env node
// stdout is the MCP channel. Anything else printed there breaks the agent. Logs go to stderr.
import { main } from "../src/cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`sentrint-mcp: ${err.message}\n`);
    process.exitCode = 1;
  },
);
