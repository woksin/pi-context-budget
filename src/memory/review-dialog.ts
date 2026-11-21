import { truncateToVisualLines, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type NativeFactory = Parameters<ExtensionUIContext["custom"]>[0];
type NativeTui = Parameters<NativeFactory>[0];
type NativeKeys = Parameters<NativeFactory>[2];
type Environment = { tui: NativeTui; keys: NativeKeys; done: (value: string) => void };
const REFUSE = "Refuse", AUTHORISE = "Yes, authorise";
function wrap(text: string, width: number): string[] {
  return truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, width, 0, "start").visualLines;
}
class ReviewPager {
  private offset = 0;
  private pageHeight = 1;
  private selected = false;
  private closed = false;
  private readable = false;
  private width = 0;
  private lines: string[] = [];
  private readonly abort = () => this.close(REFUSE);
  private readonly text: string;
  private readonly environment: Environment;
  private readonly signal: AbortSignal;
  constructor(text: string, environment: Environment, signal: AbortSignal) {
    this.text = text; this.environment = environment; this.signal = signal;
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.close(REFUSE);
  }
  dispose(): void { this.signal.removeEventListener("abort", this.abort); }
  invalidate(): void { this.width = 0; }
  private close(value: string): void {
    if (this.closed) return;
    this.closed = true; this.dispose(); this.environment.done(value);
  }
  private choose(data: string): boolean {
    const { keys } = this.environment;
    if (keys.matches(data, "tui.select.cancel")) { this.close(REFUSE); return true; }
    if (keys.matches(data, "tui.select.confirm")) { this.close(this.readable && this.selected ? AUTHORISE : REFUSE); return true; }
    if (keys.matches(data, "tui.input.tab")) { this.selected = !this.selected; return true; }
    if (keys.matches(data, "tui.editor.cursorLeft")) { this.selected = false; return true; }
    if (keys.matches(data, "tui.editor.cursorRight")) { this.selected = true; return true; }
    return false;
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (!this.choose(data)) {
      const scroll = [["tui.select.up", -1], ["tui.select.down", 1],
        ["tui.select.pageUp", -this.pageHeight], ["tui.select.pageDown", this.pageHeight]] as const;
      for (const [action, amount] of scroll) if (this.environment.keys.matches(data, action)) this.offset += amount;
    }
    this.environment.tui.requestRender();
  }
  render(width: number): string[] {
    const rows = this.environment.tui.terminal.rows;
    this.readable = width >= 24 && rows >= 8;
    if (!this.readable) {
      this.selected = false;
      return wrap("Resize terminal to review. Esc: refuse", Math.max(1, width)).slice(0, Math.max(1, rows - 1));
    }
    if (this.width !== width) { this.lines = wrap(this.text, width); this.width = width; }
    this.pageHeight = rows - 6;
    this.offset = Math.max(0, Math.min(this.offset, this.lines.length - this.pageHeight));
    const body = this.lines.slice(this.offset, this.offset + this.pageHeight);
    const footer = [`Lines ${this.offset + 1}-${this.offset + body.length}/${this.lines.length}`,
      `${this.selected ? "  " : "> "}${REFUSE}`, `${this.selected ? "> " : "  "}${AUTHORISE}`,
      "Up/Down/PgUp/PgDn: scroll | Tab/Left/Right: choose | Enter | Esc: refuse"];
    return ["Memory review", ...body, ...footer.map(line => wrap(line, width)[0])];
  }
}

/** Display-only factory for ctx.ui.custom; authority remains in the source-owned review closure. */
export function createReviewDialog(text: string, signal: AbortSignal) {
  return (tui: NativeTui, _theme: Parameters<NativeFactory>[1], keys: NativeKeys, done: (value: string) => void) =>
    new ReviewPager(text, { tui, keys, done }, signal);
}
