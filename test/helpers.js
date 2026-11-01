// Shared fakes. Nothing here talks to the network: every test passes a fake fetch.

export const SERVER = "https://sentrint.test/mcp";

export const PRM = {
  resource: "https://sentrint.test/mcp",
  authorization_servers: ["https://sentrint.test/"],
  scopes_supported: ["findings:read", "scans:create", "scans:read"],
};

export const AS = {
  issuer: "https://sentrint.test/",
  authorization_endpoint: "https://sentrint.test/authorize",
  token_endpoint: "https://sentrint.test/token",
  registration_endpoint: "https://sentrint.test/register",
  revocation_endpoint: "https://sentrint.test/revoke",
  code_challenge_methods_supported: ["S256"],
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fake fetch that records every call and answers from a list of route handlers. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const href = String(url);
    const headers = new Headers(init.headers);
    const body = init.body === undefined ? undefined : String(init.body);
    const call = { url: href, method: init.method ?? "GET", headers, body };
    calls.push(call);
    for (const [match, handler] of routes) {
      if (typeof match === "string" ? href === match : match.test(href)) return handler(call, calls);
    }
    throw new Error(`fake fetch: no route for ${call.method} ${href}`);
  };
  fn.calls = calls;
  return fn;
}

export const discoveryRoutes = [
  ["https://sentrint.test/.well-known/oauth-protected-resource/mcp", () => json(PRM)],
  ["https://sentrint.test/.well-known/oauth-authorization-server", () => json(AS)],
];

export const silent = () => {};
