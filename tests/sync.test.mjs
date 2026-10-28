import test from "node:test";
import assert from "node:assert/strict";
import { sqliteDatabase } from "../src/sqlite.ts";
import { CopilotStore, migrate } from "../src/core.ts";
import { synchronize } from "../src/sync.ts";
async function setup() {
  const db = sqliteDatabase(":memory:");
  await migrate(db);
  return new CopilotStore(db, "owner");
}
const row = {
  "CONVERSATION ID": "t1",
  "SENDER PROFILE URL": "https://www.linkedin.com/in/example",
  FROM: "Example",
  DATE: "2026-10-27 11:00:00 UTC",
  CONTENT: "A synthetic message",
};
test("source failure releases lease without advancing checkpoint", async () => {
  const store = await setup();
  await assert.rejects(
    () =>
      synchronize(
        store,
        {
          inboxPage: async () => {
            throw Error("provider unavailable");
          },
        },
        "self",
      ),
    /provider unavailable/,
  );
  assert.equal(await store.checkpoint(), null);
  const token = await store.acquireSyncLease();
  await store.releaseSyncLease(token);
});
test("snapshot page persists records/quarantine and switches to changelog without duplicate import", async () => {
  const store = await setup();
  let pages = 0,
    events = 0;
  const client = {
    inboxPage: async () => {
      pages++;
      return {
        rows: [row, { CONTENT: "unknown shape" }],
        nextCursor: null,
        page: 0,
        retrievedAt: "2026-10-27T11:01:00Z",
        warnings: [],
      };
    },
    recentMessages: async () => {
      events++;
      return {
        events: [],
        nextCursor: null,
        nextSince: Date.now() - 1000,
        retrievedAt: new Date().toISOString(),
        warnings: [],
      };
    },
  };
  const first = await synchronize(store, client, "self");
  assert.equal(first.imported, 1);
  assert.equal(first.unresolved, 1);
  await synchronize(store, client, "self");
  assert.equal(pages, 1);
  assert.equal(events, 1);
  assert((await store.checkpoint()).snapshotDone);
});
test("expired changelog cursor resets page offset and reports a coverage gap", async () => {
  const store = await setup();
  const expired = Date.now() - 40 * 86400000;
  await store.ingest([], {
    snapshotDone: true,
    since: expired,
    eventStart: 50,
  });
  let requested;
  await synchronize(
    store,
    {
      recentMessages: async (options) => {
        requested = options;
        return {
          events: [],
          nextCursor: null,
          nextSince: options.since,
          retrievedAt: new Date().toISOString(),
          warnings: [],
        };
      },
    },
    "self",
  );
  assert.equal(requested.start, 0);
  assert((await store.checkpoint()).retentionGap.from === expired);
});

test("first changelog after an undated snapshot covers the available retention window", async () => {
  const store = await setup();
  await store.ingest([], { snapshotDone: true });
  let since;
  const before = Date.now();
  await synchronize(
    store,
    {
      recentMessages: async (options) => {
        since = options.since;
        return {
          events: [],
          nextCursor: null,
          nextSince: Date.now(),
          retrievedAt: new Date().toISOString(),
          warnings: [],
        };
      },
    },
    "self",
  );
  assert(since >= before - 27 * 86400000);
  assert(since <= Date.now() - 27 * 86400000);
});
