import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMe } from "../features/me";

const tabs = [
  { to: "/projects/$projectId", key: "nav.dashboard", exact: true },
  { to: "/projects/$projectId/catalog", key: "nav.catalog" },
  { to: "/projects/$projectId/tasks", key: "nav.tasks" },
] as const;

export function ProjectLayout() {
  const { t } = useTranslation("common");
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const me = useMe();
  const membership = me.projects.find((p) => p.projectId === projectId);

  return (
    <div>
      <div className="mb-6 flex items-center gap-4 border-b pb-2">
        <h1 className="text-lg font-semibold">{membership?.name ?? "…"}</h1>
        <nav className="flex gap-1 text-sm">
          {tabs.map((tab) => (
            <Link
              key={tab.key}
              to={tab.to}
              params={{ projectId }}
              activeOptions={{ exact: "exact" in tab && tab.exact }}
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted [&.active]:bg-muted [&.active]:text-foreground"
            >
              {t(tab.key)}
            </Link>
          ))}
          {membership?.role === "admin" && (
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId }}
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted [&.active]:bg-muted [&.active]:text-foreground"
            >
              {t("nav.settings")}
            </Link>
          )}
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
