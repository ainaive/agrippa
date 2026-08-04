import {
  AppError,
  applyScheduleTokens,
  findUnknownScheduleTokens,
  SCHEDULE_TOKENS,
} from "@agrippa/core";
import { orchestrationTemplates, taskTypes, templateVersions } from "@agrippa/db";
import { buildParamsValidator, upgradeCompiledTemplate } from "@agrippa/orchestration";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";

/**
 * Reject unattended work whose parameters could never produce a run.
 *
 * Without this the mistake surfaces at the first firing — a week away for a
 * weekly schedule, and for a webhook trigger whenever a sender happens to call,
 * with only a delivery row to show for it. "Loud but late" is barely better
 * than silent when the whole point is unattended operation, so parameters are
 * validated against the same compiled schema the submit form renders from, at
 * the moment someone can still fix them.
 *
 * Tokens are resolved first: what gets validated is what will actually be
 * submitted, which also catches a token placed in a field that is not a string.
 * Unknown tokens are rejected outright — left alone, `{{lastWeek}}` would reach
 * the agent's prompt verbatim and read as a broken report rather than a broken
 * schedule.
 */
export async function assertSchedulableParams(
  db: AppEnv["Variables"]["db"],
  taskTypeId: string,
  params: Record<string, unknown>,
  timezone: string,
): Promise<void> {
  const unknown = findUnknownScheduleTokens(params);
  if (unknown.length > 0) {
    throw AppError.validation([
      {
        path: ["params"],
        message: `unknown schedule tokens: ${unknown.join(", ")}. Known: ${SCHEDULE_TOKENS.join(", ")}`,
      },
    ]);
  }

  const [taskType] = await db.select().from(taskTypes).where(eq(taskTypes.id, taskTypeId));
  if (!taskType?.enabled) throw AppError.notFound("Task type");
  const [template] = await db
    .select()
    .from(orchestrationTemplates)
    .where(eq(orchestrationTemplates.id, taskType.templateId));
  if (!template?.latestPublishedVersionId) {
    throw new AppError("template_unpublished", 409, "Task type has no published template");
  }
  const [version] = await db
    .select()
    .from(templateVersions)
    .where(eq(templateVersions.id, template.latestPublishedVersionId));
  if (!version) throw AppError.notFound("Template version");

  const compiled = upgradeCompiledTemplate(version.compiled);
  const resolved = applyScheduleTokens(params, new Date(), timezone);
  const parsed = buildParamsValidator(compiled.spec.inputs).safeParse(resolved);
  if (!parsed.success) throw AppError.validation(parsed.error.issues);
}
