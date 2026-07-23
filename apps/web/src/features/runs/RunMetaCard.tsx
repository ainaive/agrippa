import { useTranslation } from "react-i18next";
import type { ModelResolutionEntry, Run } from "@/lib/types";

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{value}</span>
    </div>
  );
}

/** Flat (role → entry) for pre-slot runs, slot-keyed (slot → role → entry) after. */
function resolutionRows(run: Run): Array<[string, ModelResolutionEntry]> {
  const raw = run.modelResolution ?? {};
  const flat = Object.values(raw).every(
    (v) => v !== null && typeof v === "object" && "providerModelId" in v,
  );
  if (flat) return Object.entries(raw) as Array<[string, ModelResolutionEntry]>;
  return Object.entries(raw).flatMap(([slot, entries]) =>
    Object.entries(entries as Record<string, ModelResolutionEntry>).map(
      ([role, entry]): [string, ModelResolutionEntry] => [`${slot} · ${role}`, entry],
    ),
  );
}

export function RunMetaCard({ run }: { run: Run }) {
  const { t } = useTranslation("runs");
  const roles = resolutionRows(run);

  return (
    <div className="space-y-2">
      <MetaRow
        label={t("meta.template")}
        value={
          run.template ? (
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              {run.template.slug}@v{run.template.version}
            </code>
          ) : (
            "—"
          )
        }
      />
      <MetaRow label={t("meta.executor")} value={run.executorId} />
      {roles.length > 0 ? (
        <div className="space-y-1 border-t pt-2">
          <p className="text-xs font-medium text-muted-foreground">{t("meta.models")}</p>
          {roles.map(([role, entry]) => (
            <div key={role} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="shrink-0 text-muted-foreground">{role}</span>
              <span className="min-w-0 truncate text-right" title={entry.providerModelId}>
                {entry.providerModelId}
                <span className="ml-1 text-muted-foreground">({entry.tier})</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
