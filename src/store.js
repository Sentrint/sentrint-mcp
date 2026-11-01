import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LockTimeout extends Error {
  constructor() {
    super("Another Sentrint process is busy with the sign-in.");
    this.code = "LOCK_TIMEOUT";
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, owned by someone else
  }
}

/**
 * The saved sign-in for one MCP server: a JSON file only its owner can read,
 * written atomically, plus a lock file so two processes never refresh at once.
 */
export class Store {
  constructor(dir, server) {
    this.dir = dir;
    const id = createHash("sha256").update(server).digest("hex").slice(0, 12);
    this.file = join(dir, `mcp-${id}.json`);
    this.lockFile = join(dir, `mcp-${id}.lock`);
  }

  async ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT" || err instanceof SyntaxError) return {};
      throw err;
    }
  }

  async write(data) {
    await this.ensureDir();
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async clear() {
    await rm(this.file, { force: true });
  }

  /** Run fn while holding the lock. A lock left by a dead process is taken over. */
  async withLock(fn, { wait = 10 * 60_000 } = {}) {
    await this.ensureDir();
    const mine = `${process.pid}:${randomBytes(6).toString("hex")}`;
    const deadline = Date.now() + wait;
    for (;;) {
      try {
        const handle = await open(this.lockFile, "wx", 0o600);
        await handle.writeFile(mine);
        await handle.close();
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        if (await this.#lockIsStale()) {
          await rm(this.lockFile, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new LockTimeout();
        await sleep(50 + Math.random() * 100);
      }
    }
    try {
      return await fn();
    } finally {
      const holder = await readFile(this.lockFile, "utf8").catch(() => "");
      if (holder === mine) await rm(this.lockFile, { force: true });
    }
  }

  async #lockIsStale() {
    const holder = await readFile(this.lockFile, "utf8").catch(() => null);
    if (holder === null) return false; // gone already: the next open() will tell
    const pid = Number(holder.split(":")[0]);
    if (Number.isInteger(pid) && pid > 0) return !isAlive(pid);
    // Unreadable content: either half-written right now, or junk. Give a writer 5 seconds.
    const info = await stat(this.lockFile).catch(() => null);
    return info !== null && Date.now() - info.mtimeMs > 5_000;
  }
}
