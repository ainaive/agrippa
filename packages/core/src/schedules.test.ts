import { describe, expect, it } from "bun:test";
import { validateCron, validateTimezone } from "./schedules";

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
