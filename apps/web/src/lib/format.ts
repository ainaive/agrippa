import { pickLocale } from "@agrippa/core";
import i18next from "i18next";

export function lt(text: Parameters<typeof pickLocale>[0]): string {
  return pickLocale(text, i18next.language);
}

export function formatCost(costUsd: number | undefined | null): string {
  if (costUsd == null) return "—";
  return `$${Number(costUsd).toFixed(costUsd < 0.1 ? 4 : 2)}`;
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
