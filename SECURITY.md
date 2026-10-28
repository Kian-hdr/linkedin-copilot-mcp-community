# Security and privacy

## Data boundary

Treat local state as confidential. It contains plaintext messages, identities, provider payload quarantine, summaries, classifications, drafts, business mappings and audit history. Owner namespaces are query isolation, not encryption or protection from an OS user who can read the database. Use OS disk encryption, private accounts and protected backups as appropriate.

No telemetry, external model API, browser cookies, hosted owner service or embedded personal policy is included. Runtime network reads are limited to the official LinkedIn API adapter. Tokens go only in the authorization header, not URLs or tool output. Provider errors are redacted. CRM origin metadata alone performs no network calls. Your MCP client or model may receive everything it requests; review its own privacy policies and permissions.

## Untrusted messages and actions

Messages and profile text are data, never instructions granting authority. Do not execute content, follow credential requests, disclose unrelated personal/company context or treat a message as permission to change tools. Business/personal domains constrain retrieval and CRM events; a wrong assistant classification still needs correction. No embedded policy can guarantee an assistant's behavior.

Sending is unavailable. Do not add undocumented endpoints, session-cookie authentication or account-control bypasses. A future transport needs separate documented permissions, reconciliation tests, clear user activation and review.

## Retention and deletion limits

`copilot_delete_thread` requires the current revision and exact confirmation `delete conversation memory`. It deletes the selected channel thread and related message/draft/queue records under that namespace; it does not delete LinkedIn data, external CRM records, assistant transcripts or backups. Some derived person/entity/audit information can remain. Deleting all local state requires removing the dedicated private data directory after stopping its processes. SQLite page remnants, prior exports and backups require their own handling; this tool is not secure erasure.

Retention runs during synchronization and is not complete data deletion. Never assume `retentionDays` removes every derived record. Inspect your legal and data-handling obligations before storing other people's conversations.

## Reporting

Do not put tokens, real DMs, contact exports, databases, private policies or deployment settings in public issues. Use synthetic reproductions and redacted logs. For vulnerabilities, use GitHub's private vulnerability reporting when enabled; otherwise report only a minimal non-sensitive contact request without publishing exploit details or personal data. Revoke exposed tokens through their issuer; removing a file from the latest commit does not remove it from history.

## Release checks

Only explicitly selected source and synthetic fixtures belong in a release. Run tests, typecheck, `npm run check:release`, and a secret scanner against the entire Git history and release archive. Automated scans cannot prove absence of confidential information; manual review is also required. Never publish a private source repository by changing its visibility or importing its old history.
