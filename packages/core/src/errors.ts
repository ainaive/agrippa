/**
 * Domain error carried across the API boundary as `{ code, message, details }`.
 * `code` is a stable machine-readable slug; `message` is human-readable
 * (localized by the API's locale middleware from M1.5 on).
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static unauthorized(message = "Authentication required"): AppError {
    return new AppError("unauthorized", 401, message);
  }

  static forbidden(message = "Insufficient permissions"): AppError {
    return new AppError("forbidden", 403, message);
  }

  static notFound(what = "Resource"): AppError {
    return new AppError("not_found", 404, `${what} not found`);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(code, 409, message);
  }

  static validation(details: unknown): AppError {
    return new AppError("validation_failed", 400, "Validation failed", details);
  }
}
