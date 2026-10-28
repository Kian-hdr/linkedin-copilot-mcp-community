import test from "node:test";
import assert from "node:assert/strict";
import { createLinkedInClient } from "../src/provider/linkedin.ts";
const owner = "urn:li:person:synthetic-owner";
const authorization = {
  elements: [
    { memberComplianceAuthorizationKey: { member: owner }, regulatedAt: 1000 },
  ],
};
const response = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
test("unconfigured status makes no request and inbox requires credentials", async () => {
  const client = createLinkedInClient({
    fetchImpl: async () => {
      throw Error("must not fetch");
    },
  });
  assert.equal((await client.status()).state, "not_configured");
  await assert.rejects(() => client.inboxPage(), { code: "not_configured" });
});
test("owner mismatch blocks inbox request before any message retrieval", async () => {
  let calls = 0;
  const client = createLinkedInClient({
    token: "synthetic",
    expectedOwnerUrn: owner,
    fetchImpl: async () => {
      calls++;
      return response({
        elements: [
          {
            memberComplianceAuthorizationKey: {
              member: "urn:li:person:someone-else",
            },
          },
        ],
      });
    },
  });
  await assert.rejects(() => client.inboxPage(), { code: "wrong_account" });
  assert.equal(calls, 1);
});
test("bounded official snapshot is authenticated and paginates within a page", async () => {
  const calls = [];
  const client = createLinkedInClient({
    token: "synthetic",
    expectedOwnerUrn: owner,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return response(
        calls.length === 1
          ? authorization
          : {
              elements: [
                {
                  snapshotDomain: "INBOX",
                  snapshotData: [{ CONTENT: "one" }, { CONTENT: "two" }],
                },
              ],
            },
      );
    },
  });
  const page = await client.inboxPage({ maxRows: 1 });
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.nextCursor, { page: 0, rowOffset: 1 });
  assert.equal(calls[1].url.origin, "https://api.linkedin.com");
  assert.equal(calls[1].url.searchParams.get("domain"), "INBOX");
  assert.equal(calls[1].options.headers.Authorization, "Bearer synthetic");
  assert.equal(calls[1].options.redirect, "manual");
  assert.equal(page.completeHistoryVerified, false);
});
test("pagination cannot redirect requests off the official endpoint", async () => {
  const client = createLinkedInClient({
    token: "synthetic",
    expectedOwnerUrn: owner,
    fetchImpl: async (url) =>
      response(
        String(url).includes("memberAuthorizations")
          ? authorization
          : {
              elements: [{ snapshotDomain: "INBOX", snapshotData: [] }],
              paging: {
                links: [
                  { rel: "next", href: "https://example.test/collect?start=1" },
                ],
              },
            },
      ),
  });
  await assert.rejects(() => client.inboxPage(), {
    code: "invalid_pagination",
  });
});
test("provider failures do not expose response bodies or credentials", async () => {
  const client = createLinkedInClient({
    token: "synthetic-private-value",
    expectedOwnerUrn: owner,
    fetchImpl: async () =>
      new Response("provider-confidential-body", { status: 401 }),
  });
  await assert.rejects(
    () => client.status(),
    (e) =>
      e.code === "authentication_failed" &&
      !String(e).includes("confidential") &&
      !String(e).includes("synthetic-private"),
  );
});
test("redirect responses are not followed and oversized bodies are rejected", async () => {
  for (const [responseValue, code] of [
    [
      new Response(null, {
        status: 302,
        headers: { location: "https://example.test" },
      }),
      "provider_failed",
    ],
    [new Response("x".repeat(2048)), "response_too_large"],
  ]) {
    const client = createLinkedInClient({
      token: "synthetic",
      expectedOwnerUrn: owner,
      maxResponseBytes: 1024,
      fetchImpl: async () => responseValue,
    });
    await assert.rejects(() => client.status(), { code });
  }
});
