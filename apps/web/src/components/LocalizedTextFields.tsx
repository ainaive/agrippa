import type { LocalizedText } from "@agrippa/core";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Paired en / zh-CN inputs for `*_i18n` payloads — the API's
 * localizedTextInputSchema requires both locales on every write.
 */
export function LocalizedTextFields({
  label,
  value,
  onChange,
  multiline = false,
  required = false,
  idPrefix,
}: {
  label: React.ReactNode;
  value: LocalizedText;
  onChange: (next: LocalizedText) => void;
  multiline?: boolean;
  required?: boolean;
  idPrefix: string;
}) {
  const Field = multiline ? Textarea : Input;
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-en`}>{label}</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["en", "zh-CN"] as const).map((locale) => (
          <div key={locale} className="relative">
            <Field
              id={`${idPrefix}-${locale}`}
              value={value[locale] ?? ""}
              required={required}
              onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                onChange({ ...value, [locale]: e.target.value })
              }
              className={multiline ? "min-h-20" : "pr-12"}
            />
            <span className="pointer-events-none absolute top-1.5 right-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {locale === "en" ? "EN" : "中文"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
