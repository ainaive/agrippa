import { describe, expect, it } from "bun:test";
import { BODY_LOCK_OWNER_SELECTOR, shouldClearBodyLock } from "./body-lock";

const doc = (pointerEvents: string, openLockOwner: boolean) => ({
  querySelector: (selector: string) => {
    expect(selector).toBe(BODY_LOCK_OWNER_SELECTOR);
    return openLockOwner ? {} : null;
  },
  body: { style: { pointerEvents } },
});

describe("shouldClearBodyLock", () => {
  it("does nothing when the body is not locked", () => {
    expect(shouldClearBodyLock(doc("", false))).toBe(false);
    expect(shouldClearBodyLock(doc("auto", false))).toBe(false);
  });

  it("keeps a lock that an open layer still owns (menu, dialog, sheet, select…)", () => {
    expect(shouldClearBodyLock(doc("none", true))).toBe(false);
  });

  it("clears a lock nobody owns — the unmounted-mid-exit leftover", () => {
    expect(shouldClearBodyLock(doc("none", false))).toBe(true);
  });
});
