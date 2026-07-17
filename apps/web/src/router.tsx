import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AdminPage } from "./pages/AdminPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
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
});

const adminRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin",
  component: AdminPage,
});

const templateEditorRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin/templates/$templateId",
  component: TemplateEditorPage,
});

const projectRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/projects/$projectId",
  component: ProjectLayout,
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
});

const submitRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/submit/$taskTypeId",
  component: SubmitTaskPage,
});

const tasksRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/tasks",
  component: TasksPage,
});

const runRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/runs/$runId",
  component: RunDetailPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    homeRoute,
    approvalsRoute,
    adminRoute,
    templateEditorRoute,
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
}
