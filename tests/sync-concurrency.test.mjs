import test from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../src/sqlite.ts";
import { CopilotStore, migrate } from "../src/core.ts";
async function setup() {
  const db = sqliteDatabase(":memory:");
  await migrate(db);
  return {
    db,
    first: new CopilotStore(db, "owner"),
    second: new CopilotStore(db, "owner"),
  };
}
const message = {
  id: "m1",
  threadId: "t1",
  senderId: "p1",
  senderName: "Person",
  participantIds: ["p1"],
  text: "Synthetic hello",
  at: "2026-10-27T11:00:00.000Z",
  direction: "inbound",
};
test("only one active synchronization lease is admitted per owner", async () => {
  const { first, second, db } = await setup();
  const token = await first.acquireSyncLease(1000);
  await assert.rejects(() => second.acquireSyncLease(1001), /sync_busy/);
  const other = new CopilotStore(db, "other");
  await other.acquireSyncLease(1001);
  await first.releaseSyncLease(token);
  assert(await second.acquireSyncLease(1002));
});
test("expired worker is fenced out and cannot overwrite checkpoint or import records", async () => {
  const { first, second } = await setup();
  const old = await first.acquireSyncLease(1000, 30);
  const current = await second.acquireSyncLease(1031, 30);
  await second.ingest([], { cursor: 2 }, [], { token: current, now: 1032 });
  await assert.rejects(
    () => first.ingest([message], { cursor: 1 }, [], { token: old, now: 1033 }),
    /sync_lease_lost/,
  );
  assert.deepEqual(await first.checkpoint(), { cursor: 2 });
  assert.deepEqual(await first.search(""), []);
  await first.releaseSyncLease(old);
  await assert.rejects(() => first.acquireSyncLease(1034), /sync_busy/);
});
test("lease expiry alone blocks commit and is recoverable", async () => {
  const { first, second } = await setup();
  const old = await first.acquireSyncLease(1000, 30);
  await assert.rejects(
    () => first.ingest([message], { cursor: 1 }, [], { token: old, now: 1031 }),
    /sync_lease_lost/,
  );
  assert.equal(await first.checkpoint(), null);
  assert(await second.acquireSyncLease(1031));
});
