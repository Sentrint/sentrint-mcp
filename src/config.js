import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SERVER = "https://sentrint.com/mcp";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The MCP server to bridge to. SENTRINT_MCP_URL overrides it, for local development. */
export function serverUrl(env = process.env) {
  const raw = env.SENTRINT_MCP_URL || DEFAULT_SERVER;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SENTRINT_MCP_URL is not a valid address: ${raw}`);
  }
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("SENTRINT_MCP_URL must use https (plain http only for an address on this computer).");
  }
  url.hash = "";
  return url.href;
}

/** Where the sign-in is saved. SENTRINT_HOME overrides it. */
export function homeDir(env = process.env) {
  return env.SENTRINT_HOME || join(homedir(), ".sentrint");
}
