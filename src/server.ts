/** Local single-owner stdio entrypoint. No listener, scheduler or embedded agent. */
import { createInterface } from "node:readline";
import { mkdirSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { companyCrmRoute } from "./crm-routing.ts";
import { localOwnerNamespace } from "./local-identity.ts";
import { createLinkedInClient, LinkedInError } from "./provider/linkedin.ts";
import { tools as readerTools } from "./provider/tools.ts";
import { synchronize } from "./sync.ts";
import { sqliteDatabase } from "./sqlite.ts";
import { migrate, CopilotStore, CopilotError } from "./core.ts";
import { copilotTools, callCopilot, validateArguments } from "./mcp.ts";

process.umask(0o077);
const root = resolve(
  process.env.COPILOT_DATA_DIR ||
    join(homedir(), ".local", "share", "linkedin-copilot-mcp-community"),
);
mkdirSync(root, { recursive: true, mode: 0o700 });
for (let path = realpathSync(root); ; ) {
  if (existsSync(join(path, ".git")))
    throw new Error("COPILOT_DATA_DIR must be outside a Git checkout.");
  if (dirname(path) === path) break;
  path = dirname(path);
}
chmodSync(root, 0o700);
const db = sqliteDatabase(join(root, "copilot.sqlite"));
await migrate(db);
const store = new CopilotStore(
  db,
  await localOwnerNamespace(process.env.LINKEDIN_OWNER_URN),
);
const client = createLinkedInClient({
  token: process.env.LINKEDIN_ACCESS_TOKEN,
  expectedOwnerUrn: process.env.LINKEDIN_OWNER_URN,
});
const route = companyCrmRoute(process.env.COMPANY_CRM_ORIGIN || undefined);
const syncTool = {
  name: "copilot_sync",
  description:
    "Import one bounded provider page. Does not send messages. Repeat deliberately to resume; inspect coverage warnings.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};
const tools = [...readerTools, ...copilotTools, syncTool];
async function call(name: string, input: unknown) {
  const descriptor = [...readerTools, syncTool].find(
    (tool) => tool.name === name,
  );
  const args = descriptor
    ? validateArguments(descriptor.inputSchema, input)
    : {};
  if (name === "linkedin_get_connection_status") return client.status();
  if (name === "linkedin_get_inbox_page")
    return client.inboxPage({
      page: args.page as number | undefined,
      rowOffset: args.row_offset as number | undefined,
      maxRows: args.limit as number | undefined,
    });
  if (name === "linkedin_get_recent_messages")
    return client.recentMessages({
      since: Date.parse(String(args.since)),
      start: args.start as number | undefined,
      count: args.count as number | undefined,
      maxMessages: args.limit as number | undefined,
    });
  if (name === "copilot_sync")
    return synchronize(store, client, process.env.LINKEDIN_OWNER_URN ?? "");
  return callCopilot(store, name, input, route);
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const reply = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let rpc: unknown;
  try {
    rpc = Buffer.byteLength(line) <= 65536 ? JSON.parse(line) : null;
  } catch {
    reply({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON." },
    });
    continue;
  }
  if (
    !object(rpc) ||
    rpc.jsonrpc !== "2.0" ||
    typeof rpc.method !== "string" ||
    ("id" in rpc &&
      typeof rpc.id !== "string" &&
      typeof rpc.id !== "number" &&
      rpc.id !== null)
  ) {
    reply({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request." },
    });
    continue;
  }
  if (!("id" in rpc)) continue;
  const id = rpc.id;
  let result: unknown;
  if (rpc.method === "initialize")
    result = {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "linkedin-copilot-mcp-community", version: "0.1.0" },
    };
  else if (rpc.method === "tools/list") result = { tools };
  else if (rpc.method === "ping") result = {};
  else if (rpc.method === "tools/call") {
    if (!object(rpc.params) || typeof rpc.params.name !== "string") {
      reply({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Tool name is required." },
      });
      continue;
    }
    try {
      const value = await call(rpc.params.name, rpc.params.arguments);
      result = {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      };
    } catch (error) {
      const code =
        error instanceof CopilotError || error instanceof LinkedInError
          ? error.code
          : "request_failed";
      result = { isError: true, content: [{ type: "text", text: code }] };
    }
  } else {
    reply({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found." },
    });
    continue;
  }
  reply({ jsonrpc: "2.0", id, result });
}
