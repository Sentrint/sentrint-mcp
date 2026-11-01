import { openBrowser as defaultOpenBrowser } from "./browser.js";
import { listenForCode } from "./loopback.js";
import { authorizeUrl, discover, exchangeCode, OAuthError, refreshTokens, registerClient, revokeToken } from "./oauth.js";
import { pkcePair, randomState } from "./pkce.js";
import { LockTimeout } from "./store.js";

const EARLY_MS = 60_000; // refresh a minute before the server says the token expires

export class SignInRequired extends Error {}

const usable = (tokens, now) =>
  Boolean(tokens?.access_token) && (tokens.expires_at == null || tokens.expires_at - EARLY_MS > now);

/** The grant is gone for good: sign in again rather than retrying. */
const isDead = (err) => err instanceof OAuthError && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(err.code);

/**
 * Hands out a valid access token. Refreshing happens under the store's lock and
 * re-reads the store first, because the server rotates refresh tokens and ends the
 * whole grant if a used one comes back: two processes must never refresh with the
 * same token.
 *
 * interactive: true (the `login` command) opens the browser and waits.
 * interactive: false (inside an agent) never waits on a person: it calls
 * startSignIn once and fails the request with a readable message.
 */
export class TokenManager {
  constructor({ serverUrl, store, fetchFn = fetch, log, now = Date.now, interactive, startSignIn, openBrowser = defaultOpenBrowser, lockWait }) {
    this.serverUrl = serverUrl;
    this.store = store;
    this.fetch = fetchFn;
    this.log = log;
    this.now = now;
    this.interactive = interactive;
    this.startSignIn = startSignIn;
    this.openBrowser = openBrowser;
    this.lockWait = lockWait ?? (interactive ? 10 * 60_000 : 15_000);
    this.pending = null;
    this.signInStarted = false;
    this.metaPromise = null;
  }

  meta() {
    this.metaPromise ??= discover(this.serverUrl, this.fetch).catch((err) => {
      this.metaPromise = null;
      throw err;
    });
    return this.metaPromise;
  }

  async getToken() {
    const { tokens } = await this.store.read();
    if (usable(tokens, this.now())) return tokens.access_token;
    return this.renew(tokens?.access_token);
  }

  /** Get a new token. `stale` is the one the server just refused, if any. */
  renew(stale) {
    this.pending ??= this.#renew(stale).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async #renew(stale) {
    try {
      return await this.store.withLock(() => this.#renewLocked(stale), { wait: this.lockWait });
    } catch (err) {
      if (err instanceof LockTimeout && !this.interactive) {
        throw new SignInRequired("A Sentrint sign-in is in progress in your browser. Finish it, then try again.");
      }
      throw err;
    }
  }

  async #renewLocked(stale) {
    let data = await this.store.read();
    const { tokens, client } = data;
    if (usable(tokens, this.now()) && tokens.access_token !== stale) return tokens.access_token; // another process refreshed
    if (tokens?.refresh_token && client) {
      try {
        const fresh = await refreshTokens(await this.meta(), client, tokens.refresh_token, this.fetch, this.now);
        await this.store.write({ ...data, tokens: fresh });
        return fresh.access_token;
      } catch (err) {
        if (!isDead(err)) throw err;
        this.log("The saved Sentrint sign-in has expired or was revoked.");
        data = { client: err.code === "invalid_grant" ? client : undefined };
        await this.store.write(data);
      }
    }
    if (!this.interactive) {
      if (!this.signInStarted) {
        this.signInStarted = true;
        this.startSignIn();
      }
      throw new SignInRequired("Sign in to Sentrint in the browser window that just opened, then reconnect Sentrint in your agent.");
    }
    return this.#login(data);
  }

  async #login(data) {
    const meta = await this.meta();
    const state = randomState();
    const { verifier, challenge } = pkcePair();
    let client = data.client;
    let listener = null;
    if (client?.redirect_uri) {
      // Reuse the registered port: the server matches the redirect exactly, port included.
      const port = Number(new URL(client.redirect_uri).port);
      listener = await listenForCode({ port, state }).catch((err) => {
        if (err.code === "EADDRINUSE") return null;
        throw err;
      });
    }
    if (!listener) {
      listener = await listenForCode({ port: 0, state });
      client = await registerClient(meta, listener.redirectUri, this.fetch).catch((err) => {
        listener.close();
        throw err;
      });
      await this.store.write({ client });
    }
    try {
      const url = authorizeUrl(meta, client, { state, challenge });
      const opened = this.openBrowser(url);
      this.log(opened ? `Opened your browser to sign in. If nothing appeared, open:\n  ${url}` : `Open this address to sign in:\n  ${url}`);
      const code = await listener.code;
      const tokens = await exchangeCode(meta, client, { code, verifier }, this.fetch, this.now);
      await this.store.write({ client, tokens });
      return tokens.access_token;
    } catch (err) {
      if (err instanceof OAuthError && err.code === "invalid_client") await this.store.write({});
      throw err;
    } finally {
      listener.close();
    }
  }

  /** Revoke the refresh token on the server and forget everything saved for it. */
  async logout() {
    await this.store.withLock(async () => {
      const { client, tokens } = await this.store.read();
      if (client && tokens?.refresh_token) {
        const meta = await this.meta().catch(() => null);
        if (meta) await revokeToken(meta, client, tokens.refresh_token, this.fetch);
      }
      await this.store.clear();
    });
  }
}
