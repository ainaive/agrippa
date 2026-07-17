export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Localized text as stored in DB `*_i18n` jsonb columns and template YAML:
 * `{"en": "...", "zh-CN": "..."}`. See ADR-0008.
 */
export type LocalizedText = { [locale: string]: string | undefined };

/**
 * Fallback chain: requested locale → en → first available → "".
 * The single localization helper shared by API serializers and the SPA,
 * so fallback behavior cannot diverge between them.
 */
export function pickLocale(text: LocalizedText | null | undefined, locale: string): string {
  if (!text) return "";
  const requested = text[locale];
  if (requested) return requested;
  const fallback = text[DEFAULT_LOCALE];
  if (fallback) return fallback;
  for (const value of Object.values(text)) {
    if (value) return value;
  }
  return "";
}
