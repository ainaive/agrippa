import { AppError } from "@agrippa/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(
      { code: err.code, message: err.message, details: err.details ?? undefined },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof HTTPException) {
    return c.json({ code: "http_error", message: err.message }, err.status);
  }
  console.error("[api] unhandled error:", err);
  return c.json({ code: "internal", message: "Internal server error" }, 500);
}
