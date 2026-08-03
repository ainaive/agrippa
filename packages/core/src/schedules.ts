/** Scheduled task submission — vocabulary shared by the API, worker, and SPA. */

/**
 * What a firing does when the schedule's previous run has not finished.
 *
 * `skip` is the default because the common scheduled task is a report: two
 * overlapping weekly reports are worse than one late one. `queue` submits
 * anyway and lets the runs pile up in order; `replace` cancels the in-flight
 * run first, for schedules where only the freshest result matters.
 */
export const SCHEDULE_CONCURRENCY_POLICIES = ["skip", "queue", "replace"] as const;
export type ScheduleConcurrencyPolicy = (typeof SCHEDULE_CONCURRENCY_POLICIES)[number];

/**
 * Why the platform disabled a schedule. All of these are conditions a human
 * has to resolve — they never heal on their own, which is exactly why the
 * schedule is disabled and announced rather than skipped and forgotten.
 * Transient failures (quota exhausted, a missing grant, no capable worker)
 * leave it enabled and land in `last_error` instead.
 */
export const SCHEDULE_DISABLED_REASONS = [
  "owner_lost_access",
  "project_archived",
  "task_type_gone",
] as const;
export type ScheduleDisabledReason = (typeof SCHEDULE_DISABLED_REASONS)[number];

/**
 * Standard 5-field cron (minute hour day-of-month month day-of-week), which is
 * what pg-boss parses. Validated here so a bad expression is rejected at the
 * API with a field-level error instead of failing silently at registration —
 * a schedule that never fires looks identical to one that was never created.
 *
 * Deliberately permissive about semantics (`31 2 *` in February is simply a
 * cron that rarely fires) and strict about shape. Returns null when valid.
 */
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return "must have 5 fields: minute hour day-of-month month day-of-week";

  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7], // 0 and 7 both mean Sunday
  ];
  const names: Record<number, RegExp> = {
    3: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i,
    4: /^(sun|mon|tue|wed|thu|fri|sat)$/i,
  };

  for (let i = 0; i < 5; i++) {
    const field = fields[i] as string;
    const [lo, hi] = ranges[i] as [number, number];
    for (const term of field.split(",")) {
      // <range>/<step>
      const [rangePart, stepPart, ...extra] = term.split("/");
      if (extra.length > 0) return `field ${i + 1} has more than one step`;
      if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
        return `field ${i + 1} has a non-numeric step`;
      }
      if (stepPart !== undefined && Number(stepPart) === 0) return `field ${i + 1} has a zero step`;
      const range = rangePart ?? "";
      if (range === "*") continue;
      const bounds = range.split("-");
      if (bounds.length > 2) return `field ${i + 1} has a malformed range`;
      for (const bound of bounds) {
        if (names[i]?.test(bound)) continue;
        if (!/^\d+$/.test(bound)) return `field ${i + 1} has a non-numeric value`;
        const value = Number(bound);
        if (value < lo || value > hi) return `field ${i + 1} must be between ${lo} and ${hi}`;
      }
    }
  }
  return null;
}

/**
 * IANA zone names only — `Intl` is the authority, so the set stays correct as
 * the runtime's tz database updates. Returns null when valid.
 */
export function validateTimezone(tz: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return null;
  } catch {
    return "not a valid IANA timezone";
  }
}
