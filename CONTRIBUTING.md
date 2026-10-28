# Contributing

Use a supported Node.js version and run `npm ci --ignore-scripts`, `npm test`, `npm run typecheck`, and `npm run check:release`. Tests must use synthetic records and mocked provider calls. Add focused regression tests for behavior changes; never require real credentials in CI.

Keep the MCP headless. Explain changes to tool schemas and storage. Preserve account/domain isolation, stable identities, expected revisions, manual holds, transactionality and explicit unknowns. Schema changes need a recovery/migration strategy. Do not imply that queueing means CRM application or drafts mean sending.

Never commit real messages, contact lists, runtime files, tokens, private policies or deployment configuration. Do not attach private logs to issues. Use generic examples and reserved `example.test`/`example.com` domains. New providers or send transports require review of actual permissions and failure behavior.

Runtime has no third-party dependencies. Keep package lockfiles pinned and review dependency changes. New dependencies must justify their maintenance and security cost. Do not add paid services, GUI components, schedulers or implicit network actions as installation side effects.

For releases: inspect `git ls-files`, run a full-history secret scan and clean-clone installation, review `npm pack --dry-run`, inspect a source archive, then publish a versioned source release. Ensure no private parent history or remotes are embedded. Public source publication does not publish any installed user's data or configuration.
