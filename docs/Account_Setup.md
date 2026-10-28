# Connect an authorized LinkedIn account

## Access requirements

This adapter uses Member Data Portability endpoints: `memberAuthorizations`, `memberSnapshotData` for `INBOX`, and `memberChangeLogs`. A normal LinkedIn login token or profile permission is insufficient.

LinkedIn's [third-party portability setup](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-3rd-party/) describes creating a developer application, verifying its Company Page association, requesting the portability product, business verification, and member consent using Authorization Code OAuth. Its documented scope is `r_dma_portability_3rd_party`, and the documented member consent eligibility is EEA users. Access approval and eligibility belong to LinkedIn and may change. Review the current product documentation before relying on it.

1. Obtain approval for the applicable official portability product using your own developer account and application.
2. Implement or use an authorized OAuth flow for that application with a registered redirect URI. This release does not host that flow or refresh tokens for you. Never use browser cookies as API credentials.
3. Obtain the consenting account's actual person URN through the authorized product response. It must have the form `urn:li:person:...`; a public profile slug is not a person URN. The server verifies it against `memberAuthorizations` before fetching inbox data.
4. Put `LINKEDIN_ACCESS_TOKEN` and `LINKEDIN_OWNER_URN` in your private MCP environment. Restart the server after changing them.
5. Call `linkedin_get_connection_status`, then read one bounded inbox page. Verify the account and inspect freshness warnings before synchronization.

You can run and test the local MCP without API access, but live reads and import remain unavailable. This repository cannot grant LinkedIn product approval.

## Provider coverage and version

The adapter currently pins the `Linkedin-Version` header to `202312`, inherited from the qualified portability adapter. Compatibility with a newly approved application is not verified by the offline tests. If LinkedIn returns HTTP 426, it becomes `version_rejected`: check the current official product documentation and qualify an updated version with fixtures and your authorized account. Do not silently switch endpoints or credentials.

Historical snapshots may have unknown generation time and incomplete preparation. Changelog access covers post-consent events with a documented 28-day window. Missed history is recorded as a coverage gap; it is not reconstructed or treated as new unread mail. Unsupported shapes are quarantined for review.

## Errors

| Code                                 | Next step                                                           |
| ------------------------------------ | ------------------------------------------------------------------- |
| `not_configured`                     | Set both authorized variables and restart.                          |
| `wrong_account` / `owner_unverified` | Verify the owner URN and consent. Do not bypass the identity check. |
| `authentication_failed`              | Renew authorization through your own app.                           |
| `access_denied`                      | Check product approval, scope, consent and account eligibility.     |
| `data_unavailable`                   | Check provider preparation/access; it does not mean an empty inbox. |
| `version_rejected`                   | Review the pinned version against official product documentation.   |
| `rate_limited`                       | Defer calls; do not advance checkpoints manually.                   |
| `sync_busy`                          | Another synchronization owns the temporary lease; retry later.      |
| `invalid_window`                     | Choose a timestamp within the supported event window.               |
| `transport_unavailable`              | Sending is not implemented; no setting unlocks it.                  |

## Sending

The public release has no send transport. LinkedIn's [Messages API documentation](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages) restricts that API to approved partners and describes specific member-action requirements. The read product does not grant those messaging capabilities. No browser automation or alternate endpoint is bundled.
