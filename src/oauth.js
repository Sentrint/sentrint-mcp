// OAuth 2.1 for a public client: discovery, registration, PKCE authorize, token calls.

const TIMEOUT_MS = 30_000;

export class OAuthError extends Error {
  constructor(code, description, status) {
    super(description ? `${code}: ${description}` : code);
    this.code = code;
    this.status = status;
  }
}

async function getJson(fetchFn, url) {
  const res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.json();
}

function sameOrigin(value, origin, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Sign-in metadata has a bad ${name}.`);
  }
  if (url.origin !== origin) throw new Error(`Sign-in metadata points ${name} at another site; refusing.`);
  return url.href;
}

/** Read the protected resource and authorization server metadata. Every endpoint must sit on the MCP server's own site. */
export async function discover(serverUrl, fetchFn = fetch) {
  const server = new URL(serverUrl);
  const origin = server.origin;
  const prm = await getJson(fetchFn, new URL(`/.well-known/oauth-protected-resource${server.pathname.replace(/\/$/, "")}`, origin));
  const resource = sameOrigin(prm.resource, origin, "resource").replace(/\/$/, "");
  const issuer = new URL(sameOrigin(prm.authorization_servers?.[0], origin, "authorization server"));
  const as = await getJson(fetchFn, new URL(`/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`, origin));
  if (!(as.code_challenge_methods_supported ?? []).includes("S256")) {
    throw new Error("The sign-in server does not support S256 PKCE; refusing.");
  }
  return {
    resource,
    scopes: prm.scopes_supported ?? as.scopes_supported ?? [],
    authorizationEndpoint: sameOrigin(as.authorization_endpoint, origin, "authorization_endpoint"),
    tokenEndpoint: sameOrigin(as.token_endpoint, origin, "token_endpoint"),
    registrationEndpoint: sameOrigin(as.registration_endpoint, origin, "registration_endpoint"),
    revocationEndpoint: as.revocation_endpoint ? sameOrigin(as.revocation_endpoint, origin, "revocation_endpoint") : null,
  };
}

async function readError(res) {
  const body = await res.json().catch(() => ({}));
  return new OAuthError(body.error || `http_${res.status}`, body.error_description, res.status);
}

/** RFC 7591 dynamic registration as a public client with one loopback redirect. */
export async function registerClient(meta, redirectUri, fetchFn = fetch) {
  const res = await fetchFn(meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Sentrint local bridge",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: meta.scopes.join(" "),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res);
  const body = await res.json();
  if (typeof body.client_id !== "string") throw new Error("Registration returned no client_id.");
  return { client_id: body.client_id, redirect_uri: redirectUri };
}

export function authorizeUrl(meta, client, { state, challenge }) {
  const url = new URL(meta.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", client.redirect_uri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", meta.scopes.join(" "));
  url.searchParams.set("resource", meta.resource);
  return url.href;
}

async function tokenCall(meta, params, fetchFn, now, previousRefresh = null) {
  const res = await fetchFn(meta.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...params, resource: meta.resource }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await readError(res);
  const body = await res.json();
  if (typeof body.access_token !== "string" || String(body.token_type).toLowerCase() !== "bearer") {
    throw new Error("The token response was not a bearer token.");
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? previousRefresh,
    expires_at: Number.isFinite(body.expires_in) ? now() + body.expires_in * 1000 : null,
  };
}

export function exchangeCode(meta, client, { code, verifier }, fetchFn = fetch, now = Date.now) {
  return tokenCall(
    meta,
    { grant_type: "authorization_code", code, redirect_uri: client.redirect_uri, client_id: client.client_id, code_verifier: verifier },
    fetchFn,
    now,
  );
}

export function refreshTokens(meta, client, refreshToken, fetchFn = fetch, now = Date.now) {
  return tokenCall(meta, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.client_id }, fetchFn, now, refreshToken);
}

/** RFC 7009. Best effort: a failed revoke never blocks a logout. */
export async function revokeToken(meta, client, token, fetchFn = fetch) {
  if (!meta.revocationEndpoint) return;
  await fetchFn(meta.revocationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: client.client_id }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {});
}
