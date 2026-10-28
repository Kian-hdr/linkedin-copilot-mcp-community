# LinkedIn Copilot MCP · Community Edition

A headless, locally installed MCP server for LinkedIn relationship memory, evidence-backed classifications, follow-ups and reply drafts. Your MCP-compatible assistant supplies the reasoning; this server stores channel state and exposes bounded tools.

**Early developer release.** You can install and inspect it without credentials. Reading LinkedIn requires your own approved API application, eligible account and member consent. This is not a universal “sign in with LinkedIn” app. Automatic sending is unavailable: `dm_send` and attempts to enable Auto-reply return `transport_unavailable`.

This is an independently packaged community edition with fresh source history, generic configuration and synthetic tests. It contains no hosted personal installation, deployment identity, owner inbox, operating policy or company-specific CRM adapter. It is not affiliated with or endorsed by LinkedIn.

## What works

- Local stdio MCP, with no web server or graphical interface.
- Account-pinned read adapter for official LinkedIn Member Data Portability APIs.
- Resumable snapshot/event ingestion, duplicate suppression, coverage warnings and unknown-shape quarantine.
- SQLite relationship memory, stable identities, separate business/personal domains and compact person context.
- Source-backed relationship labels, organizations, opportunities and follow-ups.
- Revision-checked edits, manual holds, conversation pauses and cancellation of stale drafts.
- An idempotent draft outbox and business-only event queue for custom CRM integrations.
- Synthetic tests without a LinkedIn account or paid model service.

## What is not included

No automatic DM transport, browser automation, cookie extraction, interactive OAuth onboarding, token refresh service, campaign engine, public comments, scheduler, hosted deployment or bundled CRM consumer. Installing it does not start monitoring, send messages, change existing briefings or connect an external CRM. Your assistant's existing schedules remain its own configuration.

## Quick start

Requires **Node.js 24.13 or newer** and npm. The server uses Node's built-in SQLite and TypeScript support. Git is optional if you use GitHub's **Code → Download ZIP** instead.

```sh
git clone https://github.com/Kian-hdr/linkedin-copilot-mcp-community.git
cd linkedin-copilot-mcp-community
npm ci --ignore-scripts
npm test
npm run typecheck
npm start
```

`npm start` waits for MCP input; it has no terminal menu. Stop with Ctrl+C. No credentials are required for local status, tool discovery and the test suite. Dependency installation is for development checks; the runtime has no third-party dependencies.

### Add to an MCP client

Use your client's local **stdio MCP server** configuration. This common JSON format is illustrative; consult your client's settings format. Replace the path with the absolute location of your downloaded checkout, using escaped backslashes on Windows.

```json
{
  "mcpServers": {
    "linkedin-copilot": {
      "command": "node",
      "args": ["/absolute/path/to/linkedin-copilot-mcp-community/src/server.ts"]
    }
  }
}
```

Use the absolute path to the Node executable too if your desktop client cannot find `node`. Restart/reconnect the client, then ask it to call `copilot_get_status` and `linkedin_get_connection_status`. The latter should report `not_configured` until you add authorized credentials. A connected authorization does not prove that message data is available.

### Connect your own account

See [Account setup](docs/Account_Setup.md) before obtaining a token. The implementation uses LinkedIn's official portability product, not ordinary profile/login permissions. LinkedIn controls approval, region eligibility, consent, data preparation and retention.

Keep secrets in your MCP client's private environment or a private file **outside this repository**. With a private environment file, change the client args to:

```json
[
  "--env-file=/absolute/private/path/copilot.env",
  "/absolute/path/to/linkedin-copilot-mcp-community/src/server.ts"
]
```

Configure `LINKEDIN_ACCESS_TOKEN` and `LINKEDIN_OWNER_URN` there. Never paste tokens into an assistant conversation or GitHub issue. [Configuration](docs/Configuration.md) lists every variable and storage behavior.

## First workflow

1. Call `linkedin_get_connection_status`; resolve access errors before importing.
2. Call `copilot_sync` to import one bounded page. Inspect warnings, unresolved counts and checkpoint. Repeat deliberately to resume; historical snapshots are not live unread messages.
3. Call `crm_list_threads`, then `crm_get_thread` for the actual thread ID and revision.
4. Use `crm_update_relationship` to classify its domain and supported next action. Use message IDs as evidence; do not infer business relevance from a name alone.
5. Use `crm_set_classification` for evidenced relationship labels, then `crm_get_person_context` for compact recall.
6. Call `dm_prepare_draft` with the current thread revision and a stable action ID. Inspect `dm_get_outbox`. No message is sent.

See [Tools](docs/Tools.md) for schemas and examples, [Architecture](docs/Architecture.md) for extension boundaries, and [Security](SECURITY.md) before using real messages.

## Privacy

Local data defaults to `~/.local/share/linkedin-copilot-mcp-community/copilot.sqlite`. Runtime storage is refused inside Git checkouts. SQLite stores message text, source references, classifications, drafts, audit entries and quarantined provider records in plaintext. File protections are not database encryption. Your connected MCP client can read and export this data; its own model/data policies still apply.

There is no telemetry or paid AI fallback. Explicit provider reads contact `api.linkedin.com`; installing dependencies contacts npm. The CRM origin is metadata only and does not trigger network writes. See the [privacy and data lifecycle details](SECURITY.md).

## Development

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run benchmark
npm run check:release
```

Tests use synthetic identities, messages and mock provider responses. The benchmark uses 10,000 synthetic contacts and 100,000 messages against local memory; it does not establish hosted or network latency. No tests send LinkedIn messages.

[Contributing](CONTRIBUTING.md) explains validation and release hygiene. MIT licensed; see [LICENSE](LICENSE). Releases are source downloads, not an npm package or a hosted account.
