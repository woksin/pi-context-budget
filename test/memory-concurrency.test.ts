import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FileMemoryStore } from "../src/memory/store.ts";
import { scanLog } from "../src/memory/log.ts";
import { agent, decision } from "./memory-conformance.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "memory-concurrency-")); directories.push(home);
  return new FileMemoryStore({ home });
}
function worker(home: string, code: string): Promise<any> {
  const module = new URL("../src/memory/store.ts", import.meta.url).href;
  const helpers = new URL("./memory-conformance.ts", import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { FileMemoryStore } from ${JSON.stringify(module)};
      import { agent, decision } from ${JSON.stringify(helpers)};
      const store = new FileMemoryStore({home:${JSON.stringify(home)}}); ${code}`], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", data => { out += data; });
    child.stderr.on("data", data => { err += data; });
    child.on("error", reject);
    child.on("close", status => status === 0 ? resolve(JSON.parse(out)) : reject(Error(`worker exit ${status}: ${err}`)));
  });
}

test("three processes racing to supersede/retire: exactly one applied, identical readers", async () => {
  const store = fixture(), item = decision(); store.addItem(item, agent);
  const start = Date.now() + 600;
  const results = await Promise.all([0, 1, 2].map(n => worker(store.home, `
    while (Date.now() < ${start}) {};
    const result = ${n === 2
      ? `store.retireItem(${JSON.stringify(item.id)}, 'done', 'completed', {type:'agent_decision'}, agent)`
      : `store.addItem(decision({supersedes:[${JSON.stringify(item.id)}]}), agent)`};
    console.log(JSON.stringify(result));`)));
  assert.equal(results.filter(result => result.status === "applied").length, 1);
  assert.equal(results.filter(result => ["conflict", "rejected"].includes(result.status)).length, 2);
  const winner = results.find(result => result.status === "applied").eventId;
  for (const result of results.filter(result => result.status === "conflict")) assert.equal(result.winningEventId, winner);
  const readers = await Promise.all([0, 1, 2].map(() => worker(store.home, "console.log(JSON.stringify(store.readFolded()));")));
  assert.deepEqual(readers[0], readers[1]); assert.deepEqual(readers[1], readers[2]);
});

test("600 appends from three parallel processes all parse and fold", async () => {
  const store = fixture();
  await Promise.all([0, 1, 2].map(() => worker(store.home, `for(let n=0;n<200;n++) {
    const result = store.addItem(decision(), agent); if(result.status !== 'applied') throw Error(JSON.stringify(result));
  } console.log('true');`)));
  const scan = scanLog(join(store.home, "events.jsonl"));
  assert.equal(scan.records.length, 600);
  assert.equal(scan.corrupt, 0); assert.equal(scan.tornTail, 0);
  assert.equal(Object.keys(store.readFolded().items).length, 600);
  assert.equal(store.health().rejectedEvents, 0);
});
