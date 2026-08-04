import { buildProviderCatalog, type ProviderCatalog, type ProviderCatalogRow } from "@agrippa/core";
import { and, eq, isNull, or } from "drizzle-orm";
import type { DbOrTx } from "./client";
import { providerCatalog } from "./schema";

/**
 * The resolvable provider catalog for an org: builtin rows (org_id NULL) plus
 * the org's active custom providers. Merged into a `ProviderCatalog` via
 * `buildProviderCatalog` — used by submit resolution and the runtime
 * auth-policy/baseUrl lookups. Builtins are seeded org_id NULL so every org
 * sees anthropic/openai/dashscope; customs are org_admin-registered.
 */
export async function loadProviderCatalog(db: DbOrTx, orgId: string): Promise<ProviderCatalog> {
  const rows = await db
    .select({
      providerId: providerCatalog.providerId,
      label: providerCatalog.label,
      baseUrls: providerCatalog.baseUrls,
      auth: providerCatalog.auth,
      baseUrlHosts: providerCatalog.baseUrlHosts,
      status: providerCatalog.status,
    })
    .from(providerCatalog)
    .where(
      and(
        eq(providerCatalog.status, "active"),
        or(isNull(providerCatalog.orgId), eq(providerCatalog.orgId, orgId)),
      ),
    );
  return buildProviderCatalog(rows as ProviderCatalogRow[]);
}
