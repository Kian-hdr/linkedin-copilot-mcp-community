import { relationshipSchema } from "./relationship-schema.ts";
/** Portable SQLite/D1 domain core. No provider credentials or deployment identity. */
export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
export type Domain = "unknown" | "business" | "personal";
export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  participantIds: string[];
  text: string;
  at: string;
  direction: "inbound" | "outbound" | "unknown";
  origin?: "snapshot" | "changelog" | "unknown";
}
export const schema = [
  `CREATE TABLE IF NOT EXISTS copilot_write_guard(owner TEXT PRIMARY KEY,revision INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS copilot_sync_leases(owner TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS copilot_sync_guard(owner TEXT PRIMARY KEY,token TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS copilot_links(owner TEXT NOT NULL,thread_id TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(owner,thread_id))`,
  `CREATE TABLE IF NOT EXISTS copilot_quarantine(owner TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(owner,id))`,
  `CREATE TABLE IF NOT EXISTS copilot_settings(owner TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS copilot_people(owner TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,seen_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(owner,id))`,
  `CREATE INDEX IF NOT EXISTS copilot_people_name ON copilot_people(owner,name COLLATE NOCASE)`,
  `CREATE TABLE IF NOT EXISTS copilot_threads(owner TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,domain TEXT NOT NULL DEFAULT 'unknown',paused INTEGER NOT NULL DEFAULT 0,last_at TEXT NOT NULL DEFAULT '',last_direction TEXT NOT NULL DEFAULT 'unknown',summary TEXT NOT NULL DEFAULT '',next_action TEXT NOT NULL DEFAULT '',stage TEXT NOT NULL DEFAULT 'new',waiting TEXT NOT NULL DEFAULT 'needs_review',manual INTEGER NOT NULL DEFAULT 0,due_at TEXT,evidence TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(owner,id))`,
  `CREATE INDEX IF NOT EXISTS copilot_threads_due ON copilot_threads(owner,waiting,due_at)`,
  `CREATE TABLE IF NOT EXISTS copilot_participants(owner TEXT NOT NULL,thread_id TEXT NOT NULL,person_id TEXT NOT NULL,PRIMARY KEY(owner,thread_id,person_id))`,
  `CREATE INDEX IF NOT EXISTS copilot_person_threads ON copilot_participants(owner,person_id,thread_id)`,
  `CREATE TABLE IF NOT EXISTS copilot_messages(owner TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,sender_id TEXT NOT NULL,body TEXT NOT NULL,event_at TEXT NOT NULL,direction TEXT NOT NULL,PRIMARY KEY(owner,id))`,
  `CREATE INDEX IF NOT EXISTS copilot_messages_time ON copilot_messages(owner,thread_id,event_at DESC,id)`,
  `CREATE TABLE IF NOT EXISTS copilot_message_origins(owner TEXT NOT NULL,message_id TEXT NOT NULL,origin TEXT NOT NULL,PRIMARY KEY(owner,message_id))`,
  `CREATE TRIGGER IF NOT EXISTS copilot_message_origin_delete AFTER DELETE ON copilot_messages BEGIN DELETE FROM copilot_message_origins WHERE owner=OLD.owner AND message_id=OLD.id; END`,
  `CREATE TABLE IF NOT EXISTS copilot_sync(owner TEXT PRIMARY KEY,value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS copilot_outbox(owner TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,thread_revision INTEGER NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',created_at TEXT NOT NULL,PRIMARY KEY(owner,id))`,
  `CREATE TABLE IF NOT EXISTS copilot_crm(owner TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,record_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',receipt TEXT,PRIMARY KEY(owner,id))`,
  `CREATE TRIGGER IF NOT EXISTS copilot_settings_update AFTER UPDATE ON copilot_settings WHEN json_extract(NEW.value,'$.autoReply')=0 OR json_extract(NEW.value,'$.globalStop')=1 BEGIN UPDATE copilot_outbox SET status='cancelled' WHERE owner=NEW.owner AND status IN ('draft','ready'); END`,
  `CREATE TRIGGER IF NOT EXISTS copilot_settings_insert AFTER INSERT ON copilot_settings WHEN json_extract(NEW.value,'$.autoReply')=0 OR json_extract(NEW.value,'$.globalStop')=1 BEGIN UPDATE copilot_outbox SET status='cancelled' WHERE owner=NEW.owner AND status IN ('draft','ready'); END`,
  `CREATE TRIGGER IF NOT EXISTS copilot_delete_thread AFTER DELETE ON copilot_threads BEGIN DELETE FROM copilot_messages WHERE owner=OLD.owner AND thread_id=OLD.id; DELETE FROM copilot_participants WHERE owner=OLD.owner AND thread_id=OLD.id; DELETE FROM copilot_outbox WHERE owner=OLD.owner AND thread_id=OLD.id; DELETE FROM copilot_crm WHERE owner=OLD.owner AND thread_id=OLD.id; DELETE FROM copilot_links WHERE owner=OLD.owner AND thread_id=OLD.id; END`,
  `CREATE TABLE IF NOT EXISTS copilot_audit(owner TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,subject TEXT NOT NULL,event_at TEXT NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(owner,id))`,
  ...relationshipSchema,
];
export async function migrate(db: Database) {
  await db.batch(schema.map((sql) => db.prepare(sql)));
}
export class CopilotError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function assert(ok: unknown, code = "invalid_input"): asserts ok {
  if (!ok) throw new CopilotError(code);
}
const bounded = (v: unknown, n = 256): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= n;
const time = (v: string) => {
  assert(
    bounded(v, 40) &&
      /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
      Number.isFinite(Date.parse(v)),
  );
  return new Date(v).toISOString();
};
export const hash = async (v: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const defaults = {
  autoReply: false,
  globalStop: false,
  businessPolicy:
    "Escalate commitments, sensitive disclosures and uncertainty.",
  personalPolicy:
    "Use only personal conversation context. Escalate sensitive or uncertain matters.",
  retentionDays: 90,
};
export const capabilities = {
  sending: false,
  reason:
    "No permitted unattended personal-account messaging transport is configured.",
  paidFallback: false,
};
export class CopilotStore {
  db: Database;
  owner: string;
  constructor(db: Database, owner: string) {
    assert(bounded(owner));
    this.db = db;
    this.owner = owner;
  }
  q(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).bind(...args);
  }
  async settings(): Promise<
    typeof defaults & { revision: number; capabilities: typeof capabilities }
  > {
    const r = await this.q(
      "SELECT revision,value FROM copilot_settings WHERE owner=?",
      this.owner,
    ).first<{ revision: number; value: string }>();
    return {
      ...defaults,
      ...(r ? JSON.parse(r.value) : {}),
      revision: r?.revision ?? 0,
      capabilities,
    };
  }
  async setSettings(patch: Record<string, unknown>, revision: number) {
    assert(Number.isSafeInteger(revision) && revision >= 0);
    const keys = [
      "autoReply",
      "globalStop",
      "businessPolicy",
      "personalPolicy",
      "retentionDays",
    ];
    assert(Object.keys(patch).every((k) => keys.includes(k)));
    for (const key of ["autoReply", "globalStop"])
      if (key in patch) assert(typeof patch[key] === "boolean");
    for (const key of ["businessPolicy", "personalPolicy"])
      if (key in patch) assert(bounded(patch[key], 4000));
    if ("retentionDays" in patch)
      assert(
        Number.isInteger(patch.retentionDays) &&
          Number(patch.retentionDays) >= 7 &&
          Number(patch.retentionDays) <= 365,
      );
    if (patch.autoReply === true)
      throw new CopilotError("transport_unavailable");
    const old = await this.settings();
    assert(old.revision === revision, "revision_conflict");
    const value = {
      autoReply: old.autoReply,
      globalStop: old.globalStop,
      businessPolicy: old.businessPolicy,
      personalPolicy: old.personalPolicy,
      retentionDays: old.retentionDays,
      ...patch,
    };
    const sql = `INSERT INTO copilot_settings(owner,revision,value) VALUES(?,1,?) ON CONFLICT(owner) DO UPDATE SET revision=revision+1,value=excluded.value WHERE revision=?`;
    const statements = [
      this.q(sql, this.owner, JSON.stringify(value), revision),
    ];
    const r = (await this.db.batch(statements)) as {
      meta?: { changes?: number };
    }[];
    assert(r[0].meta?.changes === 1, "revision_conflict");
    return this.settings();
  }
  async acquireSyncLease(now = Date.now(), ttl = 60000) {
    assert(
      Number.isSafeInteger(now) &&
        now >= 0 &&
        Number.isSafeInteger(ttl) &&
        ttl >= 1 &&
        ttl <= 120000,
    );
    const token = crypto.randomUUID();
    const result = await this.q(
      "INSERT INTO copilot_sync_leases(owner,token,expires) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE expires<=?",
      this.owner,
      token,
      now + ttl,
      now,
    ).run();
    assert(result.meta?.changes === 1, "sync_busy");
    return token;
  }
  async releaseSyncLease(token: string) {
    assert(bounded(token));
    await this.q(
      "DELETE FROM copilot_sync_leases WHERE owner=? AND token=?",
      this.owner,
      token,
    ).run();
  }
  async ingest(
    messages: Message[],
    checkpoint: unknown,
    quarantine: { id: string; payload: string; reason: string }[] = [],
    lease?: { token: string; now?: number },
  ) {
    assert(Array.isArray(messages) && messages.length <= 100);
    const stmts: Statement[] = [];
    if (lease) {
      assert(bounded(lease.token));
      stmts.push(
        this.q(
          "INSERT OR REPLACE INTO copilot_sync_guard(owner,token) VALUES(?,(SELECT token FROM copilot_sync_leases WHERE owner=? AND token=? AND expires>?))",
          this.owner,
          this.owner,
          lease.token,
          lease.now ?? Date.now(),
        ),
      );
    }
    for (const m of messages) {
      assert(
        bounded(m.id) &&
          bounded(m.threadId) &&
          bounded(m.senderId) &&
          bounded(m.senderName, 300) &&
          typeof m.text === "string" &&
          m.text.length <= 16000 &&
          Array.isArray(m.participantIds) &&
          m.participantIds.length <= 100 &&
          m.participantIds.every((p) => bounded(p)) &&
          ["inbound", "outbound", "unknown"].includes(m.direction),
      );
      assert(
        m.origin === undefined ||
          ["snapshot", "changelog", "unknown"].includes(m.origin),
      );
      const at = time(m.at);
      stmts.push(
        this.q(
          "INSERT OR IGNORE INTO copilot_threads(owner,id) VALUES(?,?)",
          this.owner,
          m.threadId,
        ),
        this.q(
          "INSERT INTO copilot_people(owner,id,name,seen_at) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET name=excluded.name,seen_at=excluded.seen_at WHERE seen_at<=excluded.seen_at",
          this.owner,
          m.senderId,
          m.senderName,
          at,
        ),
      );
      stmts.push(
        this.q(
          `UPDATE copilot_threads SET last_at=MAX(last_at,?),last_direction=CASE WHEN last_at<=? THEN ? ELSE last_direction END,revision=revision+1,waiting=CASE WHEN manual=1 OR last_at>? THEN waiting WHEN ?='inbound' THEN 'waiting_on_us' WHEN ?='outbound' THEN 'waiting_on_them' ELSE waiting END WHERE owner=? AND id=? AND NOT EXISTS(SELECT 1 FROM copilot_messages WHERE owner=? AND id=?)`,
          at,
          at,
          m.direction,
          at,
          m.direction,
          m.direction,
          this.owner,
          m.threadId,
          this.owner,
          m.id,
        ),
      );
      stmts.push(
        this.q(
          `UPDATE copilot_outbox SET status='cancelled' WHERE owner=? AND thread_id=? AND status IN ('draft','ready') AND NOT EXISTS(SELECT 1 FROM copilot_messages WHERE owner=? AND id=?)`,
          this.owner,
          m.threadId,
          this.owner,
          m.id,
        ),
      );
      if (m.origin === "changelog" && m.direction !== "unknown") {
        const eventId = "message:" + (await hash(m.id));
        const reply =
          m.direction === "inbound" ? "needs_reply" : "waiting_on_them";
        stmts.push(
          this.q(
            `INSERT OR IGNORE INTO copilot_crm(owner,id,thread_id,record_id,payload) SELECT ?,?,t.id,l.record_id,json_object('eventId',?,'recordId',l.record_id,'classification','business','changes',json_object('lastCommunication',?,'replyStatus',?),'evidence',json_object('source','linkedin','messageId',?,'occurredAt',?)) FROM copilot_threads t JOIN copilot_links l ON l.owner=t.owner AND l.thread_id=t.id WHERE t.owner=? AND t.id=? AND t.domain='business' AND t.manual=0 AND t.last_at=? AND t.last_direction=? AND NOT EXISTS(SELECT 1 FROM copilot_messages WHERE owner=? AND id=?)`,
            this.owner,
            eventId,
            eventId,
            at,
            reply,
            m.id,
            at,
            this.owner,
            m.threadId,
            at,
            m.direction,
            this.owner,
            m.id,
          ),
        );
      }
      stmts.push(
        this.q(
          "INSERT OR IGNORE INTO copilot_messages(owner,id,thread_id,sender_id,body,event_at,direction) VALUES(?,?,?,?,?,?,?)",
          this.owner,
          m.id,
          m.threadId,
          m.senderId,
          m.text,
          at,
          m.direction,
        ),
      );
      stmts.push(
        this.q(
          "INSERT OR IGNORE INTO copilot_message_origins VALUES(?,?,?)",
          this.owner,
          m.id,
          m.origin ?? "unknown",
        ),
      );
      for (const person of new Set([m.senderId, ...m.participantIds]))
        stmts.push(
          this.q(
            "INSERT OR IGNORE INTO copilot_participants(owner,thread_id,person_id) VALUES(?,?,?)",
            this.owner,
            m.threadId,
            person,
          ),
        );
    }
    for (const q of quarantine) {
      assert(bounded(q.id) && bounded(q.payload, 60000) && bounded(q.reason));
      stmts.push(
        this.q(
          "INSERT OR IGNORE INTO copilot_quarantine(owner,id,payload,reason) VALUES(?,?,?,?)",
          this.owner,
          q.id,
          q.payload,
          q.reason,
        ),
      );
    }
    const serialized = JSON.stringify(checkpoint);
    assert(serialized.length <= 4096);
    stmts.push(
      this.q(
        "INSERT INTO copilot_sync(owner,value) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value",
        this.owner,
        serialized,
      ),
    );
    if (lease)
      stmts.push(
        this.q("DELETE FROM copilot_sync_guard WHERE owner=?", this.owner),
      );
    try {
      await this.db.batch(stmts);
    } catch (error) {
      if (
        lease &&
        error instanceof Error &&
        error.message.includes("copilot_sync_guard")
      )
        throw new CopilotError("sync_lease_lost");
      throw error;
    }
    return { processed: messages.length, checkpoint };
  }
  async checkpoint() {
    const r = await this.q(
      "SELECT value FROM copilot_sync WHERE owner=?",
      this.owner,
    ).first<{ value: string }>();
    return r ? JSON.parse(r.value) : null;
  }
  async search(query = "", limit = 25, offset = 0) {
    assert(typeof query === "string" && query.length <= 200);
    this.page(limit, offset);
    const pattern = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
    assert(new TextEncoder().encode(pattern).length <= 50, "search_too_long");
    return (
      await this.q(
        `SELECT id,name FROM copilot_people WHERE owner=? AND name LIKE ? ESCAPE '\\' ORDER BY name,id LIMIT ? OFFSET ?`,
        this.owner,
        pattern,
        limit,
        offset,
      ).all()
    ).results;
  }
  page(limit: number, offset: number) {
    assert(
      Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 100 &&
        Number.isInteger(offset) &&
        offset >= 0 &&
        offset <= 1000000,
    );
  }
  async threads(limit = 25, offset = 0) {
    this.page(limit, offset);
    return (
      await this.q(
        "SELECT id,revision,domain,paused,last_at,last_direction,summary,next_action,waiting,stage,due_at FROM copilot_threads WHERE owner=? ORDER BY last_at DESC,id LIMIT ? OFFSET ?",
        this.owner,
        limit,
        offset,
      ).all()
    ).results;
  }
  async thread(id: string, limit = 20, offset = 0) {
    assert(bounded(id));
    this.page(limit, offset);
    const r = await this.q(
      "SELECT * FROM copilot_threads WHERE owner=? AND id=?",
      this.owner,
      id,
    ).first<Record<string, unknown>>();
    assert(r, "not_found");
    const messages = (
      await this.q(
        "SELECT m.id,m.sender_id,m.body,m.event_at,m.direction,COALESCE(o.origin,'unknown') AS origin FROM copilot_messages m LEFT JOIN copilot_message_origins o ON o.owner=m.owner AND o.message_id=m.id WHERE m.owner=? AND m.thread_id=? ORDER BY m.event_at DESC,m.id DESC LIMIT ? OFFSET ?",
        this.owner,
        id,
        limit,
        offset,
      ).all()
    ).results;
    return {
      id: r.id,
      revision: Number(r.revision),
      domain: r.domain,
      paused: !!r.paused,
      manual: !!r.manual,
      lastAt: r.last_at,
      summary: r.summary,
      nextAction: r.next_action,
      waiting: r.waiting,
      stage: r.stage,
      dueAt: r.due_at,
      evidence: JSON.parse(String(r.evidence)),
      messages,
      nextOffset: messages.length === limit ? offset + limit : null,
    };
  }
  async context(personId: string, domain: Domain) {
    assert(
      bounded(personId) && ["business", "personal", "unknown"].includes(domain),
    );
    const p = await this.q(
      "SELECT id,name FROM copilot_people WHERE owner=? AND id=?",
      this.owner,
      personId,
    ).first();
    assert(p, "not_found");
    const threads = (
      await this.q(
        "SELECT t.id,t.domain,t.summary,t.waiting,t.next_action,t.last_at,a.value AS annotations FROM copilot_threads t JOIN copilot_participants p ON p.owner=t.owner AND p.thread_id=t.id LEFT JOIN copilot_annotations a ON a.owner=t.owner AND a.thread_id=t.id WHERE p.owner=? AND p.person_id=? AND t.domain=? ORDER BY t.last_at DESC LIMIT 8",
        this.owner,
        personId,
        domain,
      ).all()
    ).results;
    const contexts = [];
    for (const t of threads) {
      const recent = (
        await this.q(
          "SELECT id,event_at,direction,substr(body,1,512) AS excerpt FROM copilot_messages WHERE owner=? AND thread_id=? ORDER BY event_at DESC LIMIT 2",
          this.owner,
          String(t.id),
        ).all()
      ).results;
      const annotation = t.annotations
        ? JSON.parse(String(t.annotations))
        : null;
      const entities =
        domain === "business"
          ? (
              await this.q(
                "SELECT id,kind,revision,value FROM copilot_entities WHERE owner=? AND source_thread=? ORDER BY kind,id LIMIT 4",
                this.owner,
                String(t.id),
              ).all()
            ).results.map((e) => {
              const v = JSON.parse(String(e.value));
              return {
                id: e.id,
                kind: e.kind,
                revision: e.revision,
                name: v.name,
                stage: v.stage,
                evidence: v.evidence,
              };
            })
          : [];
      contexts.push({
        ...t,
        annotations: annotation
          ? {
              labels: annotation.labels,
              confidence: annotation.confidence,
              classifierVersion: annotation.classifierVersion,
              evidence: annotation.evidence,
            }
          : null,
        entities,
        summary: String(t.summary).slice(0, 300),
        next_action: String(t.next_action).slice(0, 150),
        recent,
      });
    }
    let value = {
      person: p,
      threads: contexts,
      truncated: threads.length === 8,
    };
    while (
      new TextEncoder().encode(JSON.stringify(value)).length > 8192 &&
      value.threads.length
    ) {
      value.threads.pop();
      value.truncated = true;
    }
    return value;
  }
  async atRevision(id: string, revision: number, statements: Statement[]) {
    assert(bounded(id) && Number.isSafeInteger(revision) && revision >= 0);
    const guarded = [
      this.q(
        "INSERT OR REPLACE INTO copilot_write_guard(owner,revision) VALUES(?,(SELECT revision FROM copilot_threads WHERE owner=? AND id=? AND revision=?))",
        this.owner,
        this.owner,
        id,
        revision,
      ),
      ...statements,
      this.q("DELETE FROM copilot_write_guard WHERE owner=?", this.owner),
    ];
    try {
      await this.db.batch(guarded);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("copilot_write_guard")
      )
        throw new CopilotError("revision_conflict");
      throw error;
    }
  }
  async classify(id: string, patch: Record<string, unknown>, revision: number) {
    assert(
      bounded(id) &&
        Number.isSafeInteger(revision) &&
        patch &&
        typeof patch === "object" &&
        !Array.isArray(patch),
    );
    const allowed = [
      "domain",
      "summary",
      "nextAction",
      "stage",
      "waiting",
      "dueAt",
      "evidence",
      "manual",
    ];
    assert(
      Object.keys(patch).length > 0 &&
        Object.keys(patch).every((k) => allowed.includes(k)),
    );
    const old = await this.thread(id, 1);
    assert(old.revision === revision, "revision_conflict");
    const manual = (
      await this.q(
        "SELECT manual FROM copilot_threads WHERE owner=? AND id=?",
        this.owner,
        id,
      ).first<{ manual: number }>()
    )?.manual;
    if (manual && patch.manual !== true)
      throw new CopilotError("manual_override");
    if ("domain" in patch)
      assert(
        ["business", "personal", "unknown"].includes(String(patch.domain)),
      );
    for (const k of ["summary", "nextAction"])
      if (k in patch)
        assert(typeof patch[k] === "string" && String(patch[k]).length <= 2000);
    if ("stage" in patch)
      assert(
        [
          "new",
          "qualifying",
          "engaged",
          "meeting",
          "proposal",
          "active",
          "lost",
          "dormant",
        ].includes(String(patch.stage)),
      );
    if ("waiting" in patch)
      assert(
        [
          "waiting_on_us",
          "waiting_on_them",
          "no_action",
          "needs_review",
        ].includes(String(patch.waiting)),
      );
    if ("dueAt" in patch && patch.dueAt !== null)
      patch.dueAt = time(String(patch.dueAt));
    if ("manual" in patch) assert(typeof patch.manual === "boolean");
    if ("evidence" in patch) {
      assert(
        Array.isArray(patch.evidence) &&
          patch.evidence.length <= 20 &&
          patch.evidence.every((e) => bounded(e)),
      );
      for (const e of patch.evidence as string[])
        assert(
          await this.q(
            "SELECT id FROM copilot_messages WHERE owner=? AND thread_id=? AND id=?",
            this.owner,
            id,
            e,
          ).first(),
          "unknown_evidence",
        );
    }
    const columns: Record<string, string> = {
      domain: "domain",
      summary: "summary",
      nextAction: "next_action",
      stage: "stage",
      waiting: "waiting",
      dueAt: "due_at",
      evidence: "evidence",
      manual: "manual",
    };
    const entries = Object.entries(patch);
    const args = entries.map(([k, v]) =>
      k === "evidence"
        ? JSON.stringify(v)
        : k === "manual"
          ? Number(v)
          : v === null
            ? null
            : String(v),
    );
    const statements = [
      this.q(
        `UPDATE copilot_threads SET ${entries.map(([k]) => columns[k] + "=?").join(",")},revision=revision+1 WHERE owner=? AND id=?`,
        ...args,
        this.owner,
        id,
      ),
    ];
    const next = { ...old, ...patch };
    if ("domain" in patch && patch.domain !== old.domain)
      statements.push(
        this.q(
          "DELETE FROM copilot_annotations WHERE owner=? AND thread_id=?",
          this.owner,
          id,
        ),
      );
    if (next.domain !== "business" || patch.manual === true)
      statements.push(
        this.q(
          "UPDATE copilot_crm SET status='suppressed' WHERE owner=? AND thread_id=? AND status='pending'",
          this.owner,
          id,
        ),
      );
    if (patch.manual === true)
      statements.push(
        this.q(
          "UPDATE copilot_outbox SET status='cancelled' WHERE owner=? AND thread_id=? AND status IN ('draft','ready')",
          this.owner,
          id,
        ),
      );
    statements.push(
      this.q(
        "INSERT INTO copilot_audit VALUES(?,?,?,?,?,?)",
        this.owner,
        crypto.randomUUID(),
        "classification",
        id,
        new Date().toISOString(),
        JSON.stringify({
          previousRevision: revision,
          fields: entries.map(([k]) => k),
        }),
      ),
    );
    const link = await this.q(
      "SELECT record_id FROM copilot_links WHERE owner=? AND thread_id=?",
      this.owner,
      id,
    ).first<{ record_id: string }>();
    const latest = old.messages[0] as Record<string, unknown> | undefined;
    if (next.domain === "business" && link && latest?.id && old.lastAt) {
      const changes: Record<string, unknown> = {
        nextAction: next.nextAction,
        lastCommunication: old.lastAt,
      };
      if (next.waiting === "waiting_on_us") changes.replyStatus = "needs_reply";
      if (next.waiting === "waiting_on_them")
        changes.replyStatus = "waiting_on_them";
      if (next.waiting === "no_action") changes.replyStatus = "done";
      const eventId =
        "classification:" + (await hash(id + ":" + (revision + 1)));
      const payload = {
        eventId,
        recordId: link.record_id,
        classification: "business",
        changes,
        evidence: {
          source: "linkedin",
          messageId: latest.id,
          occurredAt:
            patch.manual === true ? new Date().toISOString() : old.lastAt,
          ...(patch.manual === true
            ? {
                summary:
                  "Owner corrected the channel relationship state; this is not a new message.",
              }
            : {}),
        },
      };
      statements.push(
        this.q(
          "INSERT INTO copilot_crm(owner,id,thread_id,record_id,payload) VALUES(?,?,?,?,?)",
          this.owner,
          eventId,
          id,
          link.record_id,
          JSON.stringify(payload),
        ),
      );
    }
    await this.atRevision(id, revision, statements);
    return this.thread(id, 1);
  }
  async pause(id: string, paused: boolean, revision: number) {
    assert(typeof paused === "boolean");
    const statements = [
      this.q(
        "UPDATE copilot_threads SET paused=?,revision=revision+1 WHERE owner=? AND id=?",
        Number(paused),
        this.owner,
        id,
      ),
    ];
    if (paused)
      statements.push(
        this.q(
          "UPDATE copilot_outbox SET status='cancelled' WHERE owner=? AND thread_id=? AND status IN ('draft','ready')",
          this.owner,
          id,
        ),
      );
    await this.atRevision(id, revision, statements);
    return this.thread(id, 1);
  }
  async draft(threadId: string, body: string, revision: number, id: string) {
    assert(bounded(body, 4000) && bounded(id));
    const t = await this.thread(threadId, 1);
    assert(!t.paused, "thread_paused");
    assert(t.revision === revision, "revision_conflict");
    assert(!(await this.settings()).globalStop, "global_stop");
    const old = await this.q(
      "SELECT * FROM copilot_outbox WHERE owner=? AND id=?",
      this.owner,
      id,
    ).first();
    if (old) {
      assert(
        old.thread_id === threadId &&
          old.body === body &&
          old.thread_revision === revision,
        "idempotency_conflict",
      );
      return old;
    }
    const inserted = await this.q(
      "INSERT INTO copilot_outbox(owner,id,thread_id,thread_revision,body,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM copilot_threads WHERE owner=? AND id=? AND revision=? AND paused=0) AND NOT EXISTS(SELECT 1 FROM copilot_settings WHERE owner=? AND json_extract(value,'$.globalStop')=1)",
      this.owner,
      id,
      threadId,
      revision,
      body,
      new Date().toISOString(),
      this.owner,
      threadId,
      revision,
      this.owner,
    ).run();
    assert(inserted.meta?.changes === 1, "draft_context_changed");
    return this.q(
      "SELECT id,thread_id,thread_revision,body,status,created_at FROM copilot_outbox WHERE owner=? AND id=?",
      this.owner,
      id,
    ).first();
  }
  async outbox() {
    return (
      await this.q(
        "SELECT id,thread_id,thread_revision,body,status,created_at FROM copilot_outbox WHERE owner=? ORDER BY created_at DESC LIMIT 100",
        this.owner,
      ).all()
    ).results;
  }
  async send(_id: string): Promise<never> {
    throw new CopilotError("transport_unavailable");
  }
  async actions() {
    return (
      await this.q(
        "SELECT id,domain,waiting,next_action,due_at,last_at FROM copilot_threads WHERE owner=? AND (waiting IN ('waiting_on_us','needs_review') OR due_at<=?) ORDER BY COALESCE(due_at,last_at) LIMIT 100",
        this.owner,
        new Date().toISOString(),
      ).all()
    ).results;
  }
  async queueCrm(
    threadId: string,
    recordId: string,
    changes: Record<string, unknown>,
    id: string,
  ) {
    const t = await this.thread(threadId, 1);
    assert(t.domain === "business", "business_only");
    assert(!t.manual, "manual_override");
    assert(bounded(id) && bounded(recordId));
    const mapping = await this.q(
      "SELECT record_id FROM copilot_links WHERE owner=? AND thread_id=?",
      this.owner,
      threadId,
    ).first<{ record_id: string }>();
    assert(mapping?.record_id === recordId, "mapping_required");
    const keys = [
      "lastCommunication",
      "notes",
      "communicationType",
      "replyStatus",
      "replyDueAt",
      "nextAction",
      "memberships",
    ];
    assert(
      Object.keys(changes).length > 0 &&
        Object.keys(changes).every((k) => keys.includes(k)) &&
        JSON.stringify(changes).length <= 12000,
    );
    const payload = JSON.stringify({
      eventId: id,
      recordId,
      classification: "business",
      changes,
      evidence: {
        source: "linkedin",
        messageId:
          (t.messages[0] as Record<string, unknown> | undefined)?.id ?? null,
        occurredAt: t.lastAt,
      },
    });
    const existing = await this.q(
      "SELECT payload FROM copilot_crm WHERE owner=? AND id=?",
      this.owner,
      id,
    ).first<{ payload: string }>();
    if (existing) {
      assert(existing.payload === payload, "idempotency_conflict");
      return { id, queued: false };
    }
    await this.atRevision(threadId, t.revision, [
      this.q(
        "INSERT INTO copilot_crm(owner,id,thread_id,record_id,payload) VALUES(?,?,?,?,?)",
        this.owner,
        id,
        threadId,
        recordId,
        payload,
      ),
    ]);
    return { id, queued: true };
  }
  async releaseManualOverride(
    threadId: string,
    revision: number,
    confirmation: string,
  ) {
    assert(
      confirmation === "resume automatic assessment",
      "confirmation_required",
    );
    await this.atRevision(threadId, revision, [
      this.q(
        "UPDATE copilot_threads SET manual=0,revision=revision+1 WHERE owner=? AND id=?",
        this.owner,
        threadId,
      ),
      this.q(
        "INSERT INTO copilot_audit VALUES(?,?,?,?,?,?)",
        this.owner,
        crypto.randomUUID(),
        "manual_override_released",
        threadId,
        new Date().toISOString(),
        JSON.stringify({ previousRevision: revision }),
      ),
    ]);
    return this.thread(threadId, 1);
  }
  async mapCrm(threadId: string, recordId: string) {
    assert(
      bounded(recordId) && /^[a-f0-9-]{36}$/i.test(recordId),
      "invalid_record_id",
    );
    const t = await this.thread(threadId, 1);
    assert(t.domain === "business", "business_only");
    await this.atRevision(threadId, t.revision, [
      this.q(
        "INSERT INTO copilot_links VALUES(?,?,?) ON CONFLICT(owner,thread_id) DO UPDATE SET record_id=excluded.record_id",
        this.owner,
        threadId,
        recordId,
      ),
      this.q(
        "UPDATE copilot_threads SET revision=revision+1 WHERE owner=? AND id=?",
        this.owner,
        threadId,
      ),
      this.q(
        "UPDATE copilot_crm SET status='suppressed' WHERE owner=? AND thread_id=? AND status='pending' AND record_id<>?",
        this.owner,
        threadId,
        recordId,
      ),
    ]);
    return { mapped: true, revision: t.revision + 1 };
  }
  async pendingCrm() {
    return (
      await this.q(
        "SELECT c.payload FROM copilot_crm c JOIN copilot_threads t ON t.owner=c.owner AND t.id=c.thread_id JOIN copilot_links l ON l.owner=c.owner AND l.thread_id=c.thread_id AND l.record_id=c.record_id WHERE c.owner=? AND c.status='pending' AND t.domain='business' ORDER BY c.rowid LIMIT 20",
        this.owner,
      ).all<{ payload: string }>()
    ).results.map((r) => JSON.parse(r.payload));
  }
  async ackCrm(id: string, recordId: string, revision: string) {
    assert(bounded(id) && bounded(recordId) && bounded(revision));
    const r = await this.q(
      "UPDATE copilot_crm SET status='applied',receipt=? WHERE owner=? AND id=? AND record_id=? AND status IN ('pending','applied')",
      revision,
      this.owner,
      id,
      recordId,
    ).run();
    assert(r.meta?.changes === 1, "not_found");
    return { id, status: "applied" };
  }
  async audit(kind: string, subject: string, detail: unknown) {
    await this.q(
      "INSERT INTO copilot_audit VALUES(?,?,?,?,?,?)",
      this.owner,
      crypto.randomUUID(),
      kind,
      subject,
      new Date().toISOString(),
      JSON.stringify(detail),
    ).run();
  }
  async activity() {
    return (
      await this.q(
        "SELECT kind,subject,event_at,detail FROM copilot_audit WHERE owner=? ORDER BY event_at DESC LIMIT 50",
        this.owner,
      ).all()
    ).results;
  }
  async deleteThread(id: string, revision: number, confirmation: string) {
    assert(
      confirmation === "delete conversation memory",
      "confirmation_required",
    );
    const r = await this.q(
      "DELETE FROM copilot_threads WHERE owner=? AND id=? AND revision=?",
      this.owner,
      id,
      revision,
    ).run();
    assert(r.meta?.changes === 1, "revision_conflict");
    return {
      deleted: true,
      providerMessagesDeleted: false,
      localCrmDeleted: false,
    };
  }
  async exportMemory(domain: Domain, limit = 20, offset = 0) {
    assert(["business", "personal", "unknown"].includes(domain));
    this.page(limit, offset);
    return {
      threads: (
        await this.q(
          "SELECT id,revision,domain,summary,next_action,last_at FROM copilot_threads WHERE owner=? AND domain=? ORDER BY id LIMIT ? OFFSET ?",
          this.owner,
          domain,
          limit,
          offset,
        ).all()
      ).results,
      nextOffset: offset + limit,
    };
  }
  async retention() {
    const s = await this.settings();
    const cutoff = new Date(
      Date.now() - Number(s.retentionDays) * 86400000,
    ).toISOString();
    await this.db.batch([
      this.q(
        "DELETE FROM copilot_messages WHERE owner=? AND event_at<?",
        this.owner,
        cutoff,
      ),
      this.q(
        "DELETE FROM copilot_quarantine WHERE owner=? AND created_at<datetime('now',?)",
        this.owner,
        "-" + Number(s.retentionDays) + " days",
      ),
      this.q(
        "UPDATE copilot_outbox SET body='' WHERE owner=? AND created_at<? AND status IN ('cancelled','failed','accepted')",
        this.owner,
        cutoff,
      ),
    ]);
    return {
      cutoff,
      summaryRetention:
        "Relationship summaries persist until explicitly deleted.",
    };
  }
}
export async function normalizeSnapshot(
  row: Record<string, unknown>,
  selfId: string,
): Promise<Message | null> {
  const id = (v: unknown) =>
    typeof v === "string" && v.length > 0 && v.length <= 256 ? v : null;
  const sender = id(row["SENDER PROFILE URL"]) || id(row.senderId);
  const thread = id(row["CONVERSATION ID"]) || id(row.threadId);
  const date = id(row.DATE) || id(row.at);
  const text = row.CONTENT ?? row.text;
  if (
    !sender ||
    !thread ||
    !date ||
    typeof text !== "string" ||
    text.length > 16000 ||
    !/(?:UTC|Z|[+-]\d{2}:\d{2})$/.test(date) ||
    !Number.isFinite(Date.parse(date))
  )
    return null;
  const recipients =
    typeof row["RECIPIENT PROFILE URLS"] === "string"
      ? row["RECIPIENT PROFILE URLS"]
          .split(/[,;]\s*/)
          .filter((x) => /^https:\/\/[^/]*linkedin\.com\/in\//.test(x))
      : [];
  return {
    id:
      id(row.id) ?? (await hash(JSON.stringify([thread, sender, date, text]))),
    threadId: thread,
    senderId: sender,
    senderName: String(row.FROM ?? row.senderName ?? sender).slice(0, 300),
    participantIds: recipients,
    text,
    at: new Date(date).toISOString(),
    direction: sender === selfId ? "outbound" : "unknown",
    origin: "snapshot",
  };
}
