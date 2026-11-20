/** Role/tool capability and pure soft-notice selection for the Pi adapter. */
import { FINISH_NOTICE, SOFT_NOTICE, type Frame } from "./core.ts";

interface ToolAvailability { getActiveTools?(): string[] }
interface SessionRole { subagent: boolean }

export function canHandoff(tools: ToolAvailability, host?: SessionRole): boolean {
  // Fail closed for main sessions: without a tool list, keep handoff enforcement.
  return !host?.subagent && (tools.getActiveTools?.().includes("context_handoff") ?? true);
}
export function softNotice(frame: Pick<Frame, "handoffAvailable">, handoffNotice = SOFT_NOTICE): string {
  return frame.handoffAvailable === false ? FINISH_NOTICE : handoffNotice;
}
