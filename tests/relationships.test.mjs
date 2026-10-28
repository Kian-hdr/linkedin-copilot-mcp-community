import test from "node:test";
import assert from "node:assert/strict";
import { CopilotStore, migrate } from "../src/core.ts";
import { sqliteDatabase } from "../src/sqlite.ts";
import { RelationshipStore } from "../src/relationships.ts";
async function setup() {
  const db = sqliteDatabase(":memory:");
  await migrate(db);
  const core = new CopilotStore(db, "owner");
  await core.ingest(
    [
      {
        id: "m",
        threadId: "t",
        senderId: "p",
        senderName: "Person",
        participantIds: ["p"],
        text: "Business enquiry",
        at: "2026-10-27T12:00:00Z",
        direction: "inbound",
      },
    ],
    {},
  );
  let t = await core.thread("t");
  t = await core.classify("t", { domain: "business" }, t.revision);
  const store = new RelationshipStore(core);
  await store.initialize();
  return { core, store };
}
test("classification labels require source evidence and preserve confidence", async () => {
  const { core, store } = await setup();
  let t = await core.thread("t");
  await assert.rejects(
    () =>
      store.annotate("t", t.revision, {
        labels: ["customer"],
        confidence: 0.8,
        rationale: "enquiry",
        classifierVersion: "rules-1",
        evidence: ["unknown"],
      }),
    /unknown_evidence/,
  );
  await store.annotate("t", t.revision, {
    labels: ["customer"],
    confidence: 0.8,
    rationale: "enquiry",
    classifierVersion: "rules-1",
    evidence: ["m"],
  });
  assert.equal((await store.getAnnotations("t")).confidence, 0.8);
});
test("one person can have separate opportunities under the same organization", async () => {
  const { core, store } = await setup();
  let t = await core.thread("t");
  await store.putEntity("organization", "org", 0, "t", t.revision, {
    name: "Example Company",
    evidence: ["m"],
  });
  t = await core.thread("t");
  await store.putEntity("opportunity", "op1", 0, "t", t.revision, {
    name: "Evaluation",
    organizationId: "org",
    stage: "qualifying",
    people: ["p"],
    evidence: ["m"],
  });
  t = await core.thread("t");
  await store.putEntity("opportunity", "op2", 0, "t", t.revision, {
    name: "Deployment",
    organizationId: "org",
    stage: "new",
    people: ["p"],
    evidence: ["m"],
  });
  assert.equal((await store.listEntities("opportunity")).length, 2);
  await assert.rejects(
    () =>
      store.putEntity("opportunity", "op1", 0, "t", t.revision, {
        name: "stale",
        evidence: ["m"],
      }),
    /revision_conflict/,
  );
});
test("personal reclassification excludes company entities from business queries", async () => {
  const { core, store } = await setup();
  let t = await core.thread("t");
  await store.putEntity("organization", "org", 0, "t", t.revision, {
    name: "Company",
    evidence: ["m"],
  });
  t = await core.thread("t");
  await core.classify("t", { domain: "personal" }, t.revision);
  assert.equal((await store.listEntities("organization")).length, 0);
  t = await core.thread("t");
  await assert.rejects(
    () =>
      store.putEntity("organization", "bad", 0, "t", t.revision, {
        name: "No",
        evidence: ["m"],
      }),
    /business_only/,
  );
});
test("fast person context includes labels and separate opportunities in the requested domain", async () => {
  const { core, store } = await setup();
  let t = await core.thread("t");
  await store.annotate("t", t.revision, {
    labels: ["customer"],
    confidence: 0.9,
    rationale: "source",
    classifierVersion: "rules-1",
    evidence: ["m"],
  });
  t = await core.thread("t");
  await store.putEntity("opportunity", "opp", 0, "t", t.revision, {
    name: "Evaluation",
    stage: "qualifying",
    people: ["p"],
    evidence: ["m"],
  });
  const context = await core.context("p", "business");
  assert.deepEqual(context.threads[0].annotations.labels, ["customer"]);
  assert.equal(context.threads[0].entities[0].id, "opp");
  assert.deepEqual((await core.context("p", "personal")).threads, []);
});
test("changing conversation domain invalidates earlier category annotations", async () => {
  const { core, store } = await setup();
  let t = await core.thread("t");
  await store.annotate("t", t.revision, {
    labels: ["customer"],
    confidence: 0.9,
    rationale: "source",
    classifierVersion: "rules-1",
    evidence: ["m"],
  });
  t = await core.thread("t");
  await core.classify("t", { domain: "personal" }, t.revision);
  assert.deepEqual((await store.getAnnotations("t")).labels, []);
  assert.equal(
    (await core.context("p", "personal")).threads[0].annotations,
    null,
  );
});
test("deleting an organization source removes references from other opportunities", async () => {
  const { core, store } = await setup();
  let t = await core.thread("t");
  await store.putEntity("organization", "org", 0, "t", t.revision, {
    name: "Company",
    evidence: ["m"],
  });
  await core.ingest(
    [
      {
        id: "m2",
        threadId: "t2",
        senderId: "p",
        senderName: "Person",
        participantIds: ["p"],
        text: "Another opportunity",
        at: "2026-10-27T13:00:00Z",
        direction: "inbound",
      },
    ],
    {},
  );
  t = await core.thread("t2");
  await core.classify("t2", { domain: "business" }, t.revision);
  t = await core.thread("t2");
  await store.putEntity("opportunity", "opp", 0, "t2", t.revision, {
    name: "Evaluation",
    organizationId: "org",
    evidence: ["m2"],
  });
  t = await core.thread("t");
  await core.deleteThread("t", t.revision, "delete conversation memory");
  const [opp] = await store.listEntities("opportunity");
  assert.equal(opp.organizationId, undefined);
  assert.equal(opp.revision, 2);
});
