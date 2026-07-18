import { AppError, type LocalizedText } from "@agrippa/core";
import { type Db, models, projectQuotas, runs, tasks, taskTypes, tokenUsage } from "@agrippa/db";
import { and, eq, gte, sql } from "drizzle-orm";

const periodStart = sql`date_trunc('month', now())`;

export type ProjectUsage = {
  costUsd: number;
  tokens: number;
  byModel: Array<{ model: string; costUsd: number; tokens: number }>;
  byTaskType: Array<{
    taskTypeId: string | null;
    taskTypeNameI18n: LocalizedText | null;
    costUsd: number;
    tokens: number;
  }>;
  byDay: Array<{ day: string; costUsd: number; tokens: number }>;
  /** Month window boundaries from the database clock — the same calendar byDay is grouped in. */
  period: { start: string; today: string };
};

/**
 * Current-period (monthly) usage for a project. All groupings share the same
 * month window the quota gate uses, so the numbers agree everywhere.
 */
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

  // grouped by id, not display name — two task types may share a name
  const byTaskType = await db
    .select({
      taskTypeId: taskTypes.id,
      nameI18n: taskTypes.nameI18n,
      cost: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
      tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
    })
    .from(tokenUsage)
    .leftJoin(runs, eq(tokenUsage.runId, runs.id))
    .leftJoin(tasks, eq(runs.taskId, tasks.id))
    .leftJoin(taskTypes, eq(tasks.taskTypeId, taskTypes.id))
    .where(where)
    .groupBy(taskTypes.id, taskTypes.nameI18n);

  const [period] = await db
    .select({
      start: sql<string>`to_char(date_trunc('month', now()), 'YYYY-MM-DD')`,
      today: sql<string>`to_char(now(), 'YYYY-MM-DD')`,
    })
    .from(sql`(select 1) as clock`);

  const byDay = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${tokenUsage.occurredAt}), 'YYYY-MM-DD')`,
      cost: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
      tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
    })
    .from(tokenUsage)
    .where(where)
    .groupBy(sql`date_trunc('day', ${tokenUsage.occurredAt})`)
    .orderBy(sql`date_trunc('day', ${tokenUsage.occurredAt})`);

  return {
    costUsd: Number(totals?.cost ?? 0),
    tokens: Number(totals?.tokens ?? 0),
    byModel: byModel.map((row) => ({
      model: row.model,
      costUsd: Number(row.cost),
      tokens: Number(row.tokens),
    })),
    byTaskType: byTaskType.map((row) => ({
      taskTypeId: row.taskTypeId ?? null,
      taskTypeNameI18n: (row.nameI18n as LocalizedText | null) ?? null,
      costUsd: Number(row.cost),
      tokens: Number(row.tokens),
    })),
    byDay: byDay.map((row) => ({
      day: row.day,
      costUsd: Number(row.cost),
      tokens: Number(row.tokens),
    })),
    period: { start: period?.start ?? "", today: period?.today ?? "" },
  };
}

/**
 * Submit-time quota gate (docs/design/04): hard-stop quotas reject new work
 * once the current month's spend has reached either limit. The engine re-reads
 * the same month-scoped project usage at every step boundary (excluding the
 * run's own spend, which its budget meter already carries) for mid-run
 * enforcement, so this gate and the engine agree on the accounting window.
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
