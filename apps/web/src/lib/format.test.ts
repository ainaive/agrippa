import { describe, expect, it } from "bun:test";
import { submitChord } from "./format";

describe("submitChord", () => {
  it("returns a modifier the platform actually uses", () => {
    // The catalogs interpolate this rather than carrying a glyph: "⌘↵" in a
    // locale file is wrong for every Windows and Linux reader, in every
    // language. Both forms are accepted by the handler; only the hint varies.
    expect(["⌘↵", "Ctrl+↵"]).toContain(submitChord());
  });

  it("is what the catalogs interpolate, so no catalog carries a glyph", async () => {
    for (const locale of ["en", "zh-CN"]) {
      const runs = (await import(`../../../../packages/i18n/locales/${locale}/runs.json`)) as {
        default: { comments: { placeholder: string }; followup: { placeholder: string } };
      };
      for (const placeholder of [
        runs.default.comments.placeholder,
        runs.default.followup.placeholder,
      ]) {
        expect(placeholder).toContain("{{shortcut}}");
        expect(placeholder).not.toContain("⌘");
        expect(placeholder).not.toContain("Ctrl");
      }
    }
  });
});
