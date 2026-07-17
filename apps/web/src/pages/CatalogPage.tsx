import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { SearchXIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { FaberAvatar } from "@/components/FaberAvatar";
import { CardGridSkeleton } from "@/components/LoadingSkeletons";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "../lib/api";
import { lt } from "../lib/format";
import type { Scenario, TaskTypeSummary } from "../lib/types";

function matches(taskType: TaskTypeSummary, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [taskType.nameI18n, taskType.descriptionI18n, taskType.faberNameI18n]
    .flatMap((text) => (text ? Object.values(text) : []))
    .some((value) => value?.toLowerCase().includes(q));
}

function TaskTypeCard({ taskType, projectId }: { taskType: TaskTypeSummary; projectId: string }) {
  return (
    <Link
      to="/projects/$projectId/submit/$taskTypeId"
      params={{ projectId, taskTypeId: taskType.id }}
    >
      <Card className="h-full transition-all hover:border-primary/40 hover:shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FaberAvatar avatar={taskType.faberAvatar} size="sm" />
            {lt(taskType.nameI18n)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {lt(taskType.descriptionI18n)}
          </p>
          <p className="text-xs text-muted-foreground/70">
            {lt(taskType.faberNameI18n)} · {taskType.templateSlug}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

export function CatalogPage() {
  const { t } = useTranslation(["catalog", "common"]);
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const [query, setQuery] = useState("");

  const scenarios = useQuery({
    queryKey: ["scenarios"],
    queryFn: () => api<Scenario[]>("/scenarios"),
  });
  const taskTypeQueries = useQueries({
    queries: (scenarios.data ?? []).map((scenario) => ({
      queryKey: ["task-types", scenario.slug],
      queryFn: () => api<TaskTypeSummary[]>(`/scenarios/${scenario.slug}/task-types`),
    })),
  });

  const loading = scenarios.isLoading || taskTypeQueries.some((q) => q.isLoading);
  const sections = (scenarios.data ?? []).map((scenario, index) => ({
    scenario,
    taskTypes: (taskTypeQueries[index]?.data ?? []).filter((taskType) => matches(taskType, query)),
  }));
  const noResults = !loading && query !== "" && sections.every((s) => s.taskTypes.length === 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("common:nav.catalog")}
        description={t("catalog:hint")}
        actions={
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("catalog:search")}
          />
        }
      />
      {loading ? (
        <CardGridSkeleton count={6} />
      ) : noResults ? (
        <EmptyState icon={SearchXIcon} title={t("catalog:noResults")} description={query} />
      ) : (
        sections
          .filter((section) => !query || section.taskTypes.length > 0)
          .map(({ scenario, taskTypes }) => (
            <section key={scenario.id}>
              <h2 className="mb-1 text-base font-semibold">{lt(scenario.nameI18n)}</h2>
              <p className="mb-3 text-sm text-muted-foreground">{lt(scenario.descriptionI18n)}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {taskTypes.map((taskType) => (
                  <TaskTypeCard key={taskType.id} taskType={taskType} projectId={projectId} />
                ))}
              </div>
            </section>
          ))
      )}
    </div>
  );
}
