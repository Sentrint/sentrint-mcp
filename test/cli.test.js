// End to end: the real bin, a fake MCP server on 127.0.0.1, a saved sign-in in a temp home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Store } from "../src/store.js";

const BIN = fileURLToPath(new URL("../bin/sentrint-mcp.js", import.meta.url));

function run(args, { env = {}, input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function fakeMcpServer() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, origin: req.headers.origin, body });
      const msg = JSON.parse(body);
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.method } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, seen, close: () => server.close() };
}

test("serve: every stdout line is a JSON-RPC message, logs stay on stderr", async () => {
  const mcp = await fakeMcpServer();
  try {
    const home = await mkdtemp(join(tmpdir(), "sentrint-cli-"));
    await new Store(home, mcp.url).write({
      client: { client_id: "c1", redirect_uri: "http://127.0.0.1:5555/callback" },
      tokens: { access_token: "saved", refresh_token: "rt", expires_at: Date.now() + 3_600_000 },
    });
    const input = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      "",
    ].join("\n");
    const { code, stdout } = await run([], { env: { SENTRINT_HOME: home, SENTRINT_MCP_URL: mcp.url }, input });
    assert.equal(code, 0);
    const lines = stdout.trim().split("\n");
    const messages = lines.map((l) => JSON.parse(l)); // throws if anything else reached stdout
    assert.deepEqual(messages.map((m) => m.id).sort(), [1, 2]);
    assert.ok(mcp.seen.every((s) => s.auth === "Bearer saved"));
    assert.ok(mcp.seen.every((s) => s.origin === undefined));
  } finally {
    mcp.close();
  }
});

test("--version prints the package version", async () => {
  const { code, stdout } = await run(["--version"]);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("an unknown command prints usage to stderr and exits 2", async () => {
  const { code, stdout, stderr } = await run(["nonsense"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /login/);
});
