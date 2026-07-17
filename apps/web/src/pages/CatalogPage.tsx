import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "../lib/api";
import { lt } from "../lib/format";
import type { Scenario, TaskTypeSummary } from "../lib/types";

function ScenarioSection({ scenario, projectId }: { scenario: Scenario; projectId: string }) {
  const taskTypes = useQuery({
    queryKey: ["task-types", scenario.slug],
    queryFn: () => api<TaskTypeSummary[]>(`/scenarios/${scenario.slug}/task-types`),
  });

  return (
    <section>
      <h2 className="mb-1 text-base font-semibold">{lt(scenario.nameI18n)}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{lt(scenario.descriptionI18n)}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(taskTypes.data ?? []).map((taskType) => (
          <Link
            key={taskType.id}
            to="/projects/$projectId/submit/$taskTypeId"
            params={{ projectId, taskTypeId: taskType.id }}
          >
            <Card className="h-full transition-colors hover:border-foreground/30">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <span aria-hidden>{taskType.faberAvatar ?? "🤖"}</span>
                  {lt(taskType.nameI18n)}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">{lt(taskType.descriptionI18n)}</p>
                <p className="text-xs text-muted-foreground/70">
                  {lt(taskType.faberNameI18n)} · {taskType.templateSlug}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function CatalogPage() {
  const { t } = useTranslation("catalog");
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const scenarios = useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api<Scenario[]>("/scenarios"),
  });

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
      {(scenarios.data ?? []).map((scenario) => (
        <ScenarioSection key={scenario.id} scenario={scenario} projectId={projectId} />
      ))}
    </div>
  );
}
