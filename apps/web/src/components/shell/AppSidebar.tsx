import { Link, useMatchRoute } from "@tanstack/react-router";
import { CircleCheckBigIcon, HammerIcon, ShieldIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { projectNav } from "@/components/shell/nav";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { getLastProjectId } from "@/features/lastProject";
import { useMe } from "@/features/me";

export function AppSidebar({ currentProjectId }: { currentProjectId: string | null }) {
  const { t } = useTranslation("common");
  const me = useMe();
  const matchRoute = useMatchRoute();

  // Keep project navigation visible while on org-level pages (approvals, admin)
  // by falling back to the last-visited project, GitLab-context style.
  const membership =
    me.projects.find((p) => p.projectId === currentProjectId) ??
    me.projects.find((p) => p.projectId === getLastProjectId()) ??
    me.projects[0] ??
    null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip={t("appName")}>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <HammerIcon className="size-4" />
                </div>
                <span className="truncate font-semibold">{t("appName")}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ProjectSwitcher current={membership} />
      </SidebarHeader>
      <SidebarContent>
        {membership ? (
          <SidebarGroup>
            <SidebarGroupLabel>{t("nav.project")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {projectNav
                  .filter((item) => !item.projectAdminOnly || membership.role === "admin")
                  .map((item) => (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        asChild
                        tooltip={t(`nav.${item.key}`)}
                        isActive={Boolean(
                          matchRoute({
                            to: item.to,
                            params: { projectId: membership.projectId },
                            fuzzy: !item.exact,
                          }),
                        )}
                      >
                        <Link to={item.to} params={{ projectId: membership.projectId }}>
                          <item.icon />
                          <span>{t(`nav.${item.key}`)}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.organization")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip={t("nav.approvals")}
                  isActive={Boolean(matchRoute({ to: "/approvals" }))}
                >
                  <Link to="/approvals">
                    <CircleCheckBigIcon />
                    <span>{t("nav.approvals")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {me.orgRole === "org_admin" ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip={t("nav.admin")}
                    isActive={Boolean(matchRoute({ to: "/admin", fuzzy: true }))}
                  >
                    <Link to="/admin">
                      <ShieldIcon />
                      <span>{t("nav.admin")}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
