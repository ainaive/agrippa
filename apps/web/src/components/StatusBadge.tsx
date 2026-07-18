import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

/** Registry-resource state chip: active (tinted) vs disabled (quiet outline). */
export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("admin");
  const active = status === "active";
  return (
    <Badge
      variant={active ? "secondary" : "outline"}
      className={active ? "" : "text-muted-foreground"}
    >
      {t(active ? "crud.active" : "crud.disabled")}
    </Badge>
  );
}
