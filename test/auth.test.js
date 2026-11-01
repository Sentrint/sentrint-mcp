import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SignInRequired, TokenManager } from "../src/auth.js";
import { Store } from "../src/store.js";
import { AS, SERVER, discoveryRoutes, fakeFetch, json, silent } from "./helpers.js";

const NOW = 10_000_000;
const now = () => NOW;
const tempStore = async () => new Store(await mkdtemp(join(tmpdir(), "sentrint-auth-")), SERVER);
const CLIENT = { client_id: "c1", redirect_uri: "http://127.0.0.1:5555/callback" };

function manager(store, fetchFn, extra = {}) {
  return new TokenManager({ serverUrl: SERVER, store, fetchFn, log: silent, now, interactive: false, startSignIn: () => {}, ...extra });
}

test("a fresh saved token is used without any network call", async () => {
  const store = await tempStore();
  await store.write({ client: CLIENT, tokens: { access_token: "live", refresh_token: "rt", expires_at: NOW + 600_000 } });
  const fetchFn = fakeFetch([]);
  assert.equal(await manager(store, fetchFn).getToken(), "live");
  assert.equal(fetchFn.calls.length, 0);
});

test("two processes with an expired token make exactly one refresh", async () => {
  // Rotation means a second refresh with the same token would end the whole grant.
  const store = await tempStore();
  await store.write({ client: CLIENT, tokens: { access_token: "old", refresh_token: "rt1", expires_at: NOW - 1 } });
  let refreshes = 0;
  const fetchFn = fakeFetch([
    ...discoveryRoutes,
    [AS.token_endpoint, async () => {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 40));
      return json({ access_token: `new${refreshes}`, refresh_token: `rt${refreshes + 1}`, token_type: "Bearer", expires_in: 3600 });
    }],
  ]);
  const a = manager(store, fetchFn);
  const b = manager(store, fetchFn); // a second process: its own manager, the same store file
  const [ta, tb] = await Promise.all([a.getToken(), b.getToken()]);
  assert.equal(refreshes, 1);
  assert.equal(ta, "new1");
  assert.equal(tb, "new1");
  assert.equal((await store.read()).tokens.refresh_token, "rt2");
});

test("a 401 on a token that looked fresh triggers one refresh, not a loop", async () => {
  const store = await tempStore();
  await store.write({ client: CLIENT, tokens: { access_token: "revoked", refresh_token: "rt1", expires_at: NOW + 600_000 } });
  const fetchFn = fakeFetch([
    ...discoveryRoutes,
    [AS.token_endpoint, () => json({ access_token: "fresh", refresh_token: "rt2", token_type: "Bearer", expires_in: 3600 })],
  ]);
  const m = manager(store, fetchFn);
  assert.equal(await m.renew("revoked"), "fresh");
  const form = new URLSearchParams(fetchFn.calls.at(-1).body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "rt1");
});

test("a dead grant in the agent starts a browser sign-in and fails fast", async () => {
  const store = await tempStore();
  await store.write({ client: CLIENT, tokens: { access_token: "old", refresh_token: "dead", expires_at: NOW - 1 } });
  const fetchFn = fakeFetch([
    ...discoveryRoutes,
    [AS.token_endpoint, () => json({ error: "invalid_grant" }, 400)],
  ]);
  let started = 0;
  const m = manager(store, fetchFn, { startSignIn: () => { started += 1; } });
  await assert.rejects(m.getToken(), SignInRequired);
  await assert.rejects(m.getToken(), SignInRequired);
  assert.equal(started, 1, "the browser opens once per process, not once per request");
  assert.equal((await store.read()).tokens, undefined, "the dead tokens are dropped");
});

test("with nothing saved, the agent path starts sign-in without waiting for it", async () => {
  const store = await tempStore();
  let started = 0;
  const m = manager(store, fakeFetch([]), { startSignIn: () => { started += 1; } });
  const err = await m.getToken().catch((e) => e);
  assert.ok(err instanceof SignInRequired);
  assert.match(err.message, /browser/);
  assert.match(err.message, /npx -y @sentrint\/mcp login/, "a way out when no browser opens");
  assert.equal(started, 1);
});

test("the agent path does not hang behind a sign-in held by another process", async () => {
  const store = await tempStore();
  await store.ensureDir();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(store.lockFile, `${process.pid}:login-in-progress`);
  await store.write({ client: CLIENT, tokens: { access_token: "old", refresh_token: "rt", expires_at: NOW - 1 } });
  const m = manager(store, fakeFetch([]), { lockWait: 200 });
  const err = await m.getToken().catch((e) => e);
  assert.ok(err instanceof SignInRequired);
  assert.match(err.message, /in progress/);
  assert.match(err.message, /npx -y @sentrint\/mcp login/);
});

test("a full interactive sign-in: register, browser, callback, exchange, save", async () => {
  const store = await tempStore();
  const fetchFn = fakeFetch([
    ...discoveryRoutes,
    [AS.registration_endpoint, (call) => json({ client_id: "fresh-client", redirect_uris: JSON.parse(call.body).redirect_uris }, 201)],
    [AS.token_endpoint, () => json({ access_token: "signed-in", refresh_token: "rt", token_type: "Bearer", expires_in: 3600 })],
  ]);
  let opened = null;
  const openBrowser = (url) => {
    opened = new URL(url);
    // Play the browser: the user approves and the server redirects to the loopback address.
    const back = new URL(opened.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", opened.searchParams.get("state"));
    setTimeout(() => fetch(back), 10);
    return true;
  };
  const m = manager(store, fetchFn, { interactive: true, openBrowser });
  assert.equal(await m.getToken(), "signed-in");
  assert.equal(opened.searchParams.get("client_id"), "fresh-client");
  const saved = await store.read();
  assert.equal(saved.client.client_id, "fresh-client");
  assert.equal(saved.client.redirect_uri, opened.searchParams.get("redirect_uri"));
  assert.equal(saved.tokens.access_token, "signed-in");
  const exchange = new URLSearchParams(fetchFn.calls.at(-1).body);
  assert.equal(exchange.get("code"), "the-code");
  assert.ok(exchange.get("code_verifier"));
});

test("logout revokes the refresh token and forgets everything", async () => {
  const store = await tempStore();
  await store.write({ client: CLIENT, tokens: { access_token: "a", refresh_token: "rt", expires_at: NOW + 1 } });
  const fetchFn = fakeFetch([...discoveryRoutes, [AS.revocation_endpoint, () => new Response(null, { status: 200 })]]);
  await manager(store, fetchFn).logout();
  const form = new URLSearchParams(fetchFn.calls.at(-1).body);
  assert.equal(form.get("token"), "rt");
  assert.deepEqual(await store.read(), {});
});
