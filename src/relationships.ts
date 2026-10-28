import { relationshipSchema } from "./relationship-schema.ts";
import { CopilotStore, CopilotError } from "./core.ts";
const labels = [
  "investor",
  "customer",
  "technology_partner",
  "adviser",
  "supplier",
  "personal",
  "unknown",
];
const stages = [
  "new",
  "qualifying",
  "engaged",
  "meeting",
  "proposal",
  "active",
  "lost",
  "dormant",
];
function check(value: unknown, code = "invalid_input"): asserts value {
  if (!value) throw new CopilotError(code);
}
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
export class RelationshipStore {
  core: CopilotStore;
  constructor(core: CopilotStore) {
    this.core = core;
  }
  async initialize() {
    await this.core.db.batch(relationshipSchema.map((sql) => this.core.q(sql)));
  }
  async evidence(threadId: string, ids: unknown) {
    check(
      Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= 20 &&
        ids.every((id) => text(id)),
    );
    for (const id of ids)
      check(
        await this.core
          .q(
            "SELECT id FROM copilot_messages WHERE owner=? AND thread_id=? AND id=?",
            this.core.owner,
            threadId,
            id,
          )
          .first(),
        "unknown_evidence",
      );
  }
  async annotate(
    threadId: string,
    revision: number,
    input: Record<string, unknown>,
  ) {
    check(input && typeof input === "object" && !Array.isArray(input));
    check(
      Object.keys(input).every((key) =>
        [
          "labels",
          "confidence",
          "rationale",
          "classifierVersion",
          "evidence",
        ].includes(key),
      ),
    );
    check(
      Array.isArray(input.labels) &&
        input.labels.length > 0 &&
        input.labels.length <= labels.length &&
        input.labels.every((label) => labels.includes(String(label))),
    );
    check(
      typeof input.confidence === "number" &&
        Number.isFinite(input.confidence) &&
        input.confidence >= 0 &&
        input.confidence <= 1,
    );
    check(text(input.rationale, 1000) && text(input.classifierVersion, 100));
    const thread = await this.core.thread(threadId, 1);
    check(thread.revision === revision, "revision_conflict");
    const manual = await this.core
      .q(
        "SELECT manual FROM copilot_threads WHERE owner=? AND id=?",
        this.core.owner,
        threadId,
      )
      .first<{ manual: number }>();
    check(!manual?.manual, "manual_override");
    check(
      thread.domain === "personal"
        ? input.labels.every((label) =>
            ["personal", "unknown"].includes(String(label)),
          )
        : !input.labels.includes("personal"),
      "domain_conflict",
    );
    check(
      thread.domain !== "unknown" ||
        input.labels.every((label) => label === "unknown"),
      "domain_conflict",
    );
    await this.evidence(threadId, input.evidence);
    const value = {
      ...input,
      labels: [...new Set(input.labels)],
      observedAt: new Date().toISOString(),
    };
    await this.core.atRevision(threadId, revision, [
      this.core.q(
        "INSERT INTO copilot_annotations VALUES(?,?,?) ON CONFLICT(owner,thread_id) DO UPDATE SET value=excluded.value",
        this.core.owner,
        threadId,
        JSON.stringify(value),
      ),
      this.core.q(
        "UPDATE copilot_threads SET revision=revision+1 WHERE owner=? AND id=?",
        this.core.owner,
        threadId,
      ),
    ]);
    return this.getAnnotations(threadId);
  }
  async getAnnotations(threadId: string) {
    await this.core.thread(threadId, 1);
    const result = await this.core
      .q(
        "SELECT value FROM copilot_annotations WHERE owner=? AND thread_id=?",
        this.core.owner,
        threadId,
      )
      .first<{ value: string }>();
    return result ? JSON.parse(result.value) : { labels: [], confidence: null };
  }
  async putEntity(
    kind: "organization" | "opportunity",
    id: string,
    expectedRevision: number,
    threadId: string,
    threadRevision: number,
    input: Record<string, unknown>,
  ) {
    check(
      ["organization", "opportunity"].includes(kind) &&
        text(id) &&
        Number.isSafeInteger(expectedRevision) &&
        expectedRevision >= 0,
    );
    check(
      input &&
        typeof input === "object" &&
        !Array.isArray(input) &&
        text(input.name, 300),
    );
    const allowed =
      kind === "organization"
        ? ["name", "evidence"]
        : ["name", "evidence", "organizationId", "stage", "people"];
    check(Object.keys(input).every((key) => allowed.includes(key)));
    const thread = await this.core.thread(threadId, 1);
    check(thread.domain === "business", "business_only");
    check(thread.revision === threadRevision, "revision_conflict");
    await this.evidence(threadId, input.evidence);
    if (kind === "opportunity") {
      if (input.stage !== undefined)
        check(stages.includes(String(input.stage)));
      if (input.organizationId !== undefined)
        check(
          text(input.organizationId) &&
            (await this.core
              .q(
                "SELECT e.id FROM copilot_entities e JOIN copilot_threads t ON t.owner=e.owner AND t.id=e.source_thread WHERE e.owner=? AND e.kind='organization' AND e.id=? AND t.domain='business'",
                this.core.owner,
                String(input.organizationId),
              )
              .first()),
          "unknown_organization",
        );
      if (input.people !== undefined) {
        check(
          Array.isArray(input.people) &&
            input.people.length <= 100 &&
            input.people.every((p) => text(p)),
        );
        for (const person of input.people)
          check(
            await this.core
              .q(
                "SELECT person_id FROM copilot_participants WHERE owner=? AND thread_id=? AND person_id=?",
                this.core.owner,
                threadId,
                String(person),
              )
              .first(),
            "unknown_participant",
          );
      }
    }
    const statements = [
      this.core.q(
        "INSERT OR REPLACE INTO copilot_entity_guard(owner,revision) VALUES(?,(SELECT CASE WHEN COALESCE((SELECT revision FROM copilot_entities WHERE owner=? AND kind=? AND id=?),0)=? THEN ? ELSE NULL END))",
        this.core.owner,
        this.core.owner,
        kind,
        id,
        expectedRevision,
        expectedRevision,
      ),
      this.core.q(
        "INSERT INTO copilot_entities VALUES(?,?,?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET revision=excluded.revision,source_thread=excluded.source_thread,value=excluded.value",
        this.core.owner,
        kind,
        id,
        expectedRevision + 1,
        threadId,
        JSON.stringify(input),
      ),
      this.core.q(
        "UPDATE copilot_threads SET revision=revision+1 WHERE owner=? AND id=?",
        this.core.owner,
        threadId,
      ),
      this.core.q(
        "DELETE FROM copilot_entity_guard WHERE owner=?",
        this.core.owner,
      ),
    ];
    try {
      await this.core.atRevision(threadId, threadRevision, statements);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("copilot_entity_guard")
      )
        throw new CopilotError("revision_conflict");
      throw error;
    }
    return { id, kind, revision: expectedRevision + 1, threadId, ...input };
  }
  async listEntities(
    kind: "organization" | "opportunity",
    limit = 25,
    offset = 0,
  ) {
    check(["organization", "opportunity"].includes(kind));
    this.core.page(limit, offset);
    const result = await this.core
      .q(
        "SELECT e.id,e.revision,e.source_thread,e.value FROM copilot_entities e JOIN copilot_threads t ON t.owner=e.owner AND t.id=e.source_thread WHERE e.owner=? AND e.kind=? AND t.domain='business' ORDER BY e.id LIMIT ? OFFSET ?",
        this.core.owner,
        kind,
        limit,
        offset,
      )
      .all<{
        id: string;
        revision: number;
        source_thread: string;
        value: string;
      }>();
    return result.results.map((row) => ({
      id: row.id,
      revision: row.revision,
      threadId: row.source_thread,
      ...JSON.parse(row.value),
    }));
  }
}
