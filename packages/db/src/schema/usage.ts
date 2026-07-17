import { bigint, index, integer, numeric, pgTable, uuid } from "drizzle-orm/pg-core";
import { idCol, tstz } from "./_helpers";
import { orgs } from "./orgs";
import { projects } from "./projects";
import { models } from "./registry";
import { runSteps, runs } from "./runs";

/**
 * Keyed by (run, step, attempt): a retried step re-incurs cost, and the
 * budget meter sums persisted rows on resume without double-counting.
 */
export const tokenUsage = pgTable(
  "token_usage",
  {
    id: idCol(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => runSteps.id),
    attempt: integer("attempt").notNull().default(1),
    modelId: uuid("model_id").references(() => models.id),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("token_usage_project_time_idx").on(t.projectId, t.occurredAt),
    index("token_usage_run_idx").on(t.runId),
  ],
);
