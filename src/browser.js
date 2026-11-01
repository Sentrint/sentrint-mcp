import { spawn } from "node:child_process";

/** Open a URL in the default browser. No shell is involved, so the URL is never parsed as a command. */
export function openBrowser(url, platform = process.platform) {
  if (!/^https?:\/\//.test(url)) return false;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
