import { AppError } from "@agrippa/core";
import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";

/** zValidator wired to our error shape: 400 {code: "validation_failed", details}. */
export function validate<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw AppError.validation(result.error.issues);
  });
}
