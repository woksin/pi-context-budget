import { spawn } from "node:child_process";
import type { Config } from "./core.ts";

export function resumeCommand(config: Config, name: string | undefined, env = process.env): string | undefined {
  if (env.PI_RESUME_CHECK?.trim()) return env.PI_RESUME_CHECK;
  const checks = config.resumeChecks;
  return name && checks && Object.hasOwn(checks, name) ? checks[name] : undefined;
}
function prefix(text: string, bytes: number): string {
  let result = "", size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > bytes) break;
    result += char;
  }
  return result;
}
/** Optional trusted operator command. Never fails the handoff; output is <= 4 KiB. */
export async function runResumeCheck(command: string, cwd: string, timeoutMs = 30000): Promise<string> {
  try {
    return await new Promise<string>(resolve => {
      const chunks: Buffer[] = [];
      let bytes = 0, truncated = false, timedOut = false, settled = false;
      let code: number | null = null, signal: NodeJS.Signals | null = null, error = "";
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const capture = (chunk: Buffer) => {
        const room = Math.max(0, 3000 - bytes);
        if (chunk.length > room) truncated = true;
        if (room) chunks.push(chunk.subarray(0, room));
        bytes += Math.min(room, chunk.length);
      };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(drainTimer);
        child.stdout.destroy(); child.stderr.destroy();
        resolve(`command: ${prefix(command, 512)}\nexit: ${code ?? signal ?? "unavailable"}${timedOut ? " (timed out)" : error ? ` (error: ${prefix(error, 256)})` : ""}\n${Buffer.concat(chunks).toString("utf8")}${truncated ? "\n…(output truncated)" : ""}`);
      };
      // Escaped descendants can keep inherited pipes open after the direct child
      // exits. Allow a short drain, but never depend on close to settle.
      const drain = () => { drainTimer ??= setTimeout(finish, 1000); };
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
        drain();
      }, timeoutMs);
      child.on("error", e => { error = e.message; drain(); });
      child.on("exit", (exitCode, exitSignal) => {
        code = exitCode; signal = exitSignal;
        clearTimeout(timer);
        drain();
      });
      child.on("close", (exitCode, exitSignal) => {
        code = exitCode; signal = exitSignal;
        finish();
      });
    });
  } catch (error) {
    return `command: ${prefix(command, 512)}\nexit: unavailable (error: ${prefix(String(error), 256)})`;
  }
}
