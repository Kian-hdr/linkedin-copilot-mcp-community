import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../src/sqlite.ts";
import { migrate, CopilotStore } from "../src/core.ts";
const db = sqliteDatabase(":memory:");
await migrate(db);
const store = new CopilotStore(db, "benchmark");
const started = performance.now();
for (let start = 0; start < 100000; start += 100) {
  await store.ingest(
    Array.from({ length: 100 }, (_, offset) => {
      const n = start + offset,
        p = n % 10000;
      return {
        id: "m" + n,
        threadId: "t" + p,
        senderId: "p" + p,
        senderName: "Person " + p,
        participantIds: ["p" + p],
        text: "Synthetic message " + n,
        at: new Date(1700000000000 + n * 1000).toISOString(),
        direction: "inbound",
      };
    }),
    { processed: start + 100 },
  );
}
const timings = [];
let maxBytes = 0;
for (let i = 0; i < 500; i++) {
  const t = performance.now();
  const c = await store.context("p" + ((i * 17) % 10000), "unknown");
  timings.push(performance.now() - t);
  maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(c)));
}
timings.sort((a, b) => a - b);
const p95 = timings[Math.floor(timings.length * 0.95)];
assert(p95 <= 300);
assert(maxBytes <= 8192);
console.log(
  JSON.stringify({
    people: 10000,
    messages: 100000,
    ingestMs: Math.round(performance.now() - started),
    lookupP95Ms: p95,
    maxContextBytes: maxBytes,
    environment: "local in-memory SQLite; not hosted D1 latency",
  }),
);
