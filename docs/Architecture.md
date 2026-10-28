# Architecture and integration boundaries

```text
MCP-compatible assistant (reasoning and user policy)
                 | stdio JSON-RPC
          src/server.ts
           /           \
provider read adapter   revision-checked relationship store
api.linkedin.com                  | SQLite
                                  | drafts and business-event queue
```

The community edition is a local distribution. It does not inherit any hosted installation, owner configuration, policy, account connection, schedules or company service. Hosted deployment is not part of this release. The portable SQL abstraction can support a future reviewed adapter; that is not a qualified hosted deployment.

## Modules

- `provider/linkedin.ts`: bounded GET requests, provider identity verification, pagination validation, redacted failure codes.
- `provider/tools.ts`: read-only tool descriptions and argument schemas.
- `sync.ts`, `events.ts`: resumable import, normalization, quarantine and lease fencing.
- `core.ts`, `sqlite.ts`: transactional SQLite state, owner namespaces, revisions, drafts and queue.
- `relationships.ts`, `relationship-schema.ts`: evidence-backed annotations and stable entity records.
- `mcp.ts`: tool definitions and validated dispatch.
- `crm-routing.ts`: optional external-CRM contract metadata, with no authenticated consumer.
- `server.ts`: single-owner stdio entrypoint; no HTTP server or agent loop.

The assistant must supply classification and private policy. Stored policy strings are context/settings only; this server is not a business reasoning engine. Technical guards enforce account/domain isolation, revisions, manual holds and disabled sending.

## Custom CRM integrations

The `crm_*` prefix includes channel-memory tools and does not imply authority over an external business database. With no consumer installed, queued events remain queued indefinitely.

1. Classify a thread as business based on evidence.
2. Independently resolve an exact existing record in your CRM and review the mapping. `crm_map_existing_record` stores its stable ID; it does not create or verify that external record.
3. `crm_queue_update` creates a bounded event for the reviewed mapping. Source message events can also queue supported last-communication/reply changes. Personal threads cannot enter the business queue.
4. Inspect `crm_get_sync_queue`. Queue state is not delivery or application.

Routing metadata names `crm_sync_business_queue` and native company-record methods as an **expected adapter contract**, not tools supplied by this repository. A real consumer needs its own authentication, exact-ID mapping checks, idempotent event ledger, revision-checked narrow writes, readback and acknowledgement mechanism. This community stdio edition supplies no authenticated queue transport/acknowledgement endpoint or consumer. Do not claim synchronization merely because an origin is configured. Implementing a CRM integration requires additional work and tests.

## Drafts and concurrency

Read the latest thread revision before a mutation. Stale revisions fail; re-read context and recompute rather than retrying an old patch blindly. Manual changes hold automatic assessment until deliberately released. New context or pause cancels pending drafts. Stable action IDs deduplicate draft creation. The send tool always fails closed in this edition.

Synchronization uses an owner-scoped expiring lease and transactional checkpoint commits. Expired workers cannot advance an old cursor. Unsupported shapes remain explicit, and no full-history or unread-state guarantee is made.
