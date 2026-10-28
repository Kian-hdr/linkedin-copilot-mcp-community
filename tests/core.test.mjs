import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CopilotStore, migrate, normalizeSnapshot } from "../src/core.ts";
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const wrap = (sql, args = []) => ({
    bind(...a) {
      return wrap(sql, a);
    },
    async run() {
      const r = sqlite.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes) } };
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
    async first() {
      return sqlite.prepare(sql).get(...args) || null;
    },
  });
  const db = {
    prepare: wrap,
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try {
        const r = [];
        for (const s of stmts) r.push(await s.run());
        sqlite.exec("COMMIT");
        return r;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, sqlite };
}
async function setup() {
  const f = fixture();
  await migrate(f.db);
  return { ...f, store: new CopilotStore(f.db, "owner") };
}
const msg = (id, time = "2026-10-27T10:00:00.000Z") => ({
  id,
  threadId: "thread",
  senderId: "person",
  senderName: "Example",
  participantIds: ["person"],
  text: "Hello",
  at: time,
  direction: "inbound",
});
test("store starts safe, deduplicates replay and does not merge identical names", async () => {
  const { store } = await setup();
  assert.equal((await store.settings()).autoReply, false);
  await store.ingest(
    [msg("m1"), { ...msg("m2"), senderId: "another", threadId: "another" }],
    { cursor: 1 },
  );
  await store.ingest([msg("m1")], { cursor: 2 });
  assert.equal((await store.search("Example")).length, 2);
  assert.equal((await store.thread("thread")).messages.length, 1);
  assert.deepEqual(await store.checkpoint(), { cursor: 2 });
});
test("old events do not replace newer thread state; revisions reject stale classification", async () => {
  const { store } = await setup();
  await store.ingest([msg("new", "2026-10-27T11:00:00.000Z")], {});
  await store.ingest([msg("old")], {});
  let t = await store.thread("thread");
  assert.equal(t.lastAt, "2026-10-27T11:00:00.000Z");
  await store.classify(
    "thread",
    {
      domain: "business",
      summary: "A business enquiry",
      nextAction: "Respond",
    },
    t.revision,
  );
  await assert.rejects(
    () => store.classify("thread", { domain: "personal" }, t.revision),
    /conflict/,
  );
  assert.equal((await store.thread("thread")).domain, "business");
});
test("unverified transport refuses activation and send; disabling cancels drafts", async () => {
  const { store } = await setup();
  await store.ingest([msg("m")], {});
  await assert.rejects(
    () => store.setSettings({ autoReply: true }, 0),
    /transport/,
  );
  const t = await store.thread("thread");
  await store.draft("thread", "Hello there", t.revision, "key");
  await store.setSettings({ autoReply: false }, 0);
  assert.equal((await store.outbox())[0].status, "cancelled");
  await assert.rejects(() => store.send("key"), /transport/);
});
test("new inbound and takeover cancel stale replies", async () => {
  const { store } = await setup();
  await store.ingest([msg("m")], {});
  let t = await store.thread("thread");
  await store.draft("thread", "Hi", t.revision, "one");
  await store.ingest([msg("m2", "2026-10-27T12:00:00.000Z")], {});
  assert.equal((await store.outbox())[0].status, "cancelled");
  t = await store.thread("thread");
  await store.draft("thread", "Hi again", t.revision, "two");
  await store.pause("thread", true, t.revision);
  assert.equal(
    (await store.outbox()).find((x) => x.id === "two").status,
    "cancelled",
  );
});
test("personal relationships cannot queue business CRM updates and owners are isolated", async () => {
  const { store, db } = await setup();
  await store.ingest([msg("m")], {});
  let t = await store.thread("thread");
  await store.classify("thread", { domain: "personal" }, t.revision);
  await assert.rejects(
    () => store.queueCrm("thread", "record", { nextAction: "Reply" }, "e1"),
    /business/,
  );
  const other = new CopilotStore(db, "other");
  assert.equal((await other.search("")).length, 0);
  await assert.rejects(() => other.thread("thread"), /not_found/);
});
test("CRM acknowledgements cannot create events and require pending known event", async () => {
  const { store } = await setup();
  await store.ingest([msg("m")], {});
  let t = await store.thread("thread");
  await store.classify("thread", { domain: "business" }, t.revision);
  await store.mapCrm("thread", "00000000-0000-4000-8000-000000000001");
  t = await store.thread("thread");
  await store.queueCrm(
    "thread",
    "00000000-0000-4000-8000-000000000001",
    { nextAction: "Reply" },
    "e1",
  );
  await assert.rejects(
    () => store.ackCrm("unknown", "record", "sha"),
    /not_found/,
  );
  await store.ackCrm("e1", "00000000-0000-4000-8000-000000000001", "sha");
  assert.equal((await store.pendingCrm()).length, 0);
});
test("snapshot normalization requires stable identities and does not invent recipient ids from names", async () => {
  const result = await normalizeSnapshot(
    {
      "CONVERSATION ID": "t",
      "SENDER PROFILE URL": "https://www.linkedin.com/in/example",
      FROM: "Same Name",
      DATE: "2026-10-27T10:00:00Z",
      CONTENT: "hello",
    },
    "self",
  );
  assert.equal(result.threadId, "t");
  assert.equal(result.direction, "unknown");
  assert.equal(
    await normalizeSnapshot({ FROM: "Same Name", CONTENT: "hello" }, "self"),
    null,
  );
});
test("ingestion transaction rolls back records when checkpoint serialization fails", async () => {
  const { store } = await setup();
  const circular = {};
  circular.x = circular;
  await assert.rejects(() => store.ingest([msg("m")], circular));
  assert.equal((await store.search("")).length, 0);
  assert.equal(await store.checkpoint(), null);
});
test("snapshot date without timezone is quarantined instead of host-timezone interpretation", async () => {
  assert.equal(
    await normalizeSnapshot(
      {
        "CONVERSATION ID": "t",
        "SENDER PROFILE URL": "https://www.linkedin.com/in/example",
        FROM: "Name",
        DATE: "2026-10-27 10:00:00",
        CONTENT: "hi",
      },
      "self",
    ),
    null,
  );
});
test("manual classification survives automatic updates and personal reclassification suppresses pending CRM", async () => {
  const { store } = await setup();
  await store.ingest([msg("m")], {});
  let t = await store.thread("thread");
  t = await store.classify("thread", { domain: "business" }, t.revision);
  await store.mapCrm("thread", "00000000-0000-4000-8000-000000000001");
  t = await store.thread("thread");
  await store.queueCrm(
    "thread",
    "00000000-0000-4000-8000-000000000001",
    { nextAction: "Reply" },
    "e1",
  );
  t = await store.thread("thread");
  t = await store.classify("thread", { manual: true }, t.revision);
  await assert.rejects(
    () => store.classify("thread", { domain: "personal" }, t.revision),
    /manual_override/,
  );
  t = await store.classify(
    "thread",
    { domain: "personal", manual: true },
    t.revision,
  );
  assert.equal((await store.pendingCrm()).length, 0);
});
test("outbox action key cannot be reused for different text", async () => {
  const { store } = await setup();
  await store.ingest([msg("m")], {});
  const t = await store.thread("thread");
  await store.draft("thread", "one", t.revision, "same");
  await assert.rejects(
    () => store.draft("thread", "two", t.revision, "same"),
    /idempotency_conflict/,
  );
});
test("context is bounded with large text and multiple conversations", async () => {
  const { store } = await setup();
  await store.ingest(
    Array.from({ length: 30 }, (_, i) => ({
      ...msg("m" + i),
      threadId: "t" + i,
      text: "x".repeat(16000),
    })),
    {},
  );
  const c = await store.context("person", "unknown");
  assert(Buffer.byteLength(JSON.stringify(c)) <= 8192);
  assert.equal(c.truncated, true);
});
test("business mappings automatically enqueue corrections; personal threads cannot be mapped", async () => {
  const { store } = await setup();
  await store.ingest([msg("m")], {});
  let t = await store.thread("thread");
  t = await store.classify("thread", { domain: "business" }, t.revision);
  await store.mapCrm("thread", "00000000-0000-4000-8000-000000000001");
  t = await store.thread("thread");
  await store.classify("thread", { nextAction: "Respond" }, t.revision);
  const q = await store.pendingCrm();
  assert.equal(q.length, 1);
  assert.equal(q[0].changes.nextAction, "Respond");
  assert.equal(q[0].evidence.messageId, "m");
});
test("unresolved events persist in same transaction as cursor", async () => {
  const { store, db } = await setup();
  await store.ingest([], { cursor: 4 }, [
    { id: "bad", payload: "{}", reason: "shape" },
  ]);
  assert.equal(
    (await db.prepare("SELECT * FROM copilot_quarantine").all()).results.length,
    1,
  );
  assert.deepEqual(await store.checkpoint(), { cursor: 4 });
});
test("person context cannot mix personal and business conversations", async () => {
  const { store } = await setup();
  await store.ingest(
    [
      msg("one"),
      { ...msg("two"), threadId: "personal", text: "private family" },
    ],
    {},
  );
  for (const [id, domain] of [
    ["thread", "business"],
    ["personal", "personal"],
  ]) {
    const t = await store.thread(id);
    await store.classify(id, { domain }, t.revision);
  }
  const c = await store.context("person", "business");
  assert.equal(c.threads.length, 1);
  assert(!JSON.stringify(c).includes("private family"));
  await assert.rejects(() => store.context("person"), /invalid_input/);
});
test("new messages preserve manual waiting status", async () => {
  const { store } = await setup();
  await store.ingest([msg("one")], {});
  const t = await store.thread("thread");
  await store.classify(
    "thread",
    { waiting: "no_action", manual: true },
    t.revision,
  );
  await store.ingest([msg("two", "2026-10-27T12:00:00Z")], {});
  assert.equal((await store.thread("thread")).waiting, "no_action");
});
test("deleting one thread removes its bodies and leaves other owners untouched", async () => {
  const { store, db } = await setup();
  await store.ingest([msg("m")], {});
  const t = await store.thread("thread");
  await assert.rejects(
    () => store.deleteThread("thread", t.revision, "yes"),
    /confirmation/,
  );
  await store.deleteThread("thread", t.revision, "delete conversation memory");
  assert.equal(
    (await db.prepare("SELECT * FROM copilot_messages").all()).results.length,
    0,
  );
  await assert.rejects(() => store.thread("thread"), /not_found/);
});
test("search enforces D1 UTF-8 pattern budget including escapes", async () => {
  const { store } = await setup();
  await assert.rejects(() => store.search("文".repeat(20)), /search_too_long/);
  await assert.rejects(() => store.search("_".repeat(30)), /search_too_long/);
});
test("classification and derived CRM event roll back together on a storage failure", async () => {
  const { store, db } = await setup();
  await store.ingest([msg("m")], {});
  let t = await store.thread("thread");
  t = await store.classify("thread", { domain: "business" }, t.revision);
  await store.mapCrm("thread", "00000000-0000-4000-8000-000000000001");
  t = await store.thread("thread");
  t = await store.thread("thread");
  const original = db.batch.bind(db);
  db.batch = (statements) =>
    original([
      ...statements.slice(0, 2),
      db.prepare("INSERT INTO missing_failure_fixture VALUES(1)"),
      ...statements.slice(2),
    ]);
  await assert.rejects(() =>
    store.classify("thread", { nextAction: "Must roll back" }, t.revision),
  );
  db.batch = original;
  assert.equal((await store.thread("thread")).nextAction, t.nextAction);
  assert.equal((await store.pendingCrm()).length, 0);
});
test("remapping a CRM contact suppresses queued writes to the previous record", async () => {
  const { store } = await setup();
  await store.ingest([msg("m")], {});
  const t = await store.thread("thread");
  await store.classify("thread", { domain: "business" }, t.revision);
  const a = "00000000-0000-4000-8000-000000000001",
    b = "00000000-0000-4000-8000-000000000002";
  await store.mapCrm("thread", a);
  await store.queueCrm("thread", a, { nextAction: "old" }, "old");
  await store.mapCrm("thread", b);
  assert.equal((await store.pendingCrm()).length, 0);
  await assert.rejects(
    () => store.queueCrm("thread", a, { nextAction: "old" }, "late"),
    /mapping_required/,
  );
});
test("a remap racing queue insertion rejects the old revision", async () => {
  const { store } = await setup();
  await store.ingest([msg("m")], {});
  const t = await store.thread("thread");
  await store.classify("thread", { domain: "business" }, t.revision);
  const a = "00000000-0000-4000-8000-000000000001",
    b = "00000000-0000-4000-8000-000000000002";
  await store.mapCrm("thread", a);
  const guarded = store.atRevision.bind(store);
  store.atRevision = async (...args) => {
    store.atRevision = guarded;
    await store.mapCrm("thread", b);
    return guarded(...args);
  };
  await assert.rejects(
    () => store.queueCrm("thread", a, { nextAction: "old" }, "raced"),
    /revision_conflict/,
  );
  assert.equal((await store.pendingCrm()).length, 0);
});
test("detected mapped business events queue actual communication progress atomically and only once", async () => {
  const { store } = await setup();
  await store.ingest([msg("initial")], {});
  let t = await store.thread("thread");
  await store.classify("thread", { domain: "business" }, t.revision);
  await store.mapCrm("thread", "00000000-0000-4000-8000-000000000001");
  const inbound = {
    ...msg("new", "2026-10-27T13:00:00Z"),
    origin: "changelog",
  };
  await store.ingest([inbound], {});
  await store.ingest([inbound], {});
  let queue = await store.pendingCrm();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].changes.replyStatus, "needs_reply");
  await store.ingest(
    [
      {
        ...msg("owner", "2026-10-27T14:00:00Z"),
        direction: "outbound",
        origin: "changelog",
      },
    ],
    {},
  );
  queue = await store.pendingCrm();
  assert.equal(queue.length, 2);
  assert.equal(queue[1].changes.replyStatus, "waiting_on_them");
  await store.ingest(
    [
      { ...msg("old", "2026-10-27T11:00:00Z"), origin: "changelog" },
      { ...msg("snapshot", "2026-10-27T15:00:00Z"), origin: "snapshot" },
    ],
    {},
  );
  assert.equal((await store.pendingCrm()).length, 2);
});
test("personal threads and manual overrides never emit automatic communication updates", async () => {
  for (const mode of ["personal", "manual"]) {
    const { store } = await setup();
    await store.ingest([msg("initial")], {});
    let t = await store.thread("thread");
    await store.classify("thread", { domain: "business" }, t.revision);
    await store.mapCrm("thread", "00000000-0000-4000-8000-000000000001");
    t = await store.thread("thread");
    await store.classify(
      "thread",
      mode === "personal" ? { domain: "personal" } : { manual: true },
      t.revision,
    );
    const before = (await store.pendingCrm()).length;
    await store.ingest(
      [{ ...msg("new", "2026-10-27T13:00:00Z"), origin: "changelog" }],
      {},
    );
    assert.equal((await store.pendingCrm()).length, before);
  }
});
test("manual correction supersedes queued automatic reply status and holds future automation", async () => {
  const { store } = await setup();
  await store.ingest([msg("initial")], {});
  let t = await store.thread("thread");
  await store.classify("thread", { domain: "business" }, t.revision);
  await store.mapCrm("thread", "00000000-0000-4000-8000-000000000001");
  await store.ingest(
    [{ ...msg("new", "2026-10-27T13:00:00Z"), origin: "changelog" }],
    {},
  );
  t = await store.thread("thread");
  await store.classify(
    "thread",
    { waiting: "no_action", manual: true, nextAction: "Owner resolved" },
    t.revision,
  );
  const pending = await store.pendingCrm();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].changes.replyStatus, "done");
  assert(!pending.some((e) => e.changes.replyStatus === "needs_reply"));
  await assert.rejects(
    () =>
      store.queueCrm(
        "thread",
        "00000000-0000-4000-8000-000000000001",
        { replyStatus: "needs_reply" },
        "bad",
      ),
    /manual_override/,
  );
  t = await store.thread("thread");
  await assert.rejects(
    () => store.releaseManualOverride("thread", t.revision, "yes"),
    /confirmation_required/,
  );
  await store.releaseManualOverride(
    "thread",
    t.revision,
    "resume automatic assessment",
  );
  assert.equal((await store.thread("thread")).manual, false);
  assert.equal((await store.settings()).autoReply, false);
});
