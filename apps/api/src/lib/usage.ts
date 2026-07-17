import { AppError } from "@agrippa/core";
import { type Db, models, projectQuotas, tokenUsage } from "@agrippa/db";
import { and, eq, gte, sql } from "drizzle-orm";

const periodStart = sql`date_trunc('month', now())`;

export type ProjectUsage = {
  costUsd: number;
  tokens: number;
  byModel: Array<{ model: string; costUsd: number; tokens: number }>;
};

/** Current-period (monthly) usage totals for a project. */
export async function projectUsage(db: Db, projectId: string): Promise<ProjectUsage> {
  const where = and(eq(tokenUsage.projectId, projectId), gte(tokenUsage.occurredAt, periodStart));
  const [totals] = await db
    .select({
      cost: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
      tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
    })
    .from(tokenUsage)
    .where(where);

  const byModel = await db
    .select({
      model: sql<string>`coalesce(${models.displayName}, 'unknown')`,
      cost: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
      tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
    })
    .from(tokenUsage)
    .leftJoin(models, eq(tokenUsage.modelId, models.id))
    .where(where)
    .groupBy(models.displayName);

  return {
    costUsd: Number(totals?.cost ?? 0),
    tokens: Number(totals?.tokens ?? 0),
    byModel: byModel.map((row) => ({
      model: row.model,
      costUsd: Number(row.cost),
      tokens: Number(row.tokens),
    })),
  };
}

/**
 * Submit-time quota gate (docs/design/04): hard-stop quotas reject new work
 * once the period's spend has reached either limit. The engine re-checks at
 * every step boundary for mid-run enforcement.
 */
export async function assertQuotaHeadroom(db: Db, projectId: string): Promise<void> {
  const [quota] = await db
    .select()
    .from(projectQuotas)
    .where(eq(projectQuotas.projectId, projectId));
  if (!quota?.hardStop) return;
  if (quota.costLimitUsd === null && quota.tokenLimit === null) return;

  const usage = await projectUsage(db, projectId);
  if (quota.costLimitUsd !== null && usage.costUsd >= Number(quota.costLimitUsd)) {
    throw new AppError("quota_exhausted", 400, "The project's cost quota is exhausted", {
      costUsd: usage.costUsd,
      costLimitUsd: Number(quota.costLimitUsd),
    });
  }
  if (quota.tokenLimit !== null && usage.tokens >= quota.tokenLimit) {
    throw new AppError("quota_exhausted", 400, "The project's token quota is exhausted", {
      tokens: usage.tokens,
      tokenLimit: quota.tokenLimit,
    });
  }
}
