import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Dashboard/usage stat tile: quiet label + icon row over a large tabular figure. */
export function StatCard({
  title,
  icon: Icon,
  value,
  children,
}: {
  title: React.ReactNode;
  icon: LucideIcon;
  value: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card className="gap-2">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        {children}
      </CardContent>
    </Card>
  );
}
