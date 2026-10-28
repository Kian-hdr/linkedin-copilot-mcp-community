# Configuration and operation

| Variable                | Required       | Meaning                                                                                                                                                 |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LINKEDIN_ACCESS_TOKEN` | For live reads | Your authorized portability token; private environment only.                                                                                            |
| `LINKEDIN_OWNER_URN`    | For live reads | Exact consenting person URN, independently verified by the provider.                                                                                    |
| `COPILOT_DATA_DIR`      | No             | Absolute private directory outside Git; default under your home directory. Empty means default.                                                         |
| `COMPANY_CRM_ORIGIN`    | No             | Optional HTTPS origin only, without credentials, path, query or fragment. Empty means unconfigured. This does not establish a consumer or send updates. |

`.env.example` contains variable names only. The server does not load it automatically. For real values, use your client's secret store/environment or Node's `--env-file` option pointing outside the checkout. Restrict access to that file. Environment values are read at startup; restart to change credentials/accounts.

The account URN determines a hashed namespace in the local database. Different configured accounts do not share relationship queries. This is a single-user process, not a multi-user server; all clients with access to it have the same owner authority. Do not share the process with untrusted clients.

## Storage

The server creates its private data directory, sets its permissions to 0700 and database permissions to 0600 where supported, and uses SQLite WAL. POSIX permission semantics do not replace Windows ACLs; protect the directory using OS account controls. Do not choose a shared directory, home root or a symlink to a shared location. Use a dedicated directory.

Back up the private data separately from source. Stop every server process using that database before copying the directory, including any SQLite WAL/SHM files. Backups contain confidential message data and must be protected. To restore, stop the server, restore the complete private directory, verify ownership/access, then restart and inspect status. This is not an encrypted backup facility.

`retentionDays` defaults to 90 and can be configured between 7 and 365. Cleanup occurs when `copilot_sync` runs, not on a background timer. It is not a promise of complete erasure: person metadata, summaries, derived annotations, drafts, queues and audit state have separate lifetimes. See [Security](../SECURITY.md) for deletion limits. No scheduler is installed.

## Start, stop and removal

Your MCP client starts the process on demand and stops it using its own controls. `npm start` is for direct stdio use. Runtime requires a supported Node version; no compilation step or web service is needed.

To uninstall, remove the MCP entry from your client and stop its process. Source removal does not remove private data. If you want to erase local state, deliberately remove the dedicated data directory and its backups under your own recovery policy. This has no effect on LinkedIn messages, your external CRM or previously exported assistant transcripts.
