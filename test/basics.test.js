import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SERVER, serverUrl } from "../src/config.js";
import { pkcePair, randomState } from "../src/pkce.js";
import { Store } from "../src/store.js";

const tempDir = () => mkdtemp(join(tmpdir(), "sentrint-mcp-"));

test("the server defaults to the hosted endpoint", () => {
  assert.equal(serverUrl({}), DEFAULT_SERVER);
});

test("a server override must be https, or plain http on this computer", () => {
  assert.equal(serverUrl({ SENTRINT_MCP_URL: "http://127.0.0.1:8000/mcp" }), "http://127.0.0.1:8000/mcp");
  assert.equal(serverUrl({ SENTRINT_MCP_URL: "https://staging.example.com/mcp" }), "https://staging.example.com/mcp");
  assert.throws(() => serverUrl({ SENTRINT_MCP_URL: "http://example.com/mcp" }), /https/);
  assert.throws(() => serverUrl({ SENTRINT_MCP_URL: "not a url" }), /valid address/);
});

test("the PKCE challenge is the base64url SHA-256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(randomState(), randomState());
});

test("the store reads nothing as empty and survives a corrupt file", async () => {
  const store = new Store(await tempDir(), DEFAULT_SERVER);
  assert.deepEqual(await store.read(), {});
  await store.ensureDir();
  await writeFile(store.file, "{not json");
  assert.deepEqual(await store.read(), {});
});

test("the store writes a file only its owner can read", { skip: process.platform === "win32" }, async () => {
  const store = new Store(await tempDir(), DEFAULT_SERVER);
  await store.write({ tokens: { access_token: "a" } });
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await stat(store.dir)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(store.file, "utf8")), { tokens: { access_token: "a" } });
});

test("each server gets its own store file", async () => {
  const dir = await tempDir();
  assert.notEqual(new Store(dir, "https://a.example/mcp").file, new Store(dir, "https://b.example/mcp").file);
});

test("the lock lets one holder in at a time", async () => {
  const store = new Store(await tempDir(), DEFAULT_SERVER);
  const order = [];
  const hold = (name) =>
    store.withLock(async () => {
      order.push(`${name} in`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name} out`);
    });
  await Promise.all([hold("a"), hold("b")]);
  assert.deepEqual(order.slice(0, 2), [order[0], order[0].replace("in", "out")]);
});

test("a lock left by a dead process is taken over", async () => {
  const store = new Store(await tempDir(), DEFAULT_SERVER);
  await store.ensureDir();
  await writeFile(store.lockFile, "999999999:dead");
  assert.equal(await store.withLock(async () => "ran", { wait: 1000 }), "ran");
});

test("a lock held by a live process times out", async () => {
  const store = new Store(await tempDir(), DEFAULT_SERVER);
  await store.ensureDir();
  await writeFile(store.lockFile, `${process.pid}:someone-else`);
  await assert.rejects(store.withLock(async () => "ran", { wait: 300 }), { code: "LOCK_TIMEOUT" });
});
