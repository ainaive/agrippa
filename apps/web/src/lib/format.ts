import { pickLocale } from "@agrippa/core";
import i18next from "i18next";

export function lt(text: Parameters<typeof pickLocale>[0]): string {
  return pickLocale(text, i18next.language);
}

export function formatTokens(tokens: number | undefined | null): string {
  if (tokens == null) return "—";
  return Number(tokens).toLocaleString(i18next.language);
}

/** Compact form for per-step lines, per-phase caps, and bar labels. */
export function formatTokensCompact(tokens: number | undefined | null): string {
  if (tokens == null) return "—";
  return new Intl.NumberFormat(i18next.language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(tokens));
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(i18next.language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * The submit chord to *show* — "⌘↵" on Apple keyboards, "Ctrl+↵" elsewhere.
 *
 * Derived here rather than written into the locale catalogs: a modifier glyph
 * is a property of the platform, not of the language, so a catalog carrying
 * "⌘↵" is wrong for every Windows and Linux reader in both locales. The
 * handler already accepts either modifier; this is only what the hint says.
 */
export function submitChord(): string {
  const platform =
    typeof navigator === "undefined"
      ? ""
      : ((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
        navigator.platform ??
        "");
  return /mac|iphone|ipad/i.test(platform) ? "⌘↵" : "Ctrl+↵";
}
