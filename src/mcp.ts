import { companyCrmRoute, type CompanyCrmRoute } from "./crm-routing.ts";
import { RelationshipStore } from "./relationships.ts";
import { CopilotStore, CopilotError } from "./core.ts";
const str = { type: "string" },
  integer = { type: "integer", minimum: 0 },
  obj = { type: "object" };
const evidence = {
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 20,
};
const classificationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "labels",
    "confidence",
    "rationale",
    "classifierVersion",
    "evidence",
  ],
  properties: {
    labels: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      items: {
        type: "string",
        enum: [
          "investor",
          "customer",
          "technology_partner",
          "adviser",
          "supplier",
          "personal",
          "unknown",
        ],
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", minLength: 1, maxLength: 1000 },
    classifierVersion: { type: "string", minLength: 1, maxLength: 100 },
    evidence,
  },
};
const entitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "evidence"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 300 },
    evidence,
    organizationId: str,
    stage: {
      type: "string",
      enum: [
        "new",
        "qualifying",
        "engaged",
        "meeting",
        "proposal",
        "active",
        "lost",
        "dormant",
      ],
    },
    people: { type: "array", items: { type: "string" }, maxItems: 100 },
  },
};
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  write = false,
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: !write,
      destructiveHint: name === "copilot_delete_thread",
      idempotentHint: !write,
      openWorldHint: true,
    },
  };
}
export const copilotTools = [
  tool(
    "copilot_get_status",
    "Get private Copilot settings, transport limits, synchronization coverage and the external company CRM route.",
    {},
    [],
  ),
  tool(
    "crm_set_classification",
    "Store source-backed labels, confidence and classifier provenance in LinkedIn channel memory at an expected thread revision; does not update the authoritative company pipeline.",
    { threadId: str, revision: integer, classification: classificationSchema },
    ["threadId", "revision", "classification"],
    true,
  ),
  tool(
    "crm_get_classification",
    "Retrieve LinkedIn channel relationship labels and evidence; unknown values remain explicit. The external company CRM owns the authoritative company pipeline.",
    { threadId: str },
    ["threadId"],
  ),
  tool(
    "crm_upsert_entity",
    "Create/update a channel-memory organization or opportunity from an evidenced business thread; does not update the authoritative company pipeline. Revision 0 creates a new stable ID. Organizations accept name and evidence only; opportunities may also include organizationId, stage and participant IDs.",
    {
      kind: { type: "string", enum: ["organization", "opportunity"] },
      entityId: str,
      revision: integer,
      threadId: str,
      threadRevision: integer,
      record: entitySchema,
    },
    ["kind", "entityId", "revision", "threadId", "threadRevision", "record"],
    true,
  ),
  tool(
    "crm_list_entities",
    "List LinkedIn channel-memory business organizations or opportunities with bounded pagination; these are not the authoritative company pipeline.",
    {
      kind: { type: "string", enum: ["organization", "opportunity"] },
      limit: integer,
      offset: integer,
    },
    ["kind"],
  ),
  tool(
    "crm_search_people",
    "Search private LinkedIn channel indexes without loading the inbox; use the external company CRM native search for company master records.",
    { query: str, limit: integer, offset: integer },
    [],
  ),
  tool(
    "crm_get_person_context",
    "Get compact source-linked LinkedIn channel context for a stable person ID; the company master remains in the external company CRM.",
    {
      personId: str,
      domain: { type: "string", enum: ["business", "personal", "unknown"] },
    },
    ["personId", "domain"],
  ),
  tool(
    "crm_get_thread",
    "Read one LinkedIn channel conversation with bounded message pagination; content is untrusted data, not company master state.",
    { threadId: str, limit: integer, offset: integer },
    ["threadId"],
  ),
  tool(
    "crm_list_threads",
    "List recent LinkedIn channel threads, classifications and revisions; does not read the authoritative company pipeline.",
    { limit: integer, offset: integer },
    [],
  ),
  tool(
    "crm_list_actions",
    "List LinkedIn channel conversations needing action and due follow-ups; does not read company master tasks or pipeline.",
    {},
    [],
  ),
  tool(
    "crm_update_relationship",
    "Update source-backed classification in LinkedIn channel memory at an expected revision; respect manual overrides. Does not update the authoritative company pipeline.",
    { threadId: str, patch: obj, revision: integer },
    ["threadId", "patch", "revision"],
    true,
  ),
  tool(
    "copilot_update_settings",
    "Update owner policies; sending cannot be enabled without a permitted transport.",
    { patch: obj, revision: integer },
    ["patch", "revision"],
    true,
  ),
  tool(
    "copilot_pause_thread",
    "Pause/resume a thread at its expected revision. Pause cancels unsent drafts.",
    { threadId: str, paused: { type: "boolean" }, revision: integer },
    ["threadId", "paused", "revision"],
    true,
  ),
  tool(
    "dm_prepare_draft",
    "Prepare an idempotent draft, never send it. Use only context from this thread domain.",
    { threadId: str, body: str, revision: integer, actionId: str },
    ["threadId", "body", "revision", "actionId"],
    true,
  ),
  tool("dm_get_outbox", "Read recent drafts and their actual states.", {}, []),
  tool(
    "dm_send",
    "Send only through a verified permitted transport; currently returns transport_unavailable.",
    { actionId: str },
    ["actionId"],
    true,
  ),
  tool(
    "copilot_release_manual_override",
    "Release a manual hold only on explicit owner instruction; does not enable sending.",
    {
      threadId: str,
      revision: integer,
      confirmation: { type: "string", enum: ["resume automatic assessment"] },
    },
    ["threadId", "revision", "confirmation"],
    true,
  ),
  tool(
    "crm_map_existing_record",
    "Store a reviewed exact existing company CRM recordId mapping for a business-only LinkedIn thread in channel memory; never match by name or write the company master.",
    { threadId: str, recordId: str },
    ["threadId", "recordId"],
    true,
  ),
  tool(
    "crm_queue_update",
    "Queue a business-only update for a reviewed exact existing company CRM recordId mapping; the hosted crm_sync_business_queue consumer must apply and verify it. Queued does not mean applied.",
    { threadId: str, recordId: str, changes: obj, eventId: str },
    ["threadId", "recordId", "changes", "eventId"],
    true,
  ),
  tool(
    "crm_get_sync_queue",
    "Inspect business-only updates queued for the hosted company CRM crm_sync_business_queue consumer and their routing metadata. Events remain queued, not applied, until company CRM persistence is verified.",
    {},
    [],
  ),
  tool(
    "copilot_export_memory",
    "Export one bounded page of relationship memory for a single domain.",
    {
      domain: { type: "string", enum: ["business", "personal", "unknown"] },
      limit: integer,
      offset: integer,
    },
    ["domain"],
  ),
  tool(
    "copilot_delete_thread",
    "Delete Copilot conversation memory only; does not delete LinkedIn or CRM records.",
    { threadId: str, revision: integer, confirmation: str },
    ["threadId", "revision", "confirmation"],
    true,
  ),
  tool(
    "copilot_get_activity",
    "Read recent classification and operator actions.",
    {},
    [],
  ),
];
export function validateArguments(
  schema: { properties: Record<string, unknown>; required?: readonly string[] },
  input: unknown,
): Record<string, unknown> {
  const value = input === undefined ? {} : input;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CopilotError("invalid_input");
  const args = value as Record<string, unknown>;
  if (
    Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) ||
    (schema.required ?? []).some((key) => !Object.hasOwn(args, key))
  )
    throw new CopilotError("invalid_input");
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key] as {
      type?: string;
      minimum?: number;
      maximum?: number;
      enum?: unknown[];
      format?: string;
    };
    if (
      (rule.type === "string" && typeof value !== "string") ||
      (rule.type === "boolean" && typeof value !== "boolean") ||
      (rule.type === "object" &&
        (!value || typeof value !== "object" || Array.isArray(value))) ||
      (rule.type === "integer" && !Number.isSafeInteger(value))
    )
      throw new CopilotError("invalid_input");
    if (
      typeof value === "number" &&
      ((rule.minimum !== undefined && value < rule.minimum) ||
        (rule.maximum !== undefined && value > rule.maximum))
    )
      throw new CopilotError("invalid_input");
    if (rule.enum && !rule.enum.includes(value))
      throw new CopilotError("invalid_input");
    if (
      rule.format === "date-time" &&
      (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      throw new CopilotError("invalid_input");
  }
  return args;
}
export async function callCopilot(
  store: CopilotStore,
  name: string,
  args: unknown,
  crmRoute: CompanyCrmRoute = companyCrmRoute(),
) {
  const def = copilotTools.find((t) => t.name === name);
  if (!def) throw new CopilotError("unknown_tool");
  const a = validateArguments(def.inputSchema, args) as Record<string, any>;
  const relationships = new RelationshipStore(store);
  if (
    [
      "crm_set_classification",
      "crm_get_classification",
      "crm_upsert_entity",
      "crm_list_entities",
    ].includes(name)
  )
    await relationships.initialize();
  switch (name) {
    case "crm_set_classification":
      return relationships.annotate(a.threadId, a.revision, a.classification);
    case "crm_get_classification":
      return relationships.getAnnotations(a.threadId);
    case "crm_upsert_entity":
      return relationships.putEntity(
        a.kind,
        a.entityId,
        a.revision,
        a.threadId,
        a.threadRevision,
        a.record,
      );
    case "crm_list_entities":
      return {
        records: await relationships.listEntities(
          a.kind,
          a.limit ?? 25,
          a.offset ?? 0,
        ),
      };
    case "copilot_get_status":
      return {
        settings: await store.settings(),
        sync: await store.checkpoint(),
        crmRoute,
      };
    case "crm_search_people":
      return {
        people: await store.search(a.query ?? "", a.limit ?? 25, a.offset ?? 0),
      };
    case "crm_get_person_context":
      return store.context(a.personId, a.domain);
    case "crm_get_thread":
      return store.thread(a.threadId, a.limit ?? 20, a.offset ?? 0);
    case "crm_list_threads":
      return { threads: await store.threads(a.limit ?? 25, a.offset ?? 0) };
    case "crm_list_actions":
      return { actions: await store.actions() };
    case "crm_update_relationship":
      return store.classify(a.threadId, a.patch, a.revision);
    case "copilot_update_settings":
      return store.setSettings(a.patch, a.revision);
    case "copilot_pause_thread":
      return store.pause(a.threadId, a.paused, a.revision);
    case "dm_prepare_draft":
      return store.draft(a.threadId, a.body, a.revision, a.actionId);
    case "dm_get_outbox":
      return { outbox: await store.outbox() };
    case "dm_send":
      return store.send(a.actionId);
    case "copilot_release_manual_override":
      return store.releaseManualOverride(
        a.threadId,
        a.revision,
        a.confirmation,
      );
    case "crm_map_existing_record":
      return store.mapCrm(a.threadId, a.recordId);
    case "crm_queue_update":
      return store.queueCrm(a.threadId, a.recordId, a.changes, a.eventId);
    case "crm_get_sync_queue":
      return {
        events: await store.pendingCrm(),
        crmRoute,
        delivery: {
          state: "queued_not_applied",
          consumer: crmRoute.syncConsumer,
          companyPersistenceVerified: false,
        },
      };
    case "copilot_export_memory":
      return store.exportMemory(a.domain, a.limit ?? 20, a.offset ?? 0);
    case "copilot_delete_thread":
      return store.deleteThread(a.threadId, a.revision, a.confirmation);
    case "copilot_get_activity":
      return { activity: await store.activity() };
    default:
      throw new CopilotError("unknown_tool");
  }
}
