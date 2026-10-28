/** Public routing metadata only. Authentication and business policy stay with each host. */
export function companyCrmRoute(origin?: string) {
  let companyOrigin: string | undefined;
  if (origin !== undefined) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new TypeError("invalid_company_crm_origin");
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      origin !== origin.trim() ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !/^https:\/\/[^/?#\\@\s]+\/?$/.test(origin) ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "[::1]" ||
      /^127\./.test(hostname)
    ) {
      throw new TypeError("invalid_company_crm_origin");
    }
    companyOrigin = url.origin;
  }
  return {
    schemaVersion: 1,
    state:
      companyOrigin === undefined
        ? ("unconfigured" as const)
        : ("configured" as const),
    authority: "external_company_crm" as const,
    ...(companyOrigin === undefined ? {} : { origin: companyOrigin }),
    ownership: {
      channel_memory:
        "LinkedIn private indexes, classifications, source context and reviewed stable-ID mappings",
      company_master:
        "External company CRM owns company contacts and operational pipeline",
    },
    nativeTools: {
      search: "crm_search_records",
      get: "crm_get_record",
      update: "crm_update_record",
      applyBusinessEvent: "crm_apply_business_event",
    },
    syncConsumer: "crm_sync_business_queue" as const,
    delivery: "queued_not_applied" as const,
  };
}
export type CompanyCrmRoute = ReturnType<typeof companyCrmRoute>;
