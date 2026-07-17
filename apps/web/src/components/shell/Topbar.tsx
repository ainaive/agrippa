import { useQueryClient } from "@tanstack/react-query";
import { Link, useMatches } from "@tanstack/react-router";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { UserMenu } from "@/components/shell/UserMenu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useMe } from "@/features/me";
import type { Run } from "@/lib/types";

type Crumb = { label: string; to?: string; params?: Record<string, string> };

function useCrumbs(): Crumb[] {
  const { t } = useTranslation("common");
  const me = useMe();
  const matches = useMatches();
  const queryClient = useQueryClient();

  const crumbs: Crumb[] = [];
  for (const match of matches) {
    const crumb = match.staticData.crumb;
    if (!crumb) continue;
    const params = match.params as Record<string, string>;
    if (crumb === "$project") {
      const project = me.projects.find((p) => p.projectId === params.projectId);
      crumbs.push({ label: project?.name ?? "…", to: "/projects/$projectId", params });
    } else if (crumb === "$run") {
      const run = params.runId ? queryClient.getQueryData<Run>(["run", params.runId]) : undefined;
      crumbs.push({ label: t("nav.tasks"), to: "/projects/$projectId/tasks", params });
      crumbs.push({ label: run ? `#${run.number}` : (params.runId?.slice(0, 8) ?? "…") });
    } else {
      crumbs.push({ label: t(crumb), to: match.fullPath, params });
    }
  }
  return crumbs;
}

export function Topbar() {
  const crumbs = useCrumbs();

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SidebarTrigger className="-ml-1" />
      {crumbs.length > 0 ? (
        <>
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                  <Fragment key={`${crumb.to ?? "page"}:${crumb.label}`}>
                    {index > 0 ? <BreadcrumbSeparator /> : null}
                    <BreadcrumbItem>
                      {last || !crumb.to ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link to={crumb.to} params={crumb.params}>
                            {crumb.label}
                          </Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <UserMenu />
      </div>
    </header>
  );
}
