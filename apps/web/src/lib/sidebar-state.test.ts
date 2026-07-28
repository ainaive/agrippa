import { describe, expect, it } from "bun:test";
import { sidebarStateFromCookie } from "./sidebar-state";

describe("sidebarStateFromCookie", () => {
  it("reads an explicit true", () => {
    expect(sidebarStateFromCookie("sidebar_state=true")).toBe(true);
  });

  it("reads an explicit false", () => {
    expect(sidebarStateFromCookie("sidebar_state=false")).toBe(false);
  });

  it("defaults to open when the cookie is absent", () => {
    expect(sidebarStateFromCookie("")).toBe(true);
    expect(sidebarStateFromCookie("theme=dark; agrippa.lastProject=abc")).toBe(true);
  });

  it("finds the value among other cookies", () => {
    expect(sidebarStateFromCookie("a=1; sidebar_state=false; b=2")).toBe(false);
    expect(sidebarStateFromCookie("a=1; sidebar_state=true; b=2")).toBe(true);
  });

  it("ignores lookalike names and malformed values", () => {
    expect(sidebarStateFromCookie("not_sidebar_state=false")).toBe(true);
    expect(sidebarStateFromCookie("sidebar_state=falsey")).toBe(true);
    expect(sidebarStateFromCookie("sidebar_state=")).toBe(true);
  });
});
