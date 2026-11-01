import { test } from "node:test";
import assert from "node:assert/strict";

import { Bridge } from "../src/bridge.js";
import { SignInRequired } from "../src/auth.js";
import { SERVER, fakeFetch, json, silent } from "./helpers.js";

function setup(routes, tokens = {}) {
  const out = [];
  const fetchFn = fakeFetch(routes.length ? [[SERVER, routes[0]]] : []);
  const tokenManager = {
    getToken: async () => "t1",
    renew: async () => "t2",
    ...tokens,
  };
  const bridge = new Bridge({ serverUrl: SERVER, tokens: tokenManager, fetchFn, write: (m) => out.push(m), log: silent });
  return { bridge, out, fetchFn };
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };

test("a request is forwarded with the token and its reply written back", async () => {
  const { bridge, out, fetchFn } = setup([() => json({ jsonrpc: "2.0", id: 1, result: { ok: true } })]);
  await bridge.handleLine(JSON.stringify(INIT));
  assert.deepEqual(out, [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  const call = fetchFn.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.headers.get("authorization"), "Bearer t1");
  assert.match(call.headers.get("accept"), /application\/json/);
  assert.match(call.headers.get("accept"), /text\/event-stream/);
  assert.equal(call.body, JSON.stringify(INIT));
});

test("no Origin header is ever sent: the server refuses any origin but its own", async () => {
  const { bridge, fetchFn } = setup([() => json({ jsonrpc: "2.0", id: 1, result: {} })]);
  await bridge.handleLine(JSON.stringify(INIT));
  assert.equal(fetchFn.calls[0].headers.get("origin"), null);
});

test("a notification answered with 202 writes nothing", async () => {
  const { bridge, out } = setup([() => new Response(null, { status: 202 })]);
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.deepEqual(out, []);
});

test("after initialize, the negotiated protocol version rides on every request", async () => {
  const { bridge, fetchFn } = setup([
    (call) => call.body.includes('"initialize"')
      ? json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } })
      : json({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
  ]);
  await bridge.handleLine(JSON.stringify(INIT));
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assert.equal(fetchFn.calls[0].headers.get("mcp-protocol-version"), null);
  assert.equal(fetchFn.calls[1].headers.get("mcp-protocol-version"), "2025-06-18");
});

test("a 401 renews the token once and retries", async () => {
  let renewedWith = null;
  const { bridge, out, fetchFn } = setup(
    [(call) => call.headers.get("authorization") === "Bearer t1"
      ? new Response(null, { status: 401 })
      : json({ jsonrpc: "2.0", id: 1, result: { ok: true } })],
    { renew: async (stale) => { renewedWith = stale; return "t2"; } },
  );
  await bridge.handleLine(JSON.stringify(INIT));
  assert.equal(renewedWith, "t1");
  assert.equal(fetchFn.calls.length, 2);
  assert.deepEqual(out, [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});

test("a second 401 becomes an error, never a retry loop", async () => {
  const { bridge, out, fetchFn } = setup([() => new Response(null, { status: 401 })]);
  await bridge.handleLine(JSON.stringify(INIT));
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, /401/);
});

test("a server error answers the request with a JSON-RPC error carrying its id", async () => {
  const { bridge, out } = setup([() => new Response("boom", { status: 500 })]);
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "tools/list" }));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "abc");
  assert.equal(out[0].error.code, -32603);
  assert.match(out[0].error.message, /500/);
});

test("a failed notification writes nothing, because nobody waits for it", async () => {
  const { bridge, out } = setup([() => new Response("boom", { status: 500 })]);
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }));
  assert.deepEqual(out, []);
});

test("a line that is not JSON gets a parse error", async () => {
  const { bridge, out, fetchFn } = setup([]);
  await bridge.handleLine("{oops");
  assert.deepEqual(out, [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
  assert.equal(fetchFn.calls.length, 0);
});

test("blank lines are ignored", async () => {
  const { bridge, out, fetchFn } = setup([]);
  await bridge.handleLine("   ");
  assert.deepEqual(out, []);
  assert.equal(fetchFn.calls.length, 0);
});

test("sign-in trouble reaches the agent as a readable error", async () => {
  const { bridge, out, fetchFn } = setup([], { getToken: async () => { throw new SignInRequired("Finish signing in to Sentrint in your browser, then reconnect."); } });
  await bridge.handleLine(JSON.stringify(INIT));
  assert.equal(fetchFn.calls.length, 0);
  assert.match(out[0].error.message, /browser/);
});

test("an event-stream reply is unpacked into its messages", async () => {
  const sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
  const { bridge, out } = setup([() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })]);
  await bridge.handleLine(JSON.stringify(INIT));
  assert.deepEqual(out, [{ jsonrpc: "2.0", id: 1, result: {} }]);
});

test("a network failure answers the request instead of crashing", async () => {
  const out = [];
  const bridge = new Bridge({
    serverUrl: SERVER,
    tokens: { getToken: async () => "t1", renew: async () => "t2" },
    fetchFn: async () => { throw new TypeError("fetch failed"); },
    write: (m) => out.push(m),
    log: silent,
  });
  await bridge.handleLine(JSON.stringify(INIT));
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, /reach Sentrint/);
});
