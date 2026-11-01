// Forwards each JSON-RPC message from the agent (one per stdin line) to the hosted
// MCP server and writes the reply back. The server is stateless and answers in plain
// JSON, so there is no session to track; event-stream replies are unpacked anyway.

const TIMEOUT_MS = 120_000;

function requestIds(msg) {
  const list = Array.isArray(msg) ? msg : [msg];
  return list.filter((m) => m && typeof m === "object" && "method" in m && m.id !== undefined && m.id !== null).map((m) => m.id);
}

function parseEventStream(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) out.push(JSON.parse(data));
  }
  return out;
}

export class Bridge {
  constructor({ serverUrl, tokens, fetchFn = fetch, write, log, timeoutMs = TIMEOUT_MS }) {
    this.serverUrl = serverUrl;
    this.tokens = tokens;
    this.fetch = fetchFn;
    this.write = write;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.protocolVersion = null;
  }

  async handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    try {
      const replies = await this.#send(text);
      for (const reply of replies) {
        this.#rememberVersion(msg, reply);
        this.write(reply);
      }
    } catch (err) {
      this.log(err.message);
      for (const id of requestIds(msg)) {
        this.write({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
      }
    }
  }

  async #send(text) {
    let token = await this.tokens.getToken();
    let res = await this.#post(text, token);
    if (res.status === 401) {
      token = await this.tokens.renew(token);
      res = await this.#post(text, token);
    }
    if (res.status === 202 || res.status === 204) return [];
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
      throw new Error(`Sentrint returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = await res.text();
    if (!body.trim()) return [];
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) return parseEventStream(body);
    return [JSON.parse(body)];
  }

  async #post(text, token) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    try {
      return await this.fetch(this.serverUrl, {
        method: "POST",
        headers,
        body: text,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Could not reach Sentrint at ${this.serverUrl} (${err.cause?.code ?? err.message}).`);
    }
  }

  #rememberVersion(msg, reply) {
    const version = reply?.result?.protocolVersion;
    if (!Array.isArray(msg) && msg.method === "initialize" && typeof version === "string") {
      this.protocolVersion = version;
    }
  }
}
