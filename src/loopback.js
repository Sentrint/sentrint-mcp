import { createServer } from "node:http";

import { OAuthError } from "./oauth.js";

const PAGE = (text) =>
  `<!doctype html><meta charset="utf-8"><title>Sentrint</title>` +
  `<body style="font:16px system-ui,sans-serif;background:#0E141F;color:#e8e6da;display:grid;place-items:center;height:100vh;margin:0">` +
  `<p>${text}</p></body>`;

/**
 * Listen on 127.0.0.1 for the one redirect that ends a sign-in. Only a request with
 * the expected state counts, and only the first one: a reused code ends the grant.
 */
export function listenForCode({ port = 0, state, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolveListen, rejectListen) => {
    let settle;
    const code = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    code.catch(() => {}); // the caller may never await it if setup fails
    let done = false;

    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const reply = (status, text) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE(text));
      };
      if (req.method !== "GET" || url.pathname !== "/callback") return reply(404, "Not found.");
      if (done) return reply(409, "This sign-in is already finished. You can close this tab.");
      if (url.searchParams.get("state") !== state) return reply(400, "This sign-in link does not match. Start again from your terminal.");
      done = true;
      const error = url.searchParams.get("error");
      const value = url.searchParams.get("code");
      if (error || !value) {
        reply(400, "Sign-in was cancelled. You can close this tab.");
        settle.reject(new OAuthError(error || "missing_code", url.searchParams.get("error_description")));
      } else {
        reply(200, "Signed in to Sentrint. You can close this tab.");
        settle.resolve(value);
      }
      close();
    });

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        settle.reject(new Error("Sign-in timed out after 5 minutes."));
      }
      close();
    }, timeoutMs);
    timer.unref();

    function close() {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    }

    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolveListen({ redirectUri: `http://127.0.0.1:${actual}/callback`, code, close });
    });
  });
}
