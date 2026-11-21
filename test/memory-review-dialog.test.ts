import test from "node:test";
import assert from "node:assert/strict";
import { createReviewDialog } from "../src/memory/review-dialog.ts";

function dialog(text: string, rows = 24, columns = 80) {
  const controller = new AbortController(), answers: string[] = [];
  const tui: any = { terminal: { rows, columns }, requestRender: () => {} };
  const keys: any = { matches: (data: string, action: string) => data === action };
  const component = createReviewDialog(text, controller.signal)(tui, {} as any, keys, value => answers.push(value));
  return { component, controller, answers, tui };
}

test("a 3 KB canonical item is fully pageable at 80x24 with both choices always visible", () => {
  const canonical = "BEGIN" + "x".repeat(2980) + "TAIL", text = `item: canonical\ncanonical text: ${canonical}`;
  const f = dialog(text), seen = new Map<number, string>();
  let total = 0;
  for (let page = 0; page < 100; page++) {
    const screen = f.component.render(80).map(line => line.trimEnd());
    assert.ok(screen.length <= 24); assert.ok(screen.every(line => line.length <= 80));
    assert.equal(screen[0], "Memory review");
    assert.ok(screen.includes("> Refuse")); assert.ok(screen.includes("  Yes, authorise"));
    const status = /^Lines (\d+)-(\d+)\/(\d+)$/.exec(screen.at(-4)!)!;
    assert.ok(status); total = Number(status[3]);
    screen.slice(1, -4).forEach((line, index) => seen.set(Number(status[1]) - 1 + index, line));
    if (Number(status[2]) === total) break;
    f.component.handleInput("tui.select.pageDown");
  }
  assert.ok(total > 24); assert.equal(seen.size, total);
  const full = Array.from({ length: total }, (_, index) => seen.get(index)).join("");
  assert.ok(full.includes(canonical));
  f.component.handleInput("tui.select.confirm");
  assert.deepEqual(f.answers, ["Refuse"]);
});

test("scrolling never changes the refusal default; approval requires selecting yes", () => {
  const f = dialog("canonical text: " + "x".repeat(3000));
  f.component.render(80);
  for (const key of ["tui.select.down", "tui.select.pageDown", "tui.select.pageUp", "tui.select.up"]) f.component.handleInput(key);
  assert.ok(f.component.render(80).some(line => line.trimEnd() === "> Refuse"));
  f.component.handleInput("tui.editor.cursorRight");
  assert.ok(f.component.render(80).some(line => line.trimEnd() === "> Yes, authorise"));
  f.component.handleInput("tui.select.confirm");
  assert.deepEqual(f.answers, ["Yes, authorise"]);
});

test("resize recomputes wrapping and keeps controls inside the terminal", () => {
  const f = dialog("canonical text: " + "z".repeat(3000));
  f.component.render(80); f.component.handleInput("tui.select.pageDown");
  f.tui.terminal.rows = 12; f.tui.terminal.columns = 40;
  f.component.invalidate();
  const screen = f.component.render(40).map(line => line.trimEnd());
  assert.ok(screen.length <= 12); assert.ok(screen.every(line => line.length <= 40));
  assert.ok(screen.includes("> Refuse")); assert.ok(screen.includes("  Yes, authorise"));
  f.component.handleInput("tui.select.cancel");
  assert.deepEqual(f.answers, ["Refuse"]);
});

test("a terminal too small to display review cannot approve", () => {
  const f = dialog("canonical text", 4, 10);
  assert.ok(f.component.render(10).length <= 4);
  f.component.handleInput("tui.editor.cursorRight"); f.component.handleInput("tui.select.confirm");
  assert.deepEqual(f.answers, ["Refuse"]);
});

test("abort closes the native custom dialog and invalidates subsequent input", () => {
  const f = dialog("canonical text"); f.component.render(80);
  f.component.handleInput("tui.editor.cursorRight");
  f.controller.abort();
  f.component.handleInput("tui.select.confirm"); f.component.dispose();
  assert.deepEqual(f.answers, ["Refuse"]);
});
