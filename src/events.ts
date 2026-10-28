import { hash, type Message } from "./core.ts";
/** Unknown provider shapes stay quarantined; never infer identities from names. */
export async function normalizeEvent(
  event: Record<string, unknown>,
  text: string | null,
  selfId: string,
): Promise<Message | null> {
  const a = (event.processedActivity ?? event.activity) as
    | Record<string, unknown>
    | undefined;
  if (!a || !text || event.method === "DELETE") return null;
  const sender = a.actor ?? a.author;
  const thread = a.thread ?? a.threadUrn;
  const at = a.createdAt ?? event.capturedAt;
  const id = event.activityId ?? event.id;
  if (
    typeof sender !== "string" ||
    !sender.startsWith("urn:li:") ||
    typeof thread !== "string" ||
    !thread.startsWith("urn:li:") ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    !id
  )
    return null;
  const recipients = Array.isArray(a.recipients)
    ? a.recipients.filter(
        (x): x is string => typeof x === "string" && x.startsWith("urn:li:"),
      )
    : [];
  return {
    id: "event:" + (await hash(String(id))),
    threadId: thread,
    senderId: sender,
    senderName: sender,
    participantIds: recipients,
    text,
    at: new Date(at).toISOString(),
    direction: sender === selfId ? "outbound" : "inbound",
    origin: "changelog",
  };
}
