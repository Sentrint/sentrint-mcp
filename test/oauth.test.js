import { test } from "node:test";
import assert from "node:assert/strict";

import { authorizeUrl, discover, exchangeCode, OAuthError, refreshTokens, registerClient } from "../src/oauth.js";
import { listenForCode } from "../src/loopback.js";
import { AS, PRM, SERVER, discoveryRoutes, fakeFetch, json } from "./helpers.js";

test("discovery reads the resource and the sign-in endpoints", async () => {
  const meta = await discover(SERVER, fakeFetch(discoveryRoutes));
  assert.equal(meta.resource, "https://sentrint.test/mcp");
  assert.equal(meta.tokenEndpoint, AS.token_endpoint);
  assert.deepEqual(meta.scopes, PRM.scopes_supported);
});

test("discovery refuses sign-in endpoints on another site", async () => {
  const evil = { ...AS, token_endpoint: "https://evil.example/token" };
  const fetchFn = fakeFetch([discoveryRoutes[0], [discoveryRoutes[1][0], () => json(evil)]]);
  await assert.rejects(discover(SERVER, fetchFn), /token_endpoint/);
});

test("discovery refuses a server without S256 PKCE", async () => {
  const weak = { ...AS, code_challenge_methods_supported: ["plain"] };
  const fetchFn = fakeFetch([discoveryRoutes[0], [discoveryRoutes[1][0], () => json(weak)]]);
  await assert.rejects(discover(SERVER, fetchFn), /S256/);
});

test("registration asks to be a public client with one loopback redirect", async () => {
  const fetchFn = fakeFetch([
    ...discoveryRoutes,
    [AS.registration_endpoint, () => json({ client_id: "c1" }, 201)],
  ]);
  const meta = await discover(SERVER, fetchFn);
  const client = await registerClient(meta, "http://127.0.0.1:5555/callback", fetchFn);
  assert.deepEqual(client, { client_id: "c1", redirect_uri: "http://127.0.0.1:5555/callback" });
  const sent = JSON.parse(fetchFn.calls.at(-1).body);
  assert.equal(sent.token_endpoint_auth_method, "none");
  assert.deepEqual(sent.redirect_uris, ["http://127.0.0.1:5555/callback"]);
  assert.deepEqual(sent.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(sent.scope, PRM.scopes_supported.join(" "));
});

test("the authorize link carries PKCE, state and the exact resource", async () => {
  const meta = await discover(SERVER, fakeFetch(discoveryRoutes));
  const url = new URL(authorizeUrl(meta, { client_id: "c1", redirect_uri: "http://127.0.0.1:5555/callback" }, { state: "s", challenge: "ch" }));
  assert.equal(url.origin + url.pathname, AS.authorization_endpoint);
  assert.equal(url.searchParams.get("code_challenge"), "ch");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "s");
  assert.equal(url.searchParams.get("resource"), "https://sentrint.test/mcp");
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("the code exchange sends the verifier and resource, and dates the token", async () => {
  const fetchFn = fakeFetch([
    ...discoveryRoutes,
    [AS.token_endpoint, () => json({ access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 3600 })],
  ]);
  const meta = await discover(SERVER, fetchFn);
  const client = { client_id: "c1", redirect_uri: "http://127.0.0.1:5555/callback" };
  const tokens = await exchangeCode(meta, client, { code: "abc", verifier: "v" }, fetchFn, () => 1_000);
  assert.deepEqual(tokens, { access_token: "at", refresh_token: "rt", expires_at: 1_000 + 3_600_000 });
  const form = new URLSearchParams(fetchFn.calls.at(-1).body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code_verifier"), "v");
  assert.equal(form.get("resource"), "https://sentrint.test/mcp");
  assert.equal(form.get("redirect_uri"), client.redirect_uri);
  assert.equal(fetchFn.calls.at(-1).headers.get("content-type"), "application/x-www-form-urlencoded");
});

test("a refused grant becomes an OAuthError with its code", async () => {
  const fetchFn = fakeFetch([
    ...discoveryRoutes,
    [AS.token_endpoint, () => json({ error: "invalid_grant", error_description: "expired" }, 400)],
  ]);
  const meta = await discover(SERVER, fetchFn);
  const err = await refreshTokens(meta, { client_id: "c1" }, "rt", fetchFn).catch((e) => e);
  assert.ok(err instanceof OAuthError);
  assert.equal(err.code, "invalid_grant");
});

test("a refresh keeps the old refresh token if the server sends none", async () => {
  const fetchFn = fakeFetch([
    ...discoveryRoutes,
    [AS.token_endpoint, () => json({ access_token: "at2", token_type: "bearer" })],
  ]);
  const meta = await discover(SERVER, fetchFn);
  const tokens = await refreshTokens(meta, { client_id: "c1" }, "rt", fetchFn);
  assert.deepEqual(tokens, { access_token: "at2", refresh_token: "rt", expires_at: null });
});

// The loopback listener: a real HTTP server on 127.0.0.1, hit with real requests.

test("the callback ignores a wrong state and accepts the right one exactly once", async () => {
  const listener = await listenForCode({ port: 0, state: "good" });
  try {
    assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const wrong = await fetch(`${listener.redirectUri}?code=x&state=bad`);
    assert.equal(wrong.status, 400);
    const right = await fetch(`${listener.redirectUri}?code=the-code&state=good`);
    assert.equal(right.status, 200);
    assert.equal(await listener.code, "the-code");
  } finally {
    listener.close();
  }
});

test("a second callback after success is refused, so the code is never exchanged twice", async () => {
  const listener = await listenForCode({ port: 0, state: "good" });
  try {
    await fetch(`${listener.redirectUri}?code=one&state=good`);
    assert.equal(await listener.code, "one");
    const again = await fetch(`${listener.redirectUri}?code=two&state=good`).catch(() => null);
    assert.ok(again === null || again.status === 409);
  } finally {
    listener.close();
  }
});

test("a cancelled sign-in rejects with the server's error", async () => {
  const listener = await listenForCode({ port: 0, state: "good" });
  try {
    const settled = listener.code.catch((e) => e);
    await fetch(`${listener.redirectUri}?error=access_denied&state=good`);
    const err = await settled;
    assert.ok(err instanceof OAuthError);
    assert.equal(err.code, "access_denied");
  } finally {
    listener.close();
  }
});

test("a busy port fails with EADDRINUSE so the caller can register a new one", async () => {
  const first = await listenForCode({ port: 0, state: "a" });
  const port = Number(new URL(first.redirectUri).port);
  try {
    await assert.rejects(listenForCode({ port, state: "b" }), { code: "EADDRINUSE" });
  } finally {
    first.close();
  }
});
