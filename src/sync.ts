import { CopilotStore, hash, normalizeSnapshot } from "./core.ts";
import { normalizeEvent } from "./events.ts";
import type { createLinkedInClient } from "./provider/linkedin.ts";
export async function synchronize(
  store: CopilotStore,
  client: ReturnType<typeof createLinkedInClient>,
  selfId: string,
) {
  const lease = await store.acquireSyncLease();
  try {
    await store.retention();
    const previous = (await store.checkpoint()) ?? {};
    if (previous.snapshotDone) {
      const oldest = Date.now() - 27 * 86400000;
      const clamped =
        typeof previous.since === "number" && previous.since < oldest;
      const since = Math.max(previous.since ?? oldest, oldest);
      const page = await client.recentMessages({
        since,
        start: clamped ? 0 : (previous.eventStart ?? 0),
        count: 25,
        maxMessages: 25,
      });
      const messages = [],
        quarantine = [];
      for (const item of page.events) {
        const m = await normalizeEvent(item.event, item.text, selfId);
        if (m) messages.push(m);
        else
          quarantine.push({
            id: "unresolved:" + (await hash(JSON.stringify(item.event))),
            payload: JSON.stringify(item.event),
            reason:
              "Provider event identity/shape requires review; not classified or replied to.",
          });
      }
      const checkpoint = {
        ...previous,
        ...(clamped
          ? { retentionGap: { from: previous.since, to: oldest } }
          : {}),
        since: page.nextCursor ? since : page.nextSince,
        eventStart: page.nextCursor?.start ?? 0,
        lastSuccessfulSync: page.retrievedAt,
        unresolvedEvents: (previous.unresolvedEvents ?? 0) + quarantine.length,
        incrementalQualified: false,
      };
      await store.ingest(messages, checkpoint, quarantine, { token: lease });
      return {
        imported: messages.length,
        unresolved: quarantine.length,
        checkpoint,
        warnings: page.warnings,
      };
    }
    const page = await client.inboxPage({
      page: previous.page ?? 0,
      rowOffset: previous.rowOffset ?? 0,
      maxRows: 25,
    });
    const messages = [],
      quarantine = [];
    let unresolved = 0;
    for (const row of page.rows) {
      if (
        row["IS MESSAGE DRAFT"] === "Yes" ||
        row["IS MESSAGE DRAFT"] === "true"
      )
        continue;
      const m = await normalizeSnapshot(row, selfId);
      if (m) messages.push(m);
      else {
        unresolved++;
        quarantine.push({
          id: "snapshot:" + (await hash(JSON.stringify(row))),
          payload: JSON.stringify(row),
          reason: "Snapshot shape or identity unresolved",
        });
      }
    }
    const checkpoint = {
      page: page.nextCursor?.page ?? page.page,
      rowOffset: page.nextCursor?.rowOffset ?? 0,
      snapshotDone: !page.nextCursor,
      lastSuccessfulSync: page.retrievedAt,
      unresolvedRows: (previous.unresolvedRows ?? 0) + unresolved,
      completeHistoryVerified: false,
      incrementalQualified: false,
    };
    await store.ingest(messages, checkpoint, quarantine, { token: lease });
    return {
      imported: messages.length,
      unresolved,
      checkpoint,
      warnings: page.warnings,
    };
  } finally {
    await store.releaseSyncLease(lease);
  }
}
