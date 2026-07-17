import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AdminPage } from "./pages/AdminPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { CatalogPage } from "./pages/CatalogPage";
import { DashboardPage } from "./pages/DashboardPage";
import { HomeRedirect } from "./pages/HomeRedirect";
import { LoginPage } from "./pages/LoginPage";
import { ProjectLayout } from "./pages/ProjectLayout";
import { RunDetailPage } from "./pages/RunDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Shell } from "./pages/Shell";
import { SubmitTaskPage } from "./pages/SubmitTaskPage";
import { TasksPage } from "./pages/TasksPage";
import { TemplateEditorPage } from "./pages/TemplateEditorPage";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
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
  component: AdminPage,
});

const templateEditorRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/templates/$templateId",
  component: TemplateEditorPage,
  staticData: { crumb: "nav.templates" },
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

const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  component: SettingsPage,
  staticData: { crumb: "nav.settings" },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    homeRoute,
    approvalsRoute,
    adminRoute.addChildren([adminIndexRoute, templateEditorRoute]),
    projectRoute.addChildren([
      dashboardRoute,
      catalogRoute,
      submitRoute,
      tasksRoute,
      runRoute,
      settingsRoute,
    ]),
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Breadcrumb label: a common-namespace i18n key, or "$project" / "$run" for dynamic labels. */
    crumb?: string;
  }
}
