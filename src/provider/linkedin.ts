/** Read-only, account-pinned adapter for LinkedIn's official Portability API. */
export type JsonRecord = Record<string, unknown>;
export type LinkedInConfig = {
  token?: string;
  expectedOwnerUrn?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export class LinkedInError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "LinkedInError";
    this.code = code;
    this.status = status;
  }
}

const ORIGIN = "https://api.linkedin.com";
const VERSION = "202312";
const DAY = 86_400_000;
const record = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function integer(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new LinkedInError(
      "invalid_input",
      `${label} must be an integer from ${min} to ${max}.`,
    );
  }
  return value;
}

export function createLinkedInClient(config: LinkedInConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = integer(
    config.timeoutMs ?? 15_000,
    100,
    30_000,
    "timeoutMs",
  );
  const maxBytes = integer(
    config.maxResponseBytes ?? 4_194_304,
    1024,
    8_388_608,
    "maxResponseBytes",
  );
  const configured = Boolean(
    config.token?.trim() && config.expectedOwnerUrn?.trim(),
  );

  function checkConfig() {
    if (!configured) {
      throw new LinkedInError(
        "not_configured",
        "LinkedIn access token and expected account owner are not configured.",
      );
    }
    if (!/^urn:li:person:[A-Za-z0-9_-]+$/.test(config.expectedOwnerUrn!)) {
      throw new LinkedInError(
        "not_configured",
        "The expected LinkedIn account owner is not a valid person URN.",
      );
    }
  }

  async function get(
    endpoint: string,
    query: Record<string, string>,
  ): Promise<JsonRecord> {
    checkConfig();
    const url = new URL(`/rest/${endpoint}`, ORIGIN);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new LinkedInError(
              "timeout",
              "LinkedIn did not respond within the request timeout.",
            ),
          );
        }, timeoutMs);
      });
      const work = async () => {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${config.token!}`,
            "Linkedin-Version": VERSION,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          const failures: Record<number, [string, string]> = {
            400: [
              "provider_query_rejected",
              "LinkedIn rejected this query or domain. Verify the app's portability product.",
            ],
            401: [
              "authentication_failed",
              "LinkedIn access expired, was revoked, or is invalid. Reconnect the account.",
            ],
            403: [
              "access_denied",
              "LinkedIn denied access. Check product access, member consent and scope.",
            ],
            404: [
              "data_unavailable",
              "LinkedIn data is unavailable or still being prepared. This does not prove the inbox is empty.",
            ],
            426: [
              "version_rejected",
              "LinkedIn rejected the pinned API version. Verify current official Portability documentation.",
            ],
            429: [
              "rate_limited",
              "LinkedIn rate-limited this request. Retry later without advancing the cursor.",
            ],
          };
          const [code, message] = failures[response.status] ?? [
            "provider_failed",
            "LinkedIn could not complete this request. Retry later.",
          ];
          await response.body?.cancel().catch(() => undefined);
          throw new LinkedInError(code, message, response.status);
        }
        if (Number(response.headers.get("Content-Length")) > maxBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new LinkedInError(
            "response_too_large",
            "LinkedIn returned more data than the bounded response limit.",
          );
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > maxBytes) {
              await reader.cancel().catch(() => undefined);
              throw new LinkedInError(
                "response_too_large",
                "LinkedIn returned more data than the bounded response limit.",
              );
            }
            chunks.push(part.value);
          }
        }
        const joined = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(joined));
        } catch {
          throw new LinkedInError(
            "invalid_response",
            "LinkedIn returned an unreadable response.",
          );
        }
        if (!record(payload))
          throw new LinkedInError(
            "invalid_response",
            "LinkedIn returned an unexpected response shape.",
          );
        return payload;
      };
      return await Promise.race([work(), timeout]);
    } catch (error) {
      if (error instanceof LinkedInError) throw error;
      // Never return provider bodies, URLs containing credentials, or fetch exception text.
      throw new LinkedInError(
        "network_failed",
        "The LinkedIn request failed. Check connectivity and retry later.",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function authorize() {
    const payload = await get("memberAuthorizations", {
      q: "memberAndApplication",
    });
    if (
      !Array.isArray(payload.elements) ||
      payload.elements.length !== 1 ||
      !record(payload.elements[0])
    ) {
      throw new LinkedInError(
        "owner_unverified",
        "LinkedIn did not return one unambiguous account authorization.",
      );
    }
    const authorization = payload.elements[0];
    const key = authorization.memberComplianceAuthorizationKey;
    if (!record(key) || typeof key.member !== "string") {
      throw new LinkedInError(
        "owner_unverified",
        "LinkedIn did not identify the authorized account owner.",
      );
    }
    if (key.member !== config.expectedOwnerUrn) {
      throw new LinkedInError(
        "wrong_account",
        "The connected LinkedIn account does not match the configured owner. No messages were retrieved.",
      );
    }
    const regulatedAt =
      typeof authorization.regulatedAt === "number"
        ? authorization.regulatedAt
        : null;
    return { ownerUrn: key.member, regulatedAt };
  }

  function nextPage(
    payload: JsonRecord,
    endpoint: string,
    required: Record<string, string>,
    page: number,
  ) {
    const paging = record(payload.paging) ? payload.paging : {};
    const links = Array.isArray(paging.links) ? paging.links : [];
    const next = links.filter((link) => record(link) && link.rel === "next");
    if (next.length > 1)
      throw new LinkedInError(
        "invalid_pagination",
        "LinkedIn returned conflicting pagination links.",
      );
    if (next.length === 0)
      return {
        providerNextPage: null,
        providerTotal: typeof paging.total === "number" ? paging.total : null,
      };
    const href = (next[0] as JsonRecord).href;
    if (typeof href !== "string")
      throw new LinkedInError(
        "invalid_pagination",
        "LinkedIn returned an invalid pagination link.",
      );
    let url: URL;
    try {
      url = new URL(href, ORIGIN);
    } catch {
      throw new LinkedInError(
        "invalid_pagination",
        "LinkedIn returned an invalid pagination link.",
      );
    }
    const allowed = new Set([...Object.keys(required), "start", "count"]);
    if (
      url.origin !== ORIGIN ||
      url.pathname !== `/rest/${endpoint}` ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new LinkedInError(
        "invalid_pagination",
        "LinkedIn returned a pagination link outside the permitted API endpoint.",
      );
    }
    for (const [name] of url.searchParams) {
      if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) {
        throw new LinkedInError(
          "invalid_pagination",
          "LinkedIn returned an unexpected pagination query.",
        );
      }
    }
    for (const [name, value] of Object.entries(required)) {
      if (url.searchParams.get(name) !== value) {
        throw new LinkedInError(
          "invalid_pagination",
          "LinkedIn pagination changed the requested account-data query.",
        );
      }
    }
    const rawStart = url.searchParams.get("start");
    if (!rawStart || !/^\d+$/.test(rawStart))
      throw new LinkedInError(
        "invalid_pagination",
        "LinkedIn returned an invalid page cursor.",
      );
    const nextStart = integer(Number(rawStart), 0, 1000, "next page");
    if (nextStart <= page)
      throw new LinkedInError(
        "invalid_pagination",
        "LinkedIn pagination did not advance.",
      );
    const rawCount = url.searchParams.get("count");
    if (
      rawCount &&
      (!/^\d+$/.test(rawCount) || Number(rawCount) > 50 || Number(rawCount) < 1)
    ) {
      throw new LinkedInError(
        "invalid_pagination",
        "LinkedIn returned an invalid page size.",
      );
    }
    return {
      providerNextPage: nextStart,
      providerTotal: typeof paging.total === "number" ? paging.total : null,
    };
  }

  async function status() {
    if (!configured)
      return {
        configured: false as const,
        connected: false as const,
        state: "not_configured",
        verifiedAt: new Date(now()).toISOString(),
      };
    const authorization = await authorize();
    return {
      configured: true as const,
      connected: true as const,
      state: "authorized",
      ...authorization,
      verifiedAt: new Date(now()).toISOString(),
      inboxVerified: false,
    };
  }

  async function inboxPage(
    options: { page?: number; rowOffset?: number; maxRows?: number } = {},
  ) {
    const page = integer(options.page ?? 0, 0, 1000, "page");
    const rowOffset = integer(
      options.rowOffset ?? 0,
      0,
      1_000_000,
      "rowOffset",
    );
    const maxRows = integer(options.maxRows ?? 100, 1, 500, "maxRows");
    const authorization = await authorize();
    const required = { q: "criteria", domain: "INBOX" };
    const payload = await get("memberSnapshotData", {
      ...required,
      start: String(page),
    });
    if (
      !Array.isArray(payload.elements) ||
      payload.elements.length !== 1 ||
      !record(payload.elements[0]) ||
      payload.elements[0].snapshotDomain !== "INBOX" ||
      !Array.isArray(payload.elements[0].snapshotData)
    ) {
      throw new LinkedInError(
        "invalid_response",
        "LinkedIn did not return the requested inbox snapshot domain.",
      );
    }
    const rows = payload.elements[0].snapshotData;
    if (!rows.every(record))
      throw new LinkedInError(
        "invalid_response",
        "LinkedIn returned unexpected inbox row data.",
      );
    if (rowOffset > rows.length)
      throw new LinkedInError(
        "invalid_input",
        "rowOffset is beyond this provider page; restart the page.",
      );
    const pagination = nextPage(payload, "memberSnapshotData", required, page);
    const selectedRows = rows.slice(rowOffset, rowOffset + maxRows);
    const truncated = rowOffset + selectedRows.length < rows.length;
    const nextCursor = truncated
      ? { page, rowOffset: rowOffset + selectedRows.length }
      : pagination.providerNextPage === null
        ? null
        : { page: pagination.providerNextPage, rowOffset: 0 };
    return {
      ...authorization,
      rows: selectedRows,
      count: selectedRows.length,
      page,
      rowOffset,
      ...pagination,
      nextCursor,
      truncated,
      retrievedAt: new Date(now()).toISOString(),
      completeHistoryVerified: false,
      snapshotGeneratedAt: null,
      warnings: [
        "Snapshot freshness and full-history completeness are not supplied by LinkedIn.",
        ...(truncated
          ? [
              "Additional rows remain on this provider page; continue with nextCursor.",
            ]
          : []),
        ...(nextCursor === null
          ? [
              "No next link was supplied. This does not prove that offline snapshot preparation is complete.",
            ]
          : []),
      ],
    };
  }

  async function recentMessages(options: {
    since: number;
    start?: number;
    count?: number;
    maxMessages?: number;
  }) {
    const since = integer(options.since, 0, Number.MAX_SAFE_INTEGER, "since");
    const requestedAt = now();
    if (since > requestedAt || since < requestedAt - 28 * DAY) {
      throw new LinkedInError(
        "invalid_window",
        "since must be within the last 28 days and cannot be in the future.",
      );
    }
    const start = integer(options.start ?? 0, 0, 1000, "start");
    const count = integer(options.count ?? 10, 1, 50, "count");
    const maxMessages = integer(
      options.maxMessages ?? 50,
      1,
      50,
      "maxMessages",
    );
    const authorization = await authorize();
    const required = { q: "memberAndApplication", startTime: String(since) };
    const payload = await get("memberChangeLogs", {
      ...required,
      start: String(start),
      count: String(count),
    });
    if (
      !Array.isArray(payload.elements) ||
      !payload.elements.every(record) ||
      payload.elements.length > 50
    ) {
      throw new LinkedInError(
        "invalid_response",
        "LinkedIn returned unexpected changelog event data.",
      );
    }
    const pagination = nextPage(payload, "memberChangeLogs", required, start);
    const elements = payload.elements as JsonRecord[];
    const messageEvents = elements.filter(
      (event) => event.resourceName === "messages",
    );
    if (messageEvents.length > maxMessages) {
      throw new LinkedInError(
        "output_limit",
        "This changelog page exceeds maxMessages. Increase maxMessages or reduce count without advancing the cursor.",
      );
    }
    let partialProcessing = false;
    const events = messageEvents.map((event) => {
      if (event.owner !== config.expectedOwnerUrn) {
        throw new LinkedInError(
          "wrong_account",
          "A message event belongs to another account. No message data was returned.",
        );
      }
      const value = record(event.processedActivity)
        ? event.processedActivity
        : record(event.activity)
          ? event.activity
          : null;
      const content = value && record(value.content) ? value.content : null;
      const nested =
        content && record(content.content) ? content.content : null;
      const text =
        typeof content?.fallback === "string"
          ? content.fallback
          : typeof nested?.string === "string"
            ? nested.string
            : null;
      const failed =
        event.activityStatus === "FAILURE" ||
        Boolean(
          value &&
            typeof value.message === "string" &&
            /unable to process/i.test(value.message),
        );
      const partial =
        failed ||
        Boolean(value && Object.keys(value).some((key) => key.endsWith("!"))) ||
        (text === null && event.method !== "DELETE");
      partialProcessing ||= partial;
      return {
        event,
        text,
        partialProcessing: partial,
        deleted: event.method === "DELETE",
      };
    });
    const timestamps = elements
      .map((event) => event.processedAt)
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    const latestProcessedAt = timestamps.length
      ? Math.max(...timestamps)
      : since;
    return {
      ...authorization,
      events,
      messageCount: events.length,
      scannedEventCount: elements.length,
      ...pagination,
      nextCursor:
        pagination.providerNextPage === null
          ? null
          : { since, start: pagination.providerNextPage, count },
      nextSince: latestProcessedAt,
      startTimeInclusive: true,
      deduplicateBy: "activityId then event id",
      windowStart: since,
      windowEnd: requestedAt,
      postConsentOnly: true,
      retentionDays: 28,
      partialProcessing,
      completeHistoryVerified: false,
      retrievedAt: new Date(now()).toISOString(),
      warnings: [
        "Changelog covers post-consent events within 28 days; it is not full inbox history.",
        ...(partialProcessing
          ? [
              "Some message events were partially processed or have an unknown content shape.",
            ]
          : []),
        ...(pagination.providerNextPage !== null
          ? ["Continue the nextCursor before advancing nextSince."]
          : []),
      ],
    };
  }

  return { status, inboxPage, recentMessages };
}
