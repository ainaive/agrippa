import { AppError } from "@agrippa/core";
import { errorMessage } from "@agrippa/i18n";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../context";

/**
 * Error shape (docs/design/05): stable machine-readable `code`, localized
 * `message` when the code is in the errors catalog, original message otherwise.
 */
export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  const locale = c.var.locale ?? "en";
  if (err instanceof AppError) {
    const localized = errorMessage(err.code, locale);
    return c.json(
      { code: err.code, message: localized ?? err.message, details: err.details ?? undefined },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof HTTPException) {
    return c.json({ code: "http_error", message: err.message }, err.status);
  }
  console.error("[api] unhandled error:", err);
  return c.json(
    { code: "internal", message: errorMessage("internal", locale) ?? "Internal server error" },
    500,
  );
}
