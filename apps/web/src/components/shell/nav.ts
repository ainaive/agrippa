import {
  BarChart3Icon,
  LayoutDashboardIcon,
  ListChecksIcon,
  type LucideIcon,
  SettingsIcon,
  ShapesIcon,
} from "lucide-react";

export type ProjectNavItem = {
  key: string; // i18n key under common:nav
  icon: LucideIcon;
  to: string;
  exact?: boolean;
  projectAdminOnly?: boolean;
};

export const projectNav: ProjectNavItem[] = [
  { key: "dashboard", icon: LayoutDashboardIcon, to: "/projects/$projectId", exact: true },
  { key: "catalog", icon: ShapesIcon, to: "/projects/$projectId/catalog" },
  { key: "tasks", icon: ListChecksIcon, to: "/projects/$projectId/tasks" },
  { key: "usage", icon: BarChart3Icon, to: "/projects/$projectId/usage" },
  {
    key: "settings",
    icon: SettingsIcon,
    to: "/projects/$projectId/settings",
    projectAdminOnly: true,
  },
];
