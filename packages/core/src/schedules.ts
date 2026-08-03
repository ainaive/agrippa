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

// ── Fire-time parameter tokens ───────────────────────────────────────────────

/**
 * A schedule stores its parameters once, but the interesting ones are about
 * *when* it fires: a weekly report whose `dateRange` is frozen reports on the
 * same week forever, which makes "runs weekly unattended" true and useless.
 * These tokens are substituted into string parameters when the schedule fires,
 * resolved in the schedule's own timezone.
 *
 * The set is **closed on purpose**. The template expression language is
 * deliberately non-Turing-complete (ADR-0006), and the failure mode here is
 * quietly growing a second, more capable one beside it. So: no arithmetic, no
 * formats, no nesting — a fixed list of calendar boundaries, all `YYYY-MM-DD`.
 * Anything more expressive belongs in the template, not in a parameter value.
 */
export const SCHEDULE_TOKENS = [
  "today",
  "yesterday",
  "thisWeekStart",
  "thisWeekEnd",
  "lastWeekStart",
  "lastWeekEnd",
  "thisMonthStart",
  "lastMonthStart",
  "lastMonthEnd",
] as const;
export type ScheduleToken = (typeof SCHEDULE_TOKENS)[number];

const TOKEN_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/** `YYYY-MM-DD` for an instant, as seen in `timezone`. */
function calendarDay(at: Date, timezone: string): string {
  // en-CA renders ISO-ordered dates, which is what makes this a plain format
  // call rather than a manual assembly of parts
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Day arithmetic on a `YYYY-MM-DD` value. Deliberately done in UTC: the input
 * is already a calendar date in the target zone, so shifting it by whole days
 * as UTC never crosses a DST boundary — converting back through the zone is
 * exactly what would introduce one.
 */
function shiftDays(day: string, delta: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

/** 0 = Sunday, matching `Date.getUTCDay`. */
function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Weeks start Monday — the convention every "last week" report means. */
function mondayOf(day: string): string {
  const dow = weekday(day);
  return shiftDays(day, dow === 0 ? -6 : 1 - dow);
}

function firstOfMonth(day: string): string {
  return `${day.slice(0, 8)}01`;
}

/** Every token's value for one firing. */
export function scheduleTokenValues(at: Date, timezone: string): Record<ScheduleToken, string> {
  const today = calendarDay(at, timezone);
  const thisWeekStart = mondayOf(today);
  const thisMonthStart = firstOfMonth(today);
  const lastMonthEnd = shiftDays(thisMonthStart, -1);
  return {
    today,
    yesterday: shiftDays(today, -1),
    thisWeekStart,
    thisWeekEnd: shiftDays(thisWeekStart, 6),
    lastWeekStart: shiftDays(thisWeekStart, -7),
    lastWeekEnd: shiftDays(thisWeekStart, -1),
    thisMonthStart,
    lastMonthStart: firstOfMonth(lastMonthEnd),
    lastMonthEnd,
  };
}

function isScheduleToken(name: string): name is ScheduleToken {
  return (SCHEDULE_TOKENS as readonly string[]).includes(name);
}

/**
 * Every `{{name}}` in the value that is not a known token. Creation rejects on
 * a non-empty result: a typo left to run would otherwise reach the agent's
 * prompt literally, which reads as a broken report rather than a broken
 * schedule and would take a human to notice.
 */
export function findUnknownScheduleTokens(value: unknown): string[] {
  const unknown = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(TOKEN_PATTERN)) {
        const name = match[1] as string;
        if (!isScheduleToken(name)) unknown.add(name);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node && typeof node === "object") {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return [...unknown];
}

/**
 * Substitute tokens throughout a parameter tree. Only strings are rewritten,
 * so a number or boolean parameter is never reinterpreted; unknown tokens are
 * left verbatim, because creation already rejected them and silently blanking
 * one at fire time would hide the mistake.
 */
export function applyScheduleTokens<T>(params: T, at: Date, timezone: string): T {
  const values = scheduleTokenValues(at, timezone);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.replace(TOKEN_PATTERN, (whole, name: string) =>
        isScheduleToken(name) ? values[name] : whole,
      );
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(params) as T;
}
