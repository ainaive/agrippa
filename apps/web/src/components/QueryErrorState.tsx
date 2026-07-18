import { CloudAlertIcon, RotateCcwIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";

/** Full-page query failure: name the failure and offer a retry, never a blank page. */
export function QueryErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation("common");
  return (
    <EmptyState
      icon={CloudAlertIcon}
      title={t("error.title")}
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcwIcon />
          {t("actions.retry")}
        </Button>
      }
    />
  );
}
