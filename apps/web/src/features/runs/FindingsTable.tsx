import type { ReviewFinding, ReviewSeverity } from "@agrippa/core";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SEVERITY_CLASS: Record<ReviewSeverity, string> = {
  blocker: "border-status-danger/50 bg-status-danger/10 text-status-danger",
  major: "border-status-warning/50 bg-status-warning/10 text-status-warning",
  minor: "border-border bg-muted text-foreground",
  info: "border-border bg-muted text-muted-foreground",
};

export function SeverityBadge({ severity }: { severity: ReviewSeverity }) {
  const { t } = useTranslation("runs");
  return (
    <Badge variant="outline" className={cn("uppercase", SEVERITY_CLASS[severity])}>
      {t(`severity.${severity}`)}
    </Badge>
  );
}

/**
 * Findings decision table for a `review-gate` checkpoint: check the findings
 * the implementer should fix, or accept everything that remains. Accepting is
 * an explicit waiver — the confirm dialog lists exactly what is being waived
 * (it also ends up in the PR body).
 */
export function FindingsTable({
  summary,
  findings,
  disabled,
  onFix,
  onAccept,
}: {
  summary?: string;
  findings: ReviewFinding[];
  disabled: boolean;
  onFix: (selectedIds: string[]) => void;
  onAccept: () => void;
}) {
  const { t } = useTranslation("runs");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  // "fix selected" implicitly waives whatever stays unchecked
  const waivedByFix = findings.filter((f) => !selected.has(f.id));

  return (
    <div className="space-y-3">
      {summary ? <p className="text-sm text-muted-foreground">{summary}</p> : null}
      <div className="divide-y overflow-hidden rounded-md border">
        {findings.map((finding) => (
          <div key={finding.id}>
            <div className="flex items-center gap-2.5 px-3 py-2">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={selected.has(finding.id)}
                disabled={disabled}
                onChange={() => setSelected((prev) => toggle(prev, finding.id))}
                aria-label={t("checkpoint.selectFinding", { title: finding.title })}
              />
              <SeverityBadge severity={finding.severity} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{finding.title}</p>
                {finding.file ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setExpanded((prev) => toggle(prev, finding.id))}
              >
                <ChevronDownIcon
                  className={cn("transition-transform", expanded.has(finding.id) && "rotate-180")}
                />
              </Button>
            </div>
            {expanded.has(finding.id) ? (
              <div className="space-y-2 border-t bg-muted/30 px-3 py-2 text-sm">
                <p className="whitespace-pre-wrap">{finding.detail}</p>
                {finding.suggestion ? (
                  <p className="whitespace-pre-wrap border-l-2 border-primary/40 pl-2 text-muted-foreground">
                    {finding.suggestion}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={disabled || selected.size === 0}
          onClick={() => onFix([...selected])}
        >
          {t("checkpoint.fixSelected", { count: selected.size })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onFix(findings.map((f) => f.id))}
        >
          {t("checkpoint.fixAll")}
        </Button>
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" disabled={disabled}>
              {t("checkpoint.acceptAll")}
            </Button>
          }
          title={t("checkpoint.acceptAllTitle")}
          description={
            <span className="block space-y-1 text-left">
              {t("checkpoint.acceptAllWarning")}
              <span className="mt-2 block whitespace-pre-line font-mono text-xs">
                {findings.map((f) => `• [${f.severity}] ${f.title}`).join("\n")}
              </span>
            </span>
          }
          confirmLabel={t("checkpoint.acceptConfirm")}
          onConfirm={onAccept}
        />
      </div>
      {selected.size > 0 && waivedByFix.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("checkpoint.uncheckedWaived", { count: waivedByFix.length })}
        </p>
      ) : null}
    </div>
  );
}
