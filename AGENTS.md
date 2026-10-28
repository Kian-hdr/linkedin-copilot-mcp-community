# Contributor instructions

This is a public, independent community edition. Keep all examples synthetic and all credentials, messages, private policies, databases and deployment configuration out of source and Git history.

The MCP is headless and single-user/local. Preserve stable IDs, account/domain isolation, current revisions, manual holds, atomic checkpoints and fail-closed sending. Do not add an embedded agent, GUI, scheduler or paid service as an implicit part of development.

Read README.md, SECURITY.md and the relevant docs before changes. Validate with npm test, npm run typecheck and npm run check:release. Do not require real provider credentials or network writes in tests. Public claims must match demonstrated behavior.
