import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { CatalogPage } from "./pages/CatalogPage";
import { DashboardPage } from "./pages/DashboardPage";
import { HomeRedirect } from "./pages/HomeRedirect";
import { LoginPage } from "./pages/LoginPage";
import { ProjectLayout } from "./pages/ProjectLayout";
import { RunDetailPage } from "./pages/RunDetailPage";
import { Shell } from "./pages/Shell";
import { SubmitTaskPage } from "./pages/SubmitTaskPage";
import { TasksPage } from "./pages/TasksPage";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const acceptInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accept-invite",
  component: AcceptInvitePage,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: Shell,
});

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: HomeRedirect,
});

const approvalsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/approvals",
  component: ApprovalsPage,
  staticData: { crumb: "nav.approvals" },
});

const adminRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin",
  component: AdminLayout,
  staticData: { crumb: "nav.admin" },
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/admin/templates" });
  },
});

const adminTemplatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/templates",
  component: lazyRouteComponent(
    () => import("./pages/admin/TemplatesListPage"),
    "TemplatesListPage",
  ),
  staticData: { crumb: "nav.templates" },
});

const templateEditorRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/templates/$templateId",
  component: lazyRouteComponent(() => import("./pages/TemplateEditorPage"), "TemplateEditorPage"),
  staticData: { crumb: "nav.templates" },
});

const adminFabriRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/fabri",
  component: lazyRouteComponent(() => import("./pages/admin/FabriPage"), "FabriPage"),
  staticData: { crumb: "nav.fabri" },
});

const adminModelsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/models",
  component: lazyRouteComponent(() => import("./pages/admin/ModelsPage"), "ModelsPage"),
  staticData: { crumb: "nav.models" },
});

const adminSkillsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/skills",
  component: lazyRouteComponent(() => import("./pages/admin/SkillsPage"), "SkillsPage"),
  staticData: { crumb: "nav.skills" },
});

const adminMcpRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/mcp-servers",
  component: lazyRouteComponent(() => import("./pages/admin/McpServersPage"), "McpServersPage"),
  staticData: { crumb: "nav.mcp" },
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/audit",
  component: lazyRouteComponent(() => import("./pages/admin/AuditLogPage"), "AuditLogPage"),
  staticData: { crumb: "nav.audit" },
});

const adminMembersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/members",
  component: lazyRouteComponent(() => import("./pages/admin/InvitationsPage"), "InvitationsPage"),
  staticData: { crumb: "nav.members" },
});

const projectRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/projects/$projectId",
  component: ProjectLayout,
  staticData: { crumb: "$project" },
});

const dashboardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: DashboardPage,
});

const catalogRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/catalog",
  component: CatalogPage,
  staticData: { crumb: "nav.catalog" },
});

const submitRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/submit/$taskTypeId",
  component: SubmitTaskPage,
  staticData: { crumb: "breadcrumb.newTask" },
});

const tasksRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/tasks",
  component: TasksPage,
  staticData: { crumb: "nav.tasks" },
});

const runRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/runs/$runId",
  component: RunDetailPage,
  staticData: { crumb: "$run" },
});

const usageRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/usage",
  component: lazyRouteComponent(() => import("./pages/UsagePage"), "UsagePage"),
  staticData: { crumb: "nav.usage" },
});

const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./pages/SettingsPage"), "SettingsPage"),
  staticData: { crumb: "nav.settings" },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  acceptInviteRoute,
  shellRoute.addChildren([
    homeRoute,
    approvalsRoute,
    adminRoute.addChildren([
      adminIndexRoute,
      adminTemplatesRoute,
      templateEditorRoute,
      adminFabriRoute,
      adminModelsRoute,
      adminSkillsRoute,
      adminMcpRoute,
      adminMembersRoute,
      adminAuditRoute,
    ]),
    projectRoute.addChildren([
      dashboardRoute,
      catalogRoute,
      submitRoute,
      tasksRoute,
      runRoute,
      usageRoute,
      settingsRoute,
    ]),
  ]),
]);

function RoutePending() {
  return (
    <div className="flex justify-center py-16">
      <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

export const router = createRouter({ routeTree, defaultPendingComponent: RoutePending });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Breadcrumb label: a common-namespace i18n key, or "$project" / "$run" for dynamic labels. */
    crumb?: string;
  }
}
