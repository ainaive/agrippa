import { EXECUTOR_CATALOG } from "@agrippa/core";
import { useTranslation } from "react-i18next";
import { FaberAvatar } from "@/components/FaberAvatar";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { lt } from "@/lib/format";
import type { AgentSlotMeta, FaberOption } from "@/lib/types";

export type AgentOverrides = Record<string, { faberId?: string; executorId?: string }>;

/**
 * One row per agent slot (implementer / reviewer …): a faber picker and an
 * executor picker, prefilled from the template defaults. Only overridable
 * slots are editable; overrides are kept sparse (only values that differ
 * from the default are sent).
 */
export function AgentSlotPicker({
  agents,
  fabriOptions,
  value,
  onChange,
}: {
  agents: Record<string, AgentSlotMeta>;
  fabriOptions: FaberOption[];
  value: AgentOverrides;
  onChange: (next: AgentOverrides) => void;
}) {
  const { t } = useTranslation("catalog");

  const setOverride = (slot: string, patch: { faberId?: string; executorId?: string }): void => {
    const meta = agents[slot];
    if (!meta) return;
    const current = { ...value[slot], ...patch };
    // drop values that match the template default so the submit stays sparse
    if (current.faberId === (meta.defaultFaberId ?? undefined)) current.faberId = undefined;
    if (current.executorId === meta.defaultExecutorId) current.executorId = undefined;
    const next = { ...value };
    if (current.faberId === undefined && current.executorId === undefined) {
      delete next[slot];
    } else {
      next[slot] = current;
    }
    onChange(next);
  };

  return (
    <div className="space-y-4">
      {Object.entries(agents).map(([slot, meta]) => {
        const faberId = value[slot]?.faberId ?? meta.defaultFaberId ?? "";
        const executorId = value[slot]?.executorId ?? meta.defaultExecutorId;
        const faber = fabriOptions.find((f) => f.id === faberId);
        return (
          <div key={slot} className="grid gap-2 sm:grid-cols-[140px_1fr_1fr] sm:items-center">
            <div className="flex items-center gap-2">
              <FaberAvatar avatar={faber?.avatar} size="sm" />
              <span className="truncate text-sm font-medium">{lt(meta.label)}</span>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("form.agentFaber")}</Label>
              <Select
                value={faberId}
                disabled={!meta.overridable}
                onValueChange={(next) => setOverride(slot, { faberId: next })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fabriOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      <span className="mr-1">{option.avatar ?? "🤖"}</span>
                      {lt(option.nameI18n)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("form.agentExecutor")}</Label>
              <Select
                value={executorId}
                disabled={!meta.overridable}
                onValueChange={(next) => setOverride(slot, { executorId: next })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXECUTOR_CATALOG).map(([id, entry]) => (
                    <SelectItem key={id} value={id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        );
      })}
    </div>
  );
}
