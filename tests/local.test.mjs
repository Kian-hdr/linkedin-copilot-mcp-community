import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("clean stdio installation initializes a private database and returns bounded tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "copilot-test-"));
  try {
    const child = spawn(process.execPath, ["src/server.ts"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        COPILOT_DATA_DIR: dir,
        COMPANY_CRM_ORIGIN: "https://crm.example.test",
      },
    });
    let output = "",
      err = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "copilot_get_status", arguments: {} },
        }) +
        "\n",
    );
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, err);
    const r = output
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.equal(r.length, 3);
    assert.equal(r[2].result.structuredContent.settings.autoReply, false);
    assert.equal(
      r[2].result.structuredContent.crmRoute.origin,
      "https://crm.example.test",
    );
    assert.equal(
      r[0].result.serverInfo.version,
      JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      ).version,
    );
    assert(r[1].result.tools.some((t) => t.name === "crm_get_person_context"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("configured local accounts have isolated memory namespaces", async () => {
  const { localOwnerNamespace } = await import("../src/local-identity.ts");
  const { sqliteDatabase } = await import("../src/sqlite.ts");
  const { CopilotStore, migrate } = await import("../src/core.ts");
  const db = sqliteDatabase(":memory:");
  await migrate(db);
  const a = new CopilotStore(
    db,
    await localOwnerNamespace("urn:li:person:account-a"),
  );
  const b = new CopilotStore(
    db,
    await localOwnerNamespace("urn:li:person:account-b"),
  );
  await a.ingest(
    [
      {
        id: "m",
        threadId: "t",
        senderId: "p",
        senderName: "Private Person",
        participantIds: ["p"],
        text: "Account A only",
        at: "2026-10-27T11:00:00Z",
        direction: "inbound",
      },
    ],
    {},
  );
  assert.deepEqual(await b.threads(), []);
  assert.notEqual(
    await localOwnerNamespace(undefined),
    await localOwnerNamespace("urn:li:person:account-a"),
  );
});
