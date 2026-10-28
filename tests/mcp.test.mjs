import test from "node:test";
import assert from "node:assert/strict";
import { copilotTools, callCopilot } from "../src/mcp.ts";
test("tools reject extra arguments before execution", async () => {
  await assert.rejects(
    () => callCopilot({}, "copilot_get_status", { token: "secret" }),
    /invalid_input/,
  );
});
test("tool descriptors distinguish reads and mutations", () => {
  assert.equal(
    copilotTools.find((t) => t.name === "dm_send").annotations.readOnlyHint,
    false,
  );
  assert.equal(
    copilotTools.find((t) => t.name === "crm_get_thread").annotations
      .readOnlyHint,
    true,
  );
  assert(
    copilotTools.every((t) => t.inputSchema.additionalProperties === false),
  );
});
test("argument schemas reject inherited keys, wrong types and fractional revisions", async () => {
  for (const args of [
    { constructor: "unexpected" },
    { revision: 1.5, patch: {} },
    { revision: 0, patch: null },
  ])
    await assert.rejects(
      () => callCopilot({}, "copilot_update_settings", args),
      /invalid_input/,
    );
});

test("local memory deletion is accurately marked destructive", () => {
  assert.equal(
    copilotTools.find((t) => t.name === "copilot_delete_thread").annotations
      .destructiveHint,
    true,
  );
});
