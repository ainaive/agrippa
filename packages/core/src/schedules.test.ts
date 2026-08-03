import { describe, expect, it } from "bun:test";
import {
  applyScheduleTokens,
  findUnknownScheduleTokens,
  scheduleTokenValues,
  validateCron,
  validateTimezone,
} from "./schedules";

describe("validateCron", () => {
  it("accepts the expressions a scheduled report actually uses", () => {
    for (const expr of [
      "0 9 * * 1", // Mondays at 09:00
      "*/15 * * * *", // every quarter hour
      "0 0 1 * *", // first of the month
      "30 8 * * 1-5", // weekdays
      "0 9 * * mon", // named day
      "0 0 1 jan *", // named month
      "0 6,18 * * *", // twice a day
      "0 0 * * 0", // Sunday as 0
      "0 0 * * 7", // Sunday as 7
      "0 */2 * * *",
    ]) {
      expect({ expr, err: validateCron(expr) }).toEqual({ expr, err: null });
    }
  });

  it("rejects the shapes that would otherwise fail silently at registration", () => {
    for (const expr of [
      "", // empty
      "0 9 * *", // 4 fields
      "0 9 * * * *", // 6 fields (quartz-style seconds)
      "60 9 * * 1", // minute out of range
      "0 24 * * 1", // hour out of range
      "0 9 0 * *", // day-of-month is 1-based
      "0 9 * 13 *", // month out of range
      "0 9 * * 8", // day-of-week out of range
      "0 9 * * abc", // not a day name
      "*/0 * * * *", // zero step would divide by zero
      "*/2/3 * * * *", // two steps
      "1-2-3 * * * *", // malformed range
      "0 9 * * 1/x", // non-numeric step
    ]) {
      expect({ expr, ok: validateCron(expr) === null }).toEqual({ expr, ok: false });
    }
  });
});

describe("validateTimezone", () => {
  it("accepts IANA zones and rejects everything else", () => {
    expect(validateTimezone("Asia/Shanghai")).toBeNull();
    expect(validateTimezone("UTC")).toBeNull();
    expect(validateTimezone("America/New_York")).toBeNull();
    expect(validateTimezone("Mars/Olympus")).not.toBeNull();
    expect(validateTimezone("CST")).not.toBeNull();
    expect(validateTimezone("")).not.toBeNull();
  });
});

describe("scheduleTokenValues", () => {
  // 2026-08-03 is a Monday; 09:00 Shanghai = 01:00 UTC
  const monday = new Date("2026-08-03T01:00:00Z");

  it("resolves calendar boundaries with Monday-based weeks", () => {
    expect(scheduleTokenValues(monday, "Asia/Shanghai")).toEqual({
      today: "2026-08-03",
      yesterday: "2026-08-02",
      thisWeekStart: "2026-08-03",
      thisWeekEnd: "2026-08-09",
      lastWeekStart: "2026-07-27",
      lastWeekEnd: "2026-08-02",
      thisMonthStart: "2026-08-01",
      lastMonthStart: "2026-07-01",
      lastMonthEnd: "2026-07-31",
    });
  });

  it("treats Sunday as the end of its week, not the start of the next", () => {
    const sunday = new Date("2026-08-09T12:00:00Z");
    const v = scheduleTokenValues(sunday, "UTC");
    expect(v.today).toBe("2026-08-09");
    expect(v.thisWeekStart).toBe("2026-08-03");
    expect(v.thisWeekEnd).toBe("2026-08-09");
    expect(v.lastWeekStart).toBe("2026-07-27");
  });

  it("resolves in the schedule's timezone, not the server's", () => {
    // 23:30 UTC is already the next day in Shanghai (+08:00)
    const lateUtc = new Date("2026-08-03T23:30:00Z");
    expect(scheduleTokenValues(lateUtc, "UTC").today).toBe("2026-08-03");
    expect(scheduleTokenValues(lateUtc, "Asia/Shanghai").today).toBe("2026-08-04");
  });

  it("crosses a DST boundary without slipping a day", () => {
    // US DST ends 2026-11-01; a 09:00-local firing either side must still
    // report the calendar day it happened on
    expect(scheduleTokenValues(new Date("2026-10-31T13:00:00Z"), "America/New_York").today).toBe(
      "2026-10-31",
    );
    expect(scheduleTokenValues(new Date("2026-11-01T14:00:00Z"), "America/New_York").today).toBe(
      "2026-11-01",
    );
  });

  it("handles month and year boundaries", () => {
    const newYear = new Date("2027-01-01T12:00:00Z");
    const v = scheduleTokenValues(newYear, "UTC");
    expect(v.thisMonthStart).toBe("2027-01-01");
    expect(v.lastMonthStart).toBe("2026-12-01");
    expect(v.lastMonthEnd).toBe("2026-12-31");

    const marchFirst = new Date("2028-03-01T12:00:00Z"); // 2028 is a leap year
    const leap = scheduleTokenValues(marchFirst, "UTC");
    expect(leap.lastMonthEnd).toBe("2028-02-29");
  });
});

describe("schedule token substitution", () => {
  const at = new Date("2026-08-03T01:00:00Z");

  it("substitutes into strings, recursively, leaving other types alone", () => {
    expect(
      applyScheduleTokens(
        {
          dateRange: "{{lastWeekStart}}..{{lastWeekEnd}}",
          nested: { note: "as of {{today}}" },
          list: ["{{yesterday}}", 42],
          density: "comprehensive",
          includeRisks: true,
          count: 7,
        },
        at,
        "Asia/Shanghai",
      ),
    ).toEqual({
      dateRange: "2026-07-27..2026-08-02",
      nested: { note: "as of 2026-08-03" },
      list: ["2026-08-02", 42],
      density: "comprehensive",
      includeRisks: true,
      count: 7,
    });
  });

  it("tolerates whitespace inside the braces", () => {
    expect(applyScheduleTokens({ a: "{{ today }}" }, at, "UTC")).toEqual({ a: "2026-08-03" });
  });

  it("leaves an unknown token verbatim rather than blanking it", () => {
    expect(applyScheduleTokens({ a: "{{lastWeek}}" }, at, "UTC")).toEqual({ a: "{{lastWeek}}" });
  });

  it("finds unknown tokens anywhere in the tree, and only unknown ones", () => {
    expect(
      findUnknownScheduleTokens({
        ok: "{{today}}",
        typo: "{{lastWeek}}",
        deep: { worse: ["{{tomorrow}}"] },
      }),
    ).toEqual(["lastWeek", "tomorrow"]);
    expect(findUnknownScheduleTokens({ ok: "{{lastWeekStart}}", n: 1 })).toEqual([]);
  });
});
